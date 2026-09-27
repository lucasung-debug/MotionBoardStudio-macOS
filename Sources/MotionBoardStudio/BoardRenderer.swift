import AppKit
import Foundation
import MotionBoardCore
import SwiftUI
@preconcurrency import WebKit

@MainActor
final class BoardRenderer: NSObject, ObservableObject, WKNavigationDelegate {
    let webView: WKWebView
    @Published private(set) var ready = false
    private var loadError: Error?
    private var loaded = false

    override init() {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        configuration.preferences.javaScriptCanOpenWindowsAutomatically = false
        webView = WKWebView(frame: NSRect(x: 0, y: 0, width: 1280, height: 720), configuration: configuration)
        super.init()
        webView.navigationDelegate = self
        webView.setValue(false, forKey: "drawsBackground")
    }

    func load() async throws {
        if ready { return }
        if !loaded {
            loaded = true
            webView.loadHTMLString(try BoardDocument.html(), baseURL: nil)
        }
        let deadline = ContinuousClock.now + .seconds(20)
        while !ready {
            try Task.checkCancellation()
            if let loadError { throw loadError }
            guard ContinuousClock.now < deadline else { throw StudioError.message("The local WebKit renderer did not become ready.") }
            try await Task.sleep(for: .milliseconds(20))
        }
    }

    func configure(_ project: MotionProject, longEdge: Int = 1280) async throws {
        let project = try project.validated()
        try await load()
        let size = project.aspectRatio.size(longEdge: longEdge)
        let json = try BoardDocument.javascriptJSON(project)
        _ = try await evaluate("window.MotionBoard.configure(\(json), \(size.width), \(size.height))")
    }

    func seek(_ seconds: Double) async throws {
        guard seconds.isFinite else { throw StudioError.message("Timeline position must be finite.") }
        _ = try await evaluate("window.MotionBoard.seek(\(seconds))")
    }

    func png(at seconds: Double) async throws -> Data {
        guard seconds.isFinite else { throw StudioError.message("Frame time must be finite.") }
        guard let value = try await evaluate("window.MotionBoard.png(\(seconds))"),
              value.hasPrefix("data:image/png;base64,"),
              let data = Data(base64Encoded: String(value.dropFirst("data:image/png;base64,".count))) else {
            throw StudioError.message("The renderer did not return a PNG frame.")
        }
        return data
    }

    private func evaluate(_ script: String) async throws -> String? {
        try Task.checkCancellation()
        return try await withCheckedThrowingContinuation { continuation in
            webView.evaluateJavaScript(script) { value, error in
                if let error { continuation.resume(throwing: error) }
                else { continuation.resume(returning: value as? String) }
            }
        }
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        webView.evaluateJavaScript("Boolean(window.MotionBoard && window.MotionBoard.ready)") { [weak self] value, error in
            guard let self else { return }
            if let error { self.loadError = error }
            else if (value as? Bool) == true { self.ready = true }
            else { self.loadError = StudioError.message("The bundled motion runtime did not initialize.") }
        }
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { loadError = error }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { loadError = error }

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction) async -> WKNavigationActionPolicy {
        let scheme = navigationAction.request.url?.scheme
        return scheme == "about" || navigationAction.request.url == nil ? .allow : .cancel
    }
}

struct BoardPreview: NSViewRepresentable {
    let renderer: BoardRenderer
    func makeNSView(context: Context) -> WKWebView { renderer.webView }
    func updateNSView(_ nsView: WKWebView, context: Context) {}
}
