import AppKit
import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers
@preconcurrency import WebKit

/// Hosts generated compositions separately from the application UI. Render views
/// deliberately have no script-message handlers or access to the native bridge.
@MainActor
final class OriginalPageRenderer {
    private let allowedRoots: [URL]
    private let allowRemoteFonts: Bool
    private var pages: [String: OriginalRenderPage] = [:]
    private var rules: WKContentRuleList?
    private var generation = 0

    init(allowedRoots: [URL], allowRemoteFonts: Bool = true) {
        self.allowedRoots = allowedRoots.map { $0.standardizedFileURL.resolvingSymlinksInPath() }
            .filter { $0.isFileURL && $0.path != "/" }
        self.allowRemoteFonts = allowRemoteFonts
    }

    func handle(method: String, params: [String: JSONValue]) async throws -> JSONValue {
        if method != "render.close" { try Task.checkCancellation() }
        switch method {
        case "render.open":
            guard pages.count < 6 else { throw RenderFailure("At most six render pages may be open.") }
            let file = try allowedFile(try string("path", in: params))
            guard ["html", "htm"].contains(file.pathExtension.lowercased()) else {
                throw RenderFailure("A render page must be an HTML file.")
            }
            let width = try dimension("W", in: params)
            let height = try dimension("H", in: params)
            let directory = file.deletingLastPathComponent()
            try validateLocalLinks(in: directory)
            let startGeneration = generation
            let ruleList = try await contentRules()
            try Task.checkCancellation()
            guard generation == startGeneration else { throw CancellationError() }
            guard pages.count < 6 else { throw RenderFailure("At most six render pages may be open.") }
            let id = UUID().uuidString
            let page = OriginalRenderPage(file: file, width: width, height: height, rules: ruleList)
            pages[id] = page
            do {
                try await page.load()
                let ready = try await page.expression("Promise.resolve(window.MK_READY).then(Boolean)", timeout: 45)
                let errors = try await page.expression("window.MK ? MK.errors() : (window.MK_ERRORS || ['Motion kit did not initialize.'])")
                return .object(["pageId": .string(id), "ready": ready, "errors": errors])
            } catch {
                pages.removeValue(forKey: id)?.close()
                throw error
            }

        case "render.eval", "render.capture":
            let id = try string("pageId", in: params)
            guard let page = pages[id] else { throw RenderFailure("The render page is closed or unknown.") }
            guard !page.busy else { throw RenderFailure("The render page already has an operation in progress.") }
            page.busy = true
            defer { page.busy = false }
            if method == "render.eval" {
                let code = try string("code", in: params)
                guard code.utf8.count <= 1_048_576 else { throw RenderFailure("Render expression exceeds 1 MB.") }
                return try await page.expression(code)
            }
            guard let time = params["time"]?.doubleValue, time.isFinite else {
                throw RenderFailure("A frame time must be finite.")
            }
            let format = params["format"]?.stringValue ?? "png"
            guard ["png", "jpeg"].contains(format) else { throw RenderFailure("Frame format must be png or jpeg.") }
            let image = try await page.capture(at: time)
            return .object(["data": .string(try Self.encode(image, jpeg: format == "jpeg", quality: 0.96).base64EncodedString())])

        case "render.close":
            let id = try string("pageId", in: params)
            pages.removeValue(forKey: id)?.close()
            return .object([:])

        case "image.spread":
            let encoded = try string("data", in: params)
            guard encoded.utf8.count <= 90_000_000, let data = Data(base64Encoded: encoded) else {
                throw RenderFailure("Invalid or oversized image data.")
            }
            let source = try Self.imageSource(data)
            guard let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else { throw RenderFailure("Image decoding failed.") }
            return .object(["spread": .number(try Self.spread(image))])

        case "image.loadForModel":
            let file = try allowedFile(try string("path", in: params))
            let source = try Self.imageSource(Data(contentsOf: file, options: .mappedIfSafe))
            let options: [CFString: Any] = [
                kCGImageSourceCreateThumbnailFromImageAlways: true,
                kCGImageSourceCreateThumbnailWithTransform: true,
                kCGImageSourceThumbnailMaxPixelSize: 1568,
                kCGImageSourceShouldCacheImmediately: true
            ]
            guard let image = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary) else {
                throw RenderFailure("Image thumbnail decoding failed.")
            }
            return .object([
                "mediaType": .string("image/jpeg"),
                "data": .string(try Self.encode(image, jpeg: true, quality: 0.88).base64EncodedString())
            ])

        default:
            throw RenderFailure("Unsupported renderer operation: \(method)")
        }
    }

    func closeAll() {
        generation += 1
        let active = Array(pages.values)
        pages.removeAll()
        for page in active { page.close() }
    }

    private func string(_ key: String, in params: [String: JSONValue]) throws -> String {
        guard let value = params[key]?.stringValue, !value.isEmpty else { throw RenderFailure("Missing string parameter: \(key)") }
        return value
    }

    private func dimension(_ key: String, in params: [String: JSONValue]) throws -> Int {
        guard let value = params[key]?.doubleValue, value.isFinite,
              value.rounded(.towardZero) == value, (1...4096).contains(value) else {
            throw RenderFailure("Render dimensions must be integers from 1 through 4096.")
        }
        return Int(value)
    }

    private func allowedFile(_ path: String) throws -> URL {
        guard path.hasPrefix("/"), !path.contains("\0") else { throw RenderFailure("An absolute local file path is required.") }
        let file = URL(fileURLWithPath: path).standardizedFileURL.resolvingSymlinksInPath()
        guard allowedRoots.contains(where: { Self.contains(file, in: $0) }) else {
            throw RenderFailure("The file is outside the permitted render roots.")
        }
        let values = try file.resourceValues(forKeys: [.isRegularFileKey, .fileSizeKey])
        guard values.isRegularFile == true, let bytes = values.fileSize, bytes <= 64 * 1024 * 1024 else {
            throw RenderFailure("The source must be a regular file no larger than 64 MB.")
        }
        return file
    }

    private static func contains(_ file: URL, in root: URL) -> Bool {
        file.path == root.path || file.path.hasPrefix(root.path + "/")
    }

    /// WebKit receives only this composition directory as its file-read scope.
    /// Reject links that would grant access beyond that scope before loading it.
    private func validateLocalLinks(in directory: URL) throws {
        guard let files = FileManager.default.enumerator(at: directory, includingPropertiesForKeys: [.isSymbolicLinkKey]) else {
            throw RenderFailure("The composition directory cannot be inspected.")
        }
        var count = 0
        for case let file as URL in files {
            count += 1
            guard count <= 10_000 else { throw RenderFailure("The composition directory contains too many files.") }
            if try file.resourceValues(forKeys: [.isSymbolicLinkKey]).isSymbolicLink == true,
               !Self.contains(file.resolvingSymlinksInPath(), in: directory) {
                throw RenderFailure("A composition resource links outside its own directory.")
            }
        }
    }

    private func contentRules() async throws -> WKContentRuleList {
        if let rules { return rules }
        var items: [[String: Any]] = [
            ["trigger": ["url-filter": ".*"], "action": ["type": "block"]],
            ["trigger": ["url-filter": "^file:"], "action": ["type": "ignore-previous-rules"]],
            ["trigger": ["url-filter": "^data:"], "action": ["type": "ignore-previous-rules"]],
            ["trigger": ["url-filter": "^blob:"], "action": ["type": "ignore-previous-rules"]]
        ]
        if allowRemoteFonts {
            items += [
                ["trigger": ["url-filter": "^https://fonts\\.googleapis\\.com/", "resource-type": ["style-sheet"]], "action": ["type": "ignore-previous-rules"]],
                ["trigger": ["url-filter": "^https://fonts\\.gstatic\\.com/", "resource-type": ["font"]], "action": ["type": "ignore-previous-rules"]]
            ]
        }
        let text = String(decoding: try JSONSerialization.data(withJSONObject: items), as: UTF8.self)
        let value: WKContentRuleList = try await withCheckedThrowingContinuation { continuation in
            WKContentRuleListStore.default().compileContentRuleList(
                forIdentifier: "MotionBoardOriginal-render-\(allowRemoteFonts ? "fonts" : "offline")-v1",
                encodedContentRuleList: text
            ) { list, error in
                if let list { continuation.resume(returning: list) }
                else { continuation.resume(throwing: error ?? RenderFailure("Could not install renderer network restrictions.")) }
            }
        }
        rules = value
        return value
    }

    fileprivate static func imageSource(_ data: Data) throws -> CGImageSource {
        guard data.count <= 64 * 1024 * 1024,
              let source = CGImageSourceCreateWithData(data as CFData, [kCGImageSourceShouldCache: false] as CFDictionary),
              let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
              let width = properties[kCGImagePropertyPixelWidth] as? NSNumber,
              let height = properties[kCGImagePropertyPixelHeight] as? NSNumber,
              width.doubleValue > 0, height.doubleValue > 0,
              width.doubleValue * height.doubleValue <= 67_108_864 else {
            throw RenderFailure("The image is invalid or exceeds the decoding limit.")
        }
        return source
    }

    fileprivate static func resized(_ image: CGImage, width: Int, height: Int) throws -> CGImage {
        guard let space = CGColorSpace(name: CGColorSpace.sRGB),
              let context = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8,
                                      bytesPerRow: width * 4, space: space,
                                      bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue | CGBitmapInfo.byteOrder32Big.rawValue) else {
            throw RenderFailure("Could not allocate an image conversion buffer.")
        }
        context.interpolationQuality = .high
        context.setFillColor(CGColor(gray: 0, alpha: 1))
        context.fill(CGRect(x: 0, y: 0, width: width, height: height))
        context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
        guard let result = context.makeImage() else { throw RenderFailure("Image conversion failed.") }
        return result
    }

    fileprivate static func encode(_ image: CGImage, jpeg: Bool, quality: Double) throws -> Data {
        let output = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(output, (jpeg ? UTType.jpeg.identifier : UTType.png.identifier) as CFString, 1, nil) else {
            throw RenderFailure("Could not create the image encoder.")
        }
        let properties: [CFString: Any] = jpeg ? [kCGImageDestinationLossyCompressionQuality: quality] : [:]
        CGImageDestinationAddImage(destination, image, properties as CFDictionary)
        guard CGImageDestinationFinalize(destination) else { throw RenderFailure("Image encoding failed.") }
        return output as Data
    }

    fileprivate static func spread(_ image: CGImage) throws -> Double {
        // Match the original renderer's approximately 40,000 pixel luminance
        // sample without resizing away thin text or high-frequency detail.
        let width = image.width, height = image.height
        let sampled = try resized(image, width: width, height: height)
        guard let bytes = sampled.dataProvider?.data,
              let base = CFDataGetBytePtr(bytes) else { throw RenderFailure("Could not inspect frame pixels.") }
        var sum = 0.0, squared = 0.0, count = 0.0
        let step = max(1, width * height / 40_000)
        for pixel in stride(from: 0, to: width * height, by: step) {
            let offset = (pixel / width) * sampled.bytesPerRow + (pixel % width) * 4
            let luminance = 0.2126 * Double(base[offset]) + 0.7152 * Double(base[offset + 1]) + 0.0722 * Double(base[offset + 2])
            sum += luminance
            squared += luminance * luminance
            count += 1
        }
        let mean = sum / count
        return sqrt(max(0, squared / count - mean * mean))
    }
}

private struct RenderFailure: LocalizedError, Sendable {
    let message: String
    init(_ message: String) { self.message = message }
    var errorDescription: String? { message }
}

@MainActor
private final class OriginalRenderWindow: NSWindow {
    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }
    override func constrainFrameRect(_ frameRect: NSRect, to screen: NSScreen?) -> NSRect { frameRect }
}

@MainActor
private final class OriginalRenderPage: NSObject, WKNavigationDelegate, WKUIDelegate {
    let webView: WKWebView
    let window: NSWindow
    let file: URL
    let width: Int
    let height: Int
    var busy = false
    private var loaded = false
    private var closed = false
    private var failure: Error?
    private var initialNavigationAllowed = false
    private var triedVisibleFallback = false
    private var cancellations: [UUID: () -> Void] = [:]

    init(file: URL, width: Int, height: Int, rules: WKContentRuleList) {
        self.file = file
        self.width = width
        self.height = height
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        configuration.preferences.javaScriptCanOpenWindowsAutomatically = false
        configuration.mediaTypesRequiringUserActionForPlayback = .all
        configuration.allowsAirPlayForMediaPlayback = false
        configuration.userContentController.add(rules)
        // The public geolocation delegate exists only on macOS 27+. Prevent
        // older WebKit versions from presenting location requests as well.
        configuration.userContentController.addUserScript(WKUserScript(source: """
        (() => {
          const deny = (_, failure) => { if (typeof failure === 'function') failure({code:1,message:'Location access is disabled in render pages.'}); return 0; };
          try { Object.defineProperty(navigator, 'geolocation', {value:Object.freeze({getCurrentPosition:deny,watchPosition:deny,clearWatch:()=>{}}),configurable:false}); } catch (_) {}
        })();
        """, injectionTime: .atDocumentStart, forMainFrameOnly: false))
        let rect = NSRect(x: 0, y: 0, width: width, height: height)
        webView = WKWebView(frame: rect, configuration: configuration)
        window = OriginalRenderWindow(contentRect: rect, styleMask: [.borderless], backing: .buffered, defer: false)
        super.init()
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.autoresizingMask = [.width, .height]
        window.contentView = webView
        window.isReleasedWhenClosed = false
        window.isExcludedFromWindowsMenu = true
        window.ignoresMouseEvents = true
        window.hidesOnDeactivate = false
        window.collectionBehavior = [.transient, .ignoresCycle]
        window.backgroundColor = .black
        let screenEdge = NSScreen.screens.map(\.frame.maxX).max() ?? 2000
        window.setFrameOrigin(NSPoint(x: screenEdge + 100, y: 0))
        window.orderBack(nil)
    }

    func load() async throws {
        webView.loadFileURL(file, allowingReadAccessTo: file.deletingLastPathComponent())
        let deadline = ContinuousClock.now + .seconds(60)
        while !loaded {
            try Task.checkCancellation()
            guard !closed else { throw CancellationError() }
            if let failure { throw failure }
            guard ContinuousClock.now < deadline else { throw RenderFailure("Loading the composition exceeded 60 seconds.") }
            try await Task.sleep(for: .milliseconds(20))
        }
    }

    /// Original renderer call sites pass expressions, including an IIFE for
    /// multi-statement probes. Awaiting here preserves Promise results without
    /// enabling eval() in the composition's Content Security Policy.
    func expression(_ source: String, timeout: Double = 30) async throws -> JSONValue {
        guard !closed else { throw CancellationError() }
        let expression = source.trimmingCharacters(in: .whitespacesAndNewlines)
            .replacingOccurrences(of: ";+$", with: "", options: .regularExpression)
        let body = "const result = await (\(expression)\n); return JSON.stringify(result === undefined ? null : result);"
        let id = UUID()
        let reply = OriginalRenderReply<String?>(timeout: timeout)
        cancellations[id] = { reply.finish(.failure(CancellationError())) }
        defer { cancellations.removeValue(forKey: id) }
        let encoded = try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
                reply.start(continuation)
                webView.callAsyncJavaScript(body, arguments: [:], in: nil, in: .page) { result in
                    switch result {
                    case .success(let value): reply.finish(.success(value as? String))
                    case .failure(let error): reply.finish(.failure(error))
                    }
                }
            }
        } onCancel: {
            Task { @MainActor in reply.finish(.failure(CancellationError())) }
        }
        guard let encoded else { return .null }
        return try JSONDecoder().decode(JSONValue.self, from: Data(encoded.utf8))
    }

    func capture(at time: Double) async throws -> CGImage {
        let result = try await expression("window.MK && MK.seek(\(time))")
        guard result.boolValue == true else { throw RenderFailure("MK.seek did not render the requested frame.") }
        var image = try await snapshot()
        if !triedVisibleFallback {
            triedVisibleFallback = true
            if try OriginalPageRenderer.spread(image) < 0.01, let screen = NSScreen.main {
                // Some WindowServer sessions do not paint an offscreen view.
                // Retry behind the app at a real screen position, never key/front.
                let previousOrigin = window.frame.origin
                window.setFrameOrigin(screen.visibleFrame.origin)
                window.orderBack(nil)
                defer { window.setFrameOrigin(previousOrigin) }
                try await Task.sleep(for: .milliseconds(50))
                image = try await snapshot()
            }
        }
        return image
    }

    private func snapshot() async throws -> CGImage {
        guard !closed else { throw CancellationError() }
        try Task.checkCancellation()
        webView.layoutSubtreeIfNeeded()
        let options = WKSnapshotConfiguration()
        options.rect = CGRect(x: 0, y: 0, width: width, height: height)
        options.snapshotWidth = NSNumber(value: Double(width) / max(1, window.backingScaleFactor))
        options.afterScreenUpdates = true
        let id = UUID()
        let reply = OriginalRenderReply<CGImage>(timeout: 30)
        cancellations[id] = { reply.finish(.failure(CancellationError())) }
        defer { cancellations.removeValue(forKey: id) }
        return try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
                reply.start(continuation)
                webView.takeSnapshot(with: options) { image, error in
                    if let error { reply.finish(.failure(error)); return }
                    guard let image, let cg = image.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
                        reply.finish(.failure(RenderFailure("WebKit did not return a DOM snapshot."))); return
                    }
                    do {
                        let exact = try OriginalPageRenderer.resized(cg, width: self.width, height: self.height)
                        reply.finish(.success(exact))
                    } catch { reply.finish(.failure(error)) }
                }
            }
        } onCancel: {
            Task { @MainActor in reply.finish(.failure(CancellationError())) }
        }
    }

    func close() {
        guard !closed else { return }
        closed = true
        let pending = Array(cancellations.values)
        cancellations.removeAll()
        for cancel in pending { cancel() }
        webView.stopLoading()
        webView.navigationDelegate = nil
        webView.uiDelegate = nil
        window.orderOut(nil)
        window.close()
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { loaded = true }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { failure = error }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { failure = error }
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        failure = RenderFailure("The WebKit render process terminated.")
        close()
    }
    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction) async -> WKNavigationActionPolicy {
        guard !initialNavigationAllowed, action.targetFrame?.isMainFrame == true,
              let url = action.request.url, url.isFileURL,
              url.standardizedFileURL.resolvingSymlinksInPath() == file else { return .cancel }
        initialNavigationAllowed = true
        return .allow
    }
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? { nil }
    func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping @MainActor @Sendable ([URL]?) -> Void) { completionHandler(nil) }
    func webView(_ webView: WKWebView, decideMediaCapturePermissionsFor origin: WKSecurityOrigin,
                 initiatedBy frame: WKFrameInfo, type: WKMediaCaptureType) async -> WKPermissionDecision { .deny }
    @available(macOS 27.0, *)
    func webView(_ webView: WKWebView, requestGeolocationPermissionFor origin: WKSecurityOrigin,
                 initiatedBy frame: WKFrameInfo) async -> WKPermissionDecision { .deny }
}

@MainActor
private final class OriginalRenderReply<Value: Sendable> {
    private var continuation: CheckedContinuation<Value, Error>?
    private var result: Result<Value, Error>?
    private var timer: Task<Void, Never>?
    private let timeout: Double

    init(timeout: Double) { self.timeout = timeout }

    func start(_ continuation: CheckedContinuation<Value, Error>) {
        if let result { continuation.resume(with: result); return }
        self.continuation = continuation
        timer = Task { @MainActor [weak self] in
            guard let timeout = self?.timeout else { return }
            do { try await Task.sleep(for: .seconds(timeout)) }
            catch { return }
            self?.finish(.failure(RenderFailure("WebKit render operation exceeded \(Int(timeout)) seconds.")))
        }
    }

    func finish(_ result: Result<Value, Error>) {
        guard self.result == nil else { return }
        self.result = result
        timer?.cancel()
        timer = nil
        continuation?.resume(with: result)
        continuation = nil
    }
}
