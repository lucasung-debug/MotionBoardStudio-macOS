import Foundation

@MainActor
final class RuntimeBridge {
    var onEvent: ((String, JSONValue) -> Void)?
    var onFailure: ((String) -> Void)?
    var nativeCall: ((String, [String: JSONValue]) async throws -> JSONValue)?
    private var process: Process?
    private var input: Pipe?
    private var output: Pipe?
    private var errors: Pipe?
    private var buffer = Data()
    private var nextID = 0
    private var pending: [String: CheckedContinuation<JSONValue, Error>] = [:]
    private var startup: CheckedContinuation<Void, Error>?
    private var ready = false
    private var stopping = false

    func start(userData: URL, verification: Bool = false) async throws {
        guard process == nil else { return }
        let bundled = Bundle.main.bundleURL.appendingPathComponent("Contents/MacOS/node").path
        let choices = [bundled, "/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node"]
        guard let node = choices.first(where: FileManager.default.isExecutableFile(atPath:)) else {
            throw StudioError("Node.js 실행 파일을 찾지 못했습니다. 번들 앱을 다시 빌드하거나 Node.js를 설치해 주세요.")
        }
        try FileManager.default.createDirectory(at: userData, withIntermediateDirectories: true)
        let child = Process()
        let stdin = Pipe(), stdout = Pipe(), stderr = Pipe()
        child.executableURL = URL(fileURLWithPath: node)
        child.arguments = [StudioPaths.runtimeRoot.appendingPathComponent("worker.cjs").path]
        child.currentDirectoryURL = StudioPaths.runtimeRoot
        let current = ProcessInfo.processInfo.environment
        var environment = current.filter { ["HOME", "TMPDIR", "LANG", "LC_ALL"].contains($0.key) }
        let bundledTools = Bundle.main.bundleURL.appendingPathComponent("Contents/MacOS", isDirectory: true)
        let bundledFFmpeg = bundledTools.appendingPathComponent("ffmpeg").path
        let bundledFFprobe = bundledTools.appendingPathComponent("ffprobe").path
        environment["PATH"] = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
        if FileManager.default.isExecutableFile(atPath: bundledFFmpeg),
           FileManager.default.isExecutableFile(atPath: bundledFFprobe) {
            environment["PATH"] = bundledTools.path + ":" + environment["PATH"]!
            environment["MOTION_BOARD_FFMPEG"] = bundledFFmpeg
            // The distributable LGPL build uses Apple's H.264 encoder.
            environment["MOTION_BOARD_H264_ENCODER"] = "h264_videotoolbox"
        }
        child.environment = environment
        child.standardInput = stdin; child.standardOutput = stdout; child.standardError = stderr
        input = stdin; output = stdout; errors = stderr; process = child
        stdout.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            if data.isEmpty { handle.readabilityHandler = nil; return }
            DispatchQueue.main.async { self?.consume(data) }
        }
        // Provider payloads and authentication errors are never echoed to the console.
        stderr.fileHandleForReading.readabilityHandler = { handle in
            if handle.availableData.isEmpty { handle.readabilityHandler = nil }
        }
        child.terminationHandler = { [weak self] _ in
            DispatchQueue.main.async { self?.terminated() }
        }
        try child.run()
        try await withCheckedThrowingContinuation { continuation in
            startup = continuation
            do {
                try send(.object(["kind": .string("init"), "sourceRoot": .string(StudioPaths.sourceRoot.path),
                                  "userData": .string(userData.path), "verification": .bool(verification)]))
            } catch { fail(error) }
            Task { @MainActor [weak self] in
                try? await Task.sleep(for: .seconds(30))
                if self?.startup != nil { self?.fail(StudioError("앱 처리 엔진 시작 시간이 초과되었습니다.")) }
            }
        }
    }

    func invoke(_ method: String, params: JSONValue = .null) async throws -> JSONValue {
        guard ready, !stopping else { throw StudioError("앱 처리 엔진이 준비되지 않았습니다.") }
        nextID += 1
        let id = "s\(nextID)"
        return try await withCheckedThrowingContinuation { continuation in
            pending[id] = continuation
            do { try send(.object(["kind": .string("request"), "id": .string(id), "method": .string(method), "params": params])) }
            catch { pending.removeValue(forKey: id)?.resume(throwing: error) }
        }
    }

    func stop() {
        guard !stopping else { return }
        stopping = true; ready = false
        try? input?.fileHandleForWriting.close()
        fail(StudioError("앱이 종료되었습니다."), notify: false)
        let child = process
        Task { @MainActor in
            try? await Task.sleep(for: .seconds(3))
            if child?.isRunning == true { child?.terminate() }
        }
    }

    private func send(_ value: JSONValue) throws {
        guard process?.isRunning == true, let handle = input?.fileHandleForWriting else {
            throw StudioError("앱 처리 엔진 연결이 닫혔습니다.")
        }
        var data = try JSONEncoder().encode(value)
        data.append(10)
        try handle.write(contentsOf: data)
    }

    private func consume(_ data: Data) {
        buffer.append(data)
        guard buffer.count <= 64 * 1024 * 1024 else { fail(StudioError("처리 엔진 응답이 너무 큽니다.")); stop(); return }
        while let end = buffer.firstIndex(of: 10) {
            let line = Data(buffer[..<end]); buffer.removeSubrange(...end)
            guard !line.isEmpty else { continue }
            do { handle(try JSONDecoder().decode(JSONValue.self, from: line)) }
            catch { fail(StudioError("앱 처리 엔진의 응답을 읽지 못했습니다.")) }
        }
    }

    private func handle(_ message: JSONValue) {
        switch message["kind"].stringValue {
        case "ready":
            ready = true; startup?.resume(); startup = nil
        case "result":
            if let id = message["id"].stringValue { pending.removeValue(forKey: id)?.resume(returning: message["result"]) }
        case "event":
            if let event = message["event"].stringValue { onEvent?(event, message["payload"]) }
        case "fatal": fail(StudioError(message["error"].stringValue ?? "앱 처리 엔진 오류가 발생했습니다."))
        case "native":
            guard let id = message["id"].stringValue, let method = message["method"].stringValue else { return }
            let params = message["params"].objectValue ?? [:]
            Task { @MainActor [weak self] in
                guard let self else { return }
                do {
                    guard let call = self.nativeCall else { throw StudioError("Mac 서비스가 연결되지 않았습니다.") }
                    let result = try await call(method, params)
                    try self.send(.object(["kind": .string("nativeResult"), "id": .string(id), "result": result]))
                } catch {
                    var response: [String: JSONValue] = ["kind": .string("nativeResult"), "id": .string(id), "error": .string(error.localizedDescription)]
                    if let storageError = error as? StudioVaultError { response["storageError"] = storageError.diagnostic }
                    try? self.send(.object(response))
                }
            }
        default: break
        }
    }
    private func terminated() {
        output?.fileHandleForReading.readabilityHandler = nil
        errors?.fileHandleForReading.readabilityHandler = nil
        if !stopping { fail(StudioError("앱 처리 엔진이 종료되었습니다. 앱을 다시 열어 주세요.")) }
    }
    private func fail(_ error: Error, notify: Bool = true) {
        ready = false
        startup?.resume(throwing: error); startup = nil
        for continuation in pending.values { continuation.resume(throwing: error) }
        pending.removeAll()
        if notify, !stopping { onFailure?(error.localizedDescription) }
    }
}
