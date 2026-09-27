import AppKit
import UniformTypeIdentifiers

@MainActor
final class NativeActions {
    let userData: URL
    let renderer: OriginalPageRenderer
    private let verification: Bool
    private let vault = StudioVault()
    private var testVault: [String: String] = [:]
    private var selectedURLs: [URL] = []

    init(userData: URL, verification: Bool = false) {
        self.userData = userData; self.verification = verification
        renderer = OriginalPageRenderer(allowedRoots: [userData, StudioPaths.sourceRoot, StudioPaths.runtimeRoot], allowRemoteFonts: !verification)
    }

    func handle(method: String, params: [String: JSONValue]) async throws -> JSONValue {
        if method == "image.loadForModel", let path = params["path"]?.stringValue,
           selectedURLs.contains(where: { $0.standardizedFileURL.resolvingSymlinksInPath() == URL(fileURLWithPath: path).standardizedFileURL.resolvingSymlinksInPath() }) {
            // A picked image grants access to that file alone, without expanding
            // the file scope of generated composition pages.
            let imageReader = OriginalPageRenderer(allowedRoots: [URL(fileURLWithPath: path)], allowRemoteFonts: false)
            return try await imageReader.handle(method: method, params: params)
        }
        if method.hasPrefix("render.") || method.hasPrefix("image.") {
            return try await renderer.handle(method: method, params: params)
        }
        if method.hasPrefix("vault.") {
            guard let account = params["account"]?.stringValue, ["chatgpt", "claude", "grok-video", "kling-video"].contains(account) else { throw StudioError("잘못된 계정 종류입니다.") }
            switch method {
            case "vault.read":
                let value = verification ? testVault[account] : try vault.read(account)
                return .object(["value": value.map(JSONValue.string) ?? .null])
            case "vault.write":
                guard let value = params["value"]?.stringValue else { throw StudioError("계정 정보가 없습니다.") }
                if verification { testVault[account] = value } else { try vault.write(account, value: value) }
            case "vault.delete":
                if verification { testVault.removeValue(forKey: account) } else { try vault.delete(account) }
            default: throw StudioError("허용되지 않은 보안 저장 요청입니다.")
            }
            return .object([:])
        }
        if method.hasPrefix("videoCredentials.") {
            guard let provider = params["provider"]?.stringValue, ["grok", "kling"].contains(provider) else {
                throw StudioError("지원하지 않는 영상 서비스입니다.")
            }
            let account = provider + "-video"
            if method == "videoCredentials.status" {
                let existing = verification ? testVault[account] : try vault.read(account)
                return .object(["configured": .bool(existing?.isEmpty == false)])
            }
            guard method == "videoCredentials.configure", !verification else {
                throw StudioError("자동 검증에서는 실제 영상 서비스 계정을 설정하지 않습니다.")
            }
            return try configureVideoCredentials(provider: provider)
        }
        guard !verification else { throw StudioError("자동 검증에서는 외부 앱과 파일 대화상자를 열지 않습니다.") }
        let options = params["options"]?.objectValue ?? [:]
        switch method {
        case "shell.openExternal":
            guard let value = params["url"]?.stringValue, let url = URL(string: value),
                  ["https", "http"].contains(url.scheme?.lowercased() ?? ""), url.user == nil, url.password == nil else {
                throw StudioError("허용되지 않은 웹 주소입니다.")
            }
            guard NSWorkspace.shared.open(url) else { throw StudioError("브라우저를 열지 못했습니다.") }
        case "shell.openPath", "shell.reveal":
            guard let value = params["path"]?.stringValue else { throw StudioError("파일 경로가 없습니다.") }
            let url = URL(fileURLWithPath: value)
            guard StudioPaths.isInside(url, roots: [userData, StudioPaths.sourceRoot] + selectedURLs) else { throw StudioError("앱에 연결되지 않은 파일 경로입니다.") }
            if method == "shell.reveal" { NSWorkspace.shared.activateFileViewerSelecting([url]) }
            else if !NSWorkspace.shared.open(url) { throw StudioError("폴더를 열지 못했습니다.") }
        case "dialog.open":
            let panel = NSOpenPanel()
            panel.title = options["title"]?.stringValue ?? "파일 선택"
            panel.canChooseDirectories = options["properties"]?.arrayValue?.contains(.string("openDirectory")) == true
            panel.canChooseFiles = !panel.canChooseDirectories
            panel.allowsMultipleSelection = false
            let types = contentTypes(options)
            if !types.isEmpty { panel.allowedContentTypes = types }
            let response = await panel.begin()
            let urls = response == .OK ? panel.urls : []
            registerSelectedFiles(urls)
            return .object(["canceled": .bool(response != .OK), "filePaths": .array(urls.map { .string($0.path) })])
        case "dialog.save":
            let panel = NSSavePanel()
            panel.title = options["title"]?.stringValue ?? "파일 저장"
            if let value = options["defaultPath"]?.stringValue {
                let url = URL(fileURLWithPath: value)
                panel.nameFieldStringValue = url.lastPathComponent
                panel.directoryURL = url.deletingLastPathComponent()
            }
            let types = contentTypes(options)
            if !types.isEmpty { panel.allowedContentTypes = types }
            let response = await panel.begin()
            if response == .OK, let url = panel.url { registerSelectedFiles([url]) }
            return .object(["canceled": .bool(response != .OK), "filePath": response == .OK ? panel.url.map { .string($0.path) } ?? .null : .null])
        case "dialog.message":
            let alert = NSAlert()
            alert.messageText = options["message"]?.stringValue ?? "모션보드 스튜디오"
            alert.informativeText = options["detail"]?.stringValue ?? ""
            for title in options["buttons"]?.arrayValue ?? [.string("확인")] { alert.addButton(withTitle: title.stringValue ?? "확인") }
            if let value = options["defaultId"]?.doubleValue {
                for (index, button) in alert.buttons.enumerated() { button.keyEquivalent = index == Int(value) ? "\r" : "" }
                if alert.buttons.indices.contains(Int(value)) { alert.window.defaultButtonCell = alert.buttons[Int(value)].cell as? NSButtonCell }
            }
            if let value = options["cancelId"]?.doubleValue, alert.buttons.indices.contains(Int(value)) {
                alert.buttons[Int(value)].keyEquivalent = "\u{1b}"
            }
            let response = alert.runModal().rawValue - NSApplication.ModalResponse.alertFirstButtonReturn.rawValue
            return .object(["response": .number(Double(response))])
        default: throw StudioError("지원하지 않는 Mac 서비스 요청입니다: \(method)")
        }
        return .object([:])
    }

    func registerSelectedFiles(_ urls: [URL]) {
        selectedURLs.append(contentsOf: urls.map { $0.standardizedFileURL.resolvingSymlinksInPath() })
    }

    private func configureVideoCredentials(provider: String) throws -> JSONValue {
        let alert = NSAlert()
        alert.messageText = provider == "grok" ? "Grok 영상 API 연결" : "Kling 영상 API 연결"
        alert.informativeText = provider == "grok"
            ? "xAI API Key를 입력하세요. Grok 웹 구독과 별개로 API 사용 요금이 적용됩니다. 키는 이 앱의 macOS 키체인에 저장합니다."
            : "Kling 개발자 계정의 Access Key와 Secret Key를 입력하세요. 현재 대화의 Kling 로그인과 별개이며, API 사용 요금이 적용됩니다. 키는 이 앱의 macOS 키체인에 저장합니다."
        let names = provider == "grok" ? [("API Key", "apiKey")] : [("Access Key", "accessKey"), ("Secret Key", "secretKey")]
        let stack = NSStackView()
        stack.orientation = .vertical; stack.alignment = .leading; stack.spacing = 8
        var fields: [(String, NSSecureTextField)] = []
        for (label, key) in names {
            stack.addArrangedSubview(NSTextField(labelWithString: label))
            let field = NSSecureTextField()
            field.placeholderString = label
            field.widthAnchor.constraint(equalToConstant: 360).isActive = true
            stack.addArrangedSubview(field); fields.append((key, field))
        }
        stack.frame = NSRect(x: 0, y: 0, width: 360, height: CGFloat(names.count * 58))
        alert.accessoryView = stack
        alert.addButton(withTitle: "저장"); alert.addButton(withTitle: "취소")
        alert.window.initialFirstResponder = fields.first?.1
        guard alert.runModal() == .alertFirstButtonReturn else { return .object(["canceled": .bool(true)]) }
        var values: [String: String] = [:]
        defer { for (_, field) in fields { field.stringValue = "" } }
        for (key, field) in fields {
            let value = field.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !value.isEmpty, value.utf8.count <= 4096, value.rangeOfCharacter(from: .controlCharacters) == nil else {
                throw StudioError("영상 API 키를 빠짐없이 입력해 주세요.")
            }
            values[key] = value
        }
        let encoded = try JSONSerialization.data(withJSONObject: values, options: [.sortedKeys])
        guard let string = String(data: encoded, encoding: .utf8) else { throw StudioError("API 정보를 저장하지 못했습니다.") }
        try vault.write(provider + "-video", value: string)
        return .object(["configured": .bool(true)])
    }

    private func contentTypes(_ options: [String: JSONValue]) -> [UTType] {
        (options["filters"]?.arrayValue ?? []).flatMap { $0["extensions"].arrayValue ?? [] }
            .compactMap { $0.stringValue }.compactMap { UTType(filenameExtension: $0) }
    }
}
