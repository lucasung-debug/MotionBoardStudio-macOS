import AppKit
import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers
@preconcurrency import WebKit

/// Exercises the preserved frontend with the production native bridge. Its
/// coordinator installs only the CLI verification providers and transient data.
@MainActor
enum OriginalUIVerification {
    static func run(dataRoot: URL, output: URL) async throws -> JSONValue {
        let screenshot = output.appendingPathComponent("native-ui.png")
        let receiptFile = output.appendingPathComponent("native-ui-receipt.json")
        guard !FileManager.default.fileExists(atPath: screenshot.path),
              !FileManager.default.fileExists(atPath: receiptFile.path) else {
            throw StudioError("Native UI verification artifacts already exist; choose another output directory.")
        }
        try FileManager.default.createDirectory(at: output, withIntermediateDirectories: true)

        let coordinator = StudioCoordinator(dataRoot: dataRoot, verification: true)
        let web = coordinator.makeWebView()
        let bounds = NSRect(x: 0, y: 0, width: 1380, height: 900)
        let window = OriginalUIVerificationWindow(contentRect: bounds, styleMask: [.titled, .closable, .resizable], backing: .buffered, defer: false)
        window.title = "모션보드 스튜디오 · 로컬 검증"
        window.isReleasedWhenClosed = false
        window.contentView = web
        web.frame = bounds
        web.autoresizingMask = [.width, .height]
        window.center()
        window.makeKeyAndOrderFront(nil)
        NSApplication.shared.activate(ignoringOtherApps: true)
        coordinator.start()
        defer {
            coordinator.shutdown()
            web.stopLoading()
            web.configuration.userContentController.removeScriptMessageHandler(forName: "studio", contentWorld: .page)
            window.orderOut(nil)
            window.close()
        }

        do {
            try await waitFor(web, coordinator: coordinator, label: "original frontend initialization", timeout: 45, expression: """
            document.readyState === 'complete' && typeof envInfo !== 'undefined' && envInfo?.ok === true
              && typeof authState !== 'undefined' && authState.loggedIn === true
              && typeof claudeState !== 'undefined' && claudeState.loggedIn === true
              && document.querySelectorAll('#historyList .history-item').length > 0
              && document.getElementById('ffmpegHint')?.textContent.includes('이 Mac')
            """)

            let bridge = try await javascript(web, body: """
            const expected = ['env','guide','auth.status','auth.login','auth.logout','claude.status','claude.loginStart',
              'claude.loginComplete','claude.loginCancel','claude.logout','spec','board','video','pickMusic','installFfmpeg',
              'videoSaveAs','videoReveal','cancel','history','historyGet','historyRemove','imageSaveAs','imageImport',
              'reveal','openDataDir','openExternal'];
            const flatten = (value, prefix = '') => Object.entries(value).flatMap(([key, item]) => {
              const path = prefix ? `${prefix}.${key}` : key;
              return typeof item === 'function' ? [path] : item && typeof item === 'object' ? flatten(item, path) : [];
            });
            const functions = flatten(window.studio);
            const events = functions.filter(name => /^on[A-Z]/.test(name));
            const calls = functions.filter(name => !events.includes(name));
            if (JSON.stringify(calls.sort()) !== JSON.stringify(expected.sort())) throw new Error('Original 26-method facade mismatch.');
            if (JSON.stringify(events.sort()) !== JSON.stringify(['onAuth','onClaudeAuth','onProgress'])) throw new Error('Original event facade mismatch.');
            const environment = await window.studio.env();
            const history = await window.studio.history();
            if (!environment.ok || !environment.ffmpeg || !history.ok || !history.entries.length) throw new Error('Main-frame env/history bridge failed.');
            if (typeof environment.model !== 'string' || !environment.model || typeof environment.claudeModel !== 'string' || !environment.claudeModel
              || document.getElementById('modelBadge').textContent.includes('undefined')) throw new Error('Environment model labels are missing.');
            const count = document.querySelectorAll('#historyList .history-item').length;
            if (count !== history.entries.length || Number(document.getElementById('historyCount').textContent) !== count) throw new Error('History DOM does not match stored entries.');
            const hint = document.getElementById('ffmpegHint').textContent;
            const button = document.getElementById('installFfmpegBtn');
            if (!hint.includes('이 Mac') || hint.includes('이 PC') || !button.textContent.includes('연결 / 설치 안내')) throw new Error('macOS FFmpeg adaptation was not applied.');
            return {methodCount:calls.length, subscriptionCount:events.length, mainFrameEnv:true, mainFrameHistory:true,
              historyCount:count, ffmpegAvailable:true, ffmpegHint:hint, ffmpegButtonHidden:button.hidden,
              documentTitle:document.title, authenticationMode:'offline-fixture'};
            """)

            _ = try await javascript(web, body: """
            document.querySelector('[data-tab="history"]').click();
            const button = [...document.querySelectorAll('#historyList .history-item:first-child .history-actions button')]
              .find(button => button.textContent.trim() === '열기');
            if (!button) throw new Error('Original history Open button is missing.');
            button.click();
            return true;
            """)
            try await waitFor(web, coordinator: coordinator, label: "history Open button", expression: """
            typeof current !== 'undefined' && current?.hasVideo && current?.imageUrl
              && !document.getElementById('conceptView').hidden
              && document.getElementById('resultTitle').textContent === current.title
              && document.getElementById('statusText').textContent.startsWith('기록 불러옴')
            """)

            _ = try await javascript(web, body: "document.querySelector('[data-tab=\"image\"]').click(); return true;")
            try await waitFor(web, coordinator: coordinator, label: "studio-image board", expression: """
            document.getElementById('boardImage').complete && document.getElementById('boardImage').naturalWidth > 0
              && document.getElementById('boardImage').currentSrc.startsWith('studio-image://local/')
            """)
            let board = try await javascript(web, body: """
            const image = document.getElementById('boardImage');
            if (document.getElementById('imageView').hidden || !document.getElementById('yamlPre').textContent.trim()) throw new Error('Original board or YAML view is empty.');
            return {historyOpenButton:true, loaded:true, width:image.naturalWidth, height:image.naturalHeight,
              sourceScheme:new URL(image.currentSrc).protocol, yamlPopulated:true, conceptPopulated:Boolean(document.getElementById('conceptText').textContent.trim())};
            """)

            let forms = try await javascript(web, body: """
            const required = [...FORM_FIELDS, ...FORM_CHECKS, 'runBtn','cancelBtn','conceptView','yamlPre','boardImage',
              'videoPlayer','videoNotes','historyList','historyCount'];
            const missing = required.filter(id => !document.getElementById(id));
            if (missing.length) throw new Error(`Missing original controls: ${missing.join(', ')}`);
            const fieldIDs = ['provider','musicSource','engine','quality','duration','topic'];
            const saved = Object.fromEntries(fieldIDs.map(id => [id,document.getElementById(id).value]));
            const videoWasChecked = document.getElementById('withVideo').checked;
            const change = (id,value) => {const node=document.getElementById(id);node.value=value;node.dispatchEvent(new Event('change',{bubbles:true}));};
            let result;
            try {
              change('provider','claude');
              const claudeChoice = !document.getElementById('withImageRow').hidden && document.getElementById('modelBadge').textContent.includes(envInfo.claudeModel);
              change('musicSource','file');
              const musicChoice = !document.getElementById('musicFileRow').hidden;
              document.getElementById('withVideo').click();
              const toggleWorks = document.getElementById('videoOptions').hidden === !document.getElementById('withVideo').checked;
              change('engine','code'); change('quality','draft'); change('duration','19'); change('topic','로컬 UI 검증');
              const input = collectInput();
              if (!claudeChoice || !musicChoice || !toggleWorks || input.engine !== 'code' || input.quality !== 'draft'
                || input.durationSeconds !== 19 || input.topic !== '로컬 UI 검증') throw new Error('Original form change handlers did not update the UI/input.');
              const duration = document.getElementById('duration');
              if (duration.min !== '5' || duration.max !== '120') throw new Error('Original duration range changed.');
              result = {missingControls:missing, providerChoice:true, musicChoice:true, videoToggle:true,
                collectedInput:true, durationMinimum:Number(duration.min), durationMaximum:Number(duration.max)};
            } finally {
              for (const [id,value] of Object.entries(saved)) change(id,value);
              if (document.getElementById('withVideo').checked !== videoWasChecked) document.getElementById('withVideo').click();
            }
            const tabs = ['concept','yaml','image','video','history'];
            for (const name of tabs) {
              document.querySelector(`[data-tab="${name}"]`).click();
              const active = document.querySelectorAll('.tab.active'), body = document.querySelectorAll('.tab-body.active');
              if (active.length !== 1 || body.length !== 1 || active[0].dataset.tab !== name || body[0].dataset.body !== name
                || getComputedStyle(body[0]).display === 'none') throw new Error(`Original ${name} tab did not open.`);
            }
            document.querySelector('[data-tab="video"]').click();
            return {...result,tabs};
            """)

            try await waitFor(web, coordinator: coordinator, label: "studio-video metadata", timeout: 30, expression: """
            (() => { const video=document.getElementById('videoPlayer');
              if (video.error) throw new Error(`Video media error ${video.error.code}: ${video.error.message}`);
              return video.readyState >= 1 && video.videoWidth > 0 && video.videoHeight > 0
                && Number.isFinite(video.duration) && video.duration > 0 && video.currentSrc.startsWith('studio-video://local/');
            })()
            """)
            let playback = try await javascript(web, body: """
            const video = document.getElementById('videoPlayer');
            video.muted = true;
            const before = video.currentTime;
            const attempt = await Promise.race([
              Promise.resolve().then(() => video.play()).then(() => ({allowed:true})).catch(error => ({allowed:false,reason:`${error.name}: ${error.message}`})),
              new Promise(resolve => setTimeout(() => resolve({allowed:false,reason:'Playback request exceeded 3 seconds.'}),3000))
            ]);
            if (attempt.allowed) await new Promise(resolve => setTimeout(resolve,400));
            const advanced = video.currentTime > before + 0.05;
            video.pause();
            return {...attempt,attempted:true,advanced,mutedForVerification:true};
            """)
            _ = try await javascript(web, body: """
            const video = document.getElementById('videoPlayer');
            video.pause();
            video.currentTime = Math.min(1,video.duration/2);
            return true;
            """)
            try await waitFor(web, coordinator: coordinator, label: "video seek and decoded frame", timeout: 20, expression: """
            (() => { const video=document.getElementById('videoPlayer');
              if (video.error) throw new Error(`Video media error ${video.error.code}: ${video.error.message}`);
              return !video.seeking && video.readyState >= 2 && Math.abs(video.currentTime-Math.min(1,video.duration/2)) < 0.1;
            })()
            """)
            let video = try await javascript(web, body: """
            const player = document.getElementById('videoPlayer'), expected = current.videoMeta || {};
            const sceneCount = expected.direction?.shots?.length || 0;
            const sceneSummary = [...document.querySelectorAll('#videoNotes li')].some(item => item.textContent.includes(`장면 ${sceneCount}개`));
            if (player.videoWidth !== expected.width || player.videoHeight !== expected.height
              || Math.abs(player.duration-expected.T) > Math.max(0.1,2/(expected.fps || 30))) throw new Error('Video metadata differs from the stored result.');
            if (sceneCount && !sceneSummary) throw new Error('Original scene summary was not displayed.');
            const quality = typeof player.getVideoPlaybackQuality === 'function' ? player.getVideoPlaybackQuality() : null;
            return {loadedMetadata:true, decodedFrameAvailable:player.readyState >= 2, sourceScheme:new URL(player.currentSrc).protocol,
              width:player.videoWidth,height:player.videoHeight,duration:player.duration,currentTime:player.currentTime,
              paused:player.paused,seekCompleted:!player.seeking,expectedDuration:expected.T,sceneCount,sceneSummaryPresent:sceneSummary,
              totalVideoFrames:quality?.totalVideoFrames ?? null,readyState:player.readyState};
            """)

            let iframe = try await javascript(web, body: """
            const frame = document.createElement('iframe');
            frame.hidden = true;
            document.body.appendChild(frame);
            try {
              await new Promise(resolve => setTimeout(resolve,100));
              let handler;
              try { handler = frame.contentWindow?.webkit?.messageHandlers?.studio; }
              catch (error) { return {requestAttempted:false,handlerAccessible:false,nativeGuardVerified:false,limitation:`Subframe handler inaccessible: ${error.name}`}; }
              if (!handler) return {requestAttempted:false,handlerAccessible:false,nativeGuardVerified:false,limitation:'No native handler is exposed to the empty subframe.'};
              const response = await handler.postMessage({method:'studio:env',params:null});
              if (response?.ok !== false) throw new Error('A subframe accessed the native studio bridge.');
              return {requestAttempted:true,handlerAccessible:true,nativeGuardVerified:true,rejected:true};
            } finally { frame.remove(); }
            """)

            _ = try await javascript(web, body: """
            document.querySelector('[data-tab="video"]').click();
            window.scrollTo(0,0);
            await document.fonts.ready;
            await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
            return {width:innerWidth,height:innerHeight};
            """)
            let capture = try await saveSnapshot(web, window: window, to: screenshot)
            var limitations: [JSONValue] = [.string("Provider responses and account status were offline fixtures; no real login or AI generation was tested.")]
            if playback["allowed"].boolValue != true || playback["advanced"].boolValue != true {
                limitations.append(.string("Programmatic playback did not advance; metadata, decoding, and seek were verified separately."))
            }
            if iframe["nativeGuardVerified"].boolValue != true {
                limitations.append(.string(iframe["limitation"].stringValue ?? "A subframe native request could not be dispatched."))
            }
            let receipt: JSONValue = .object([
                "ok": .bool(true), "originalFrontend": .bool(true), "productionNativeBridge": .bool(true),
                "nonPersistentWebData": .bool(true), "realProviderLoginTested": .bool(false),
                "bridge": bridge, "board": board, "forms": forms, "video": video,
                "playback": playback, "subframe": iframe, "screenshot": capture,
                "limitations": .array(limitations)
            ])
            let encoder = JSONEncoder()
            encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
            try encoder.encode(receipt).write(to: receiptFile, options: .withoutOverwriting)
            return receipt
        } catch {
            let failureImage = output.appendingPathComponent("native-ui-failure.png")
            if !FileManager.default.fileExists(atPath: failureImage.path) {
                _ = try? await saveSnapshot(web, window: window, to: failureImage)
            }
            throw error
        }
    }

    private static func waitFor(_ web: WKWebView, coordinator: StudioCoordinator, label: String,
                                timeout: Double = 20, expression: String) async throws {
        let deadline = ContinuousClock.now + .seconds(timeout)
        while ContinuousClock.now < deadline {
            try Task.checkCancellation()
            if let failure = coordinator.failure { throw StudioError("\(label): \(failure)") }
            if coordinator.ready, !web.isLoading, web.url != nil {
                let result = try await javascript(web, body: "return Boolean(\(expression));")
                if result.boolValue == true { return }
            }
            try await Task.sleep(for: .milliseconds(100))
        }
        let state = try? await javascript(web, body: """
        const video=document.getElementById('videoPlayer');
        return {readyState:document.readyState,historyCount:document.getElementById('historyCount')?.textContent,
          status:document.getElementById('statusText')?.textContent,ffmpegHint:document.getElementById('ffmpegHint')?.textContent,
          videoReadyState:video?.readyState,videoError:video?.error?.message};
        """)
        throw StudioError("Timed out waiting for \(label). \((try? state?.encodedString()) ?? "No page state available.")")
    }

    private static func javascript(_ web: WKWebView, body: String, timeout: Double = 15) async throws -> JSONValue {
        let gate = OriginalUIReply<String>(timeout: timeout)
        let source = "const result = await (async () => {\n\(body)\n})(); return JSON.stringify(result === undefined ? null : result);"
        let encoded = try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
                gate.start(continuation)
                web.callAsyncJavaScript(source, arguments: [:], in: nil, in: .page) { result in
                    switch result {
                    case .success(let value):
                        if let text = value as? String { gate.finish(.success(text)) }
                        else { gate.finish(.failure(StudioError("UI verification did not return JSON."))) }
                    case .failure(let error): gate.finish(.failure(error))
                    }
                }
            }
        } onCancel: {
            Task { @MainActor in gate.finish(.failure(CancellationError())) }
        }
        return try JSONDecoder().decode(JSONValue.self, from: Data(encoded.utf8))
    }

    private static func saveSnapshot(_ web: WKWebView, window: NSWindow, to file: URL) async throws -> JSONValue {
        let width = 1380, height = 900
        guard Int(web.bounds.width) == width, Int(web.bounds.height) == height else {
            throw StudioError("Original UI viewport did not retain 1380×900 dimensions.")
        }
        web.layoutSubtreeIfNeeded()
        let configuration = WKSnapshotConfiguration()
        configuration.rect = web.bounds
        configuration.snapshotWidth = NSNumber(value: Double(width) / max(1, window.backingScaleFactor))
        configuration.afterScreenUpdates = true
        let gate = OriginalUIReply<CGImage>(timeout: 20)
        let image = try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
                gate.start(continuation)
                web.takeSnapshot(with: configuration) { image, error in
                    if let error { gate.finish(.failure(error)); return }
                    guard let image, let cg = image.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
                        gate.finish(.failure(StudioError("WebKit did not return the original UI snapshot."))); return
                    }
                    gate.finish(.success(cg))
                }
            }
        } onCancel: {
            Task { @MainActor in gate.finish(.failure(CancellationError())) }
        }
        guard let space = CGColorSpace(name: CGColorSpace.sRGB),
              let context = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: width * 4,
                                      space: space, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue | CGBitmapInfo.byteOrder32Big.rawValue) else {
            throw StudioError("Could not allocate the native UI snapshot.")
        }
        context.setFillColor(CGColor(gray: 1, alpha: 1))
        context.fill(CGRect(x: 0, y: 0, width: width, height: height))
        context.interpolationQuality = .high
        context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
        guard let exact = context.makeImage(), let bytes = context.data?.assumingMemoryBound(to: UInt8.self) else {
            throw StudioError("Could not inspect the native UI snapshot.")
        }
        var sum = 0.0, squared = 0.0, count = 0.0
        for pixel in stride(from: 0, to: width * height, by: max(1, width * height / 20_000)) {
            let offset = pixel * 4
            let value = 0.2126 * Double(bytes[offset]) + 0.7152 * Double(bytes[offset + 1]) + 0.0722 * Double(bytes[offset + 2])
            sum += value; squared += value * value; count += 1
        }
        let spread = sqrt(max(0, squared / count - pow(sum / count, 2)))
        guard spread > 2 else { throw StudioError("The native UI snapshot is blank or nearly uniform.") }
        let png = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(png, UTType.png.identifier as CFString, 1, nil) else {
            throw StudioError("Could not encode the native UI snapshot.")
        }
        CGImageDestinationAddImage(destination, exact, nil)
        guard CGImageDestinationFinalize(destination) else { throw StudioError("Native UI PNG encoding failed.") }
        try (png as Data).write(to: file, options: .withoutOverwriting)
        return .object(["file": .string(file.lastPathComponent), "width": .number(Double(width)), "height": .number(Double(height)),
                        "luminanceSpread": .number(spread), "capture": .string("WKWebView DOM snapshot")])
    }
}

@MainActor
private final class OriginalUIVerificationWindow: NSWindow {
    override func constrainFrameRect(_ frameRect: NSRect, to screen: NSScreen?) -> NSRect { frameRect }
}

@MainActor
private final class OriginalUIReply<Value: Sendable> {
    private let timeout: Double
    private var continuation: CheckedContinuation<Value, Error>?
    private var result: Result<Value, Error>?
    private var timer: Task<Void, Never>?

    init(timeout: Double) { self.timeout = timeout }
    func start(_ continuation: CheckedContinuation<Value, Error>) {
        if let result { continuation.resume(with: result); return }
        self.continuation = continuation
        timer = Task { @MainActor [weak self] in
            guard let timeout = self?.timeout else { return }
            do { try await Task.sleep(for: .seconds(timeout)) } catch { return }
            self?.finish(.failure(StudioError("Native UI operation exceeded \(Int(timeout)) seconds.")))
        }
    }
    func finish(_ result: Result<Value, Error>) {
        guard self.result == nil else { return }
        self.result = result
        timer?.cancel(); timer = nil
        continuation?.resume(with: result); continuation = nil
    }
}
