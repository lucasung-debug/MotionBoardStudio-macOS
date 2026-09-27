import AppKit
import SwiftUI
import WebKit

@main
enum OriginalStudioMain {
    @MainActor static func main() {
        if CommandLine.arguments.contains("--verify-original") || CommandLine.arguments.contains("--verify-ui") || CommandLine.arguments.contains("--verify-live") {
            NSApplication.shared.setActivationPolicy(.accessory)
            Task { @MainActor in
                let code: Int32
                if CommandLine.arguments.contains("--verify-live") { code = await OriginalLiveVerification.run(arguments: CommandLine.arguments) }
                else if CommandLine.arguments.contains("--verify-ui") { code = await OriginalVerification.runUI(arguments: CommandLine.arguments) }
                else { code = await OriginalVerification.run(arguments: CommandLine.arguments) }
                fflush(stdout); fflush(stderr); exit(code)
            }
            NSApplication.shared.run()
        } else { OriginalStudioApp.main() }
    }
}

struct OriginalStudioApp: App {
    @NSApplicationDelegateAdaptor(OriginalAppDelegate.self) private var delegate
    @StateObject private var coordinator = StudioCoordinator()
    var body: some Scene {
        WindowGroup("모션보드 스튜디오") {
            ZStack {
                OriginalStudioView(coordinator: coordinator)
                if let failure = coordinator.failure {
                    VStack(spacing: 16) {
                        Text("앱 연결 오류").font(.title2)
                        Text(failure).multilineTextAlignment(.center).textSelection(.enabled)
                        Button("다시 연결") { coordinator.retry() }
                    }.padding(32).frame(maxWidth: 560).background(.regularMaterial, in: RoundedRectangle(cornerRadius: 16))
                } else if !coordinator.ready {
                    ProgressView("모션보드 스튜디오를 여는 중…").padding(28).background(.regularMaterial, in: RoundedRectangle(cornerRadius: 12))
                }
            }
            .frame(minWidth: 1080, minHeight: 720)
            .onAppear { delegate.coordinator = coordinator; coordinator.start(); NSApplication.shared.activate(ignoringOtherApps: true) }
        }
        .defaultSize(width: 1380, height: 900)
        .commands {
            CommandGroup(replacing: .newItem) {
                Button("기록 폴더 열기") { coordinator.invokeMenu("studio:openDataDir") }
            }
            CommandMenu("생성") {
                Button("진행 중인 생성 취소") { coordinator.invokeMenu("studio:cancel") }.disabled(!coordinator.busy)
                Button("화면 새로고침") { coordinator.webView?.reload() }.keyboardShortcut("r")
            }
        }
    }
}

@MainActor
final class OriginalAppDelegate: NSObject, NSApplicationDelegate {
    weak var coordinator: StudioCoordinator?
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        if coordinator?.busy == true {
            let alert = NSAlert()
            alert.messageText = "생성 중인 작업을 취소하고 종료할까요?"
            alert.informativeText = "이미 완성된 결과는 보존됩니다. 현재 작업은 중단됩니다."
            alert.addButton(withTitle: "취소하고 종료"); alert.addButton(withTitle: "계속 작업")
            if alert.runModal() != .alertFirstButtonReturn { return .terminateCancel }
        }
        coordinator?.shutdown()
        return .terminateNow
    }
}

@MainActor
final class StudioCoordinator: NSObject, ObservableObject, WKScriptMessageHandlerWithReply, WKNavigationDelegate, WKUIDelegate {
    @Published var ready = false
    @Published var busy = false
    @Published var failure: String?
    weak var webView: WKWebView?
    let dataRoot: URL
    let actions: NativeActions
    private let verification: Bool
    private var runtime = RuntimeBridge()
    private var starting = false
    private var events: [(String, JSONValue)] = []
    private var loaded = false
    private let rendererRoot = StudioPaths.sourceRoot.appendingPathComponent("renderer", isDirectory: true)
    private let methods: Set<String> = ["env", "guide", "authStatus", "authLogin", "authLogout", "claudeStatus", "claudeLoginStart", "claudeLoginComplete", "claudeLoginCancel", "claudeLogout", "spec", "board", "video", "pickMusic", "installFfmpeg", "videoSaveAs", "videoReveal", "cancel", "history", "historyGet", "historyRemove", "imageSaveAs", "imageImport", "reveal", "openDataDir", "openExternal"]

    init(dataRoot: URL = StudioPaths.userData, verification: Bool = false) {
        self.dataRoot = dataRoot; self.verification = verification
        actions = NativeActions(userData: dataRoot, verification: verification)
        super.init()
    }

    func makeWebView() -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = verification ? .nonPersistent() : .default()
        configuration.preferences.javaScriptCanOpenWindowsAutomatically = false
        let controller = configuration.userContentController
        controller.addScriptMessageHandler(self, contentWorld: .page, name: "studio")
        if let bridge = try? String(contentsOf: StudioPaths.runtimeRoot.appendingPathComponent("studio-bridge.js"), encoding: .utf8) {
            controller.addUserScript(WKUserScript(source: bridge, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        }
        if let adaptation = try? String(contentsOf: StudioPaths.runtimeRoot.appendingPathComponent("macos-ui.js"), encoding: .utf8) {
            controller.addUserScript(WKUserScript(source: adaptation, injectionTime: .atDocumentEnd, forMainFrameOnly: true))
        }
        let assetHandler = StudioAssetHandler(userData: dataRoot)
        configuration.setURLSchemeHandler(assetHandler, forURLScheme: "studio-image")
        configuration.setURLSchemeHandler(assetHandler, forURLScheme: "studio-video")
        let web = WKWebView(frame: .zero, configuration: configuration)
        web.navigationDelegate = self; web.uiDelegate = self
        webView = web
        if ready { loadOriginal() }
        return web
    }

    func start() {
        guard !ready, !starting else { return }
        starting = true; failure = nil
        runtime.nativeCall = { [weak self] method, params in
            guard let self else { throw StudioError("앱이 종료되었습니다.") }
            return try await self.actions.handle(method: method, params: params)
        }
        runtime.onEvent = { [weak self] event, payload in self?.deliver(event, payload: payload) }
        runtime.onFailure = { [weak self] message in self?.failure = message; self?.busy = false }
        Task { @MainActor in
            do { try await runtime.start(userData: dataRoot, verification: verification); ready = true; loadOriginal() }
            catch { failure = error.localizedDescription }
            starting = false
        }
    }
    func retry() { runtime.stop(); runtime = RuntimeBridge(); ready = false; starting = false; loaded = false; start() }
    func shutdown() { runtime.stop(); actions.renderer.closeAll() }
    func invokeMenu(_ method: String) {
        if method == "studio:cancel", let webView {
            webView.evaluateJavaScript("window.studio.cancel(); void 0", completionHandler: nil)
            return
        }
        Task { @MainActor in
            do { _ = try await runtime.invoke(method) }
            catch { failure = error.localizedDescription }
        }
    }
    private func loadOriginal() {
        loaded = false
        webView?.loadFileURL(rendererRoot.appendingPathComponent("index.html"), allowingReadAccessTo: rendererRoot)
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage, replyHandler: @escaping @MainActor @Sendable (Any?, String?) -> Void) {
        guard message.frameInfo.isMainFrame, message.frameInfo.request.url?.standardizedFileURL == rendererRoot.appendingPathComponent("index.html").standardizedFileURL,
              let body = try? JSONValue(any: message.body), let method = body["method"].stringValue,
              method.hasPrefix("studio:"), methods.contains(String(method.dropFirst(7))) else {
            replyHandler(["ok": false, "error": "허용되지 않은 앱 요청입니다."], nil); return
        }
        let isJob = ["studio:spec", "studio:board", "studio:video"].contains(method)
        if isJob { busy = true }
        Task { @MainActor in
            defer { if isJob { busy = false } }
            do { replyHandler(try await runtime.invoke(method, params: body["params"]).foundationValue, nil) }
            catch { replyHandler(["ok": false, "error": error.localizedDescription], nil) }
        }
    }
    private func deliver(_ event: String, payload: JSONValue) {
        guard loaded else { events.append((event, payload)); if events.count > 100 { events.removeFirst() }; return }
        guard let webView, let eventJSON = try? JSONValue.string(event).encodedString(), let payloadJSON = try? payload.encodedString() else { return }
        webView.evaluateJavaScript("window.__studioEvent(\(eventJSON),\(payloadJSON))", completionHandler: nil)
    }
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        loaded = true
        let backlog = events; events.removeAll()
        for (event, payload) in backlog { deliver(event, payload: payload) }
    }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: any Error) { failure = error.localizedDescription }
    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping @MainActor @Sendable (WKNavigationActionPolicy) -> Void) {
        let allowed = navigationAction.request.url?.standardizedFileURL == rendererRoot.appendingPathComponent("index.html").standardizedFileURL
        decisionHandler(allowed ? .allow : .cancel)
    }
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? { nil }
    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping @MainActor @Sendable (Bool) -> Void) {
        let alert = NSAlert(); alert.messageText = message
        alert.addButton(withTitle: "확인"); alert.addButton(withTitle: "취소")
        completionHandler(alert.runModal() == .alertFirstButtonReturn)
    }
}

struct OriginalStudioView: NSViewRepresentable {
    @ObservedObject var coordinator: StudioCoordinator
    func makeNSView(context: Context) -> WKWebView { coordinator.makeWebView() }
    func updateNSView(_ nsView: WKWebView, context: Context) {}
}
