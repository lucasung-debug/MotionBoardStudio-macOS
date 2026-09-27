import AppKit
import Foundation

/// Explicit opt-in acceptance with the accounts connected in this application.
/// This consumes provider usage and public music downloads. It never substitutes
/// provider responses, imports credentials, or modifies existing app history.
@MainActor
enum OriginalLiveVerification {
    static func run(arguments: [String]) async -> Int32 {
        let runtime = RuntimeBridge()
        var actions: NativeActions?
        var destination: URL?
        var evidence: [String: JSONValue] = ["liveProviders": .bool(true), "ok": .bool(false)]
        do {
            guard let index = arguments.firstIndex(of: "--output"), index + 1 < arguments.count else {
                throw StudioError("Live verification requires --output <new directory> and both accounts connected in this app.")
            }
            let output = URL(fileURLWithPath: arguments[index + 1], isDirectory: true).standardizedFileURL
            guard !FileManager.default.fileExists(atPath: output.path) else { throw StudioError("Live verification output already exists.") }
            try FileManager.default.createDirectory(at: output, withIntermediateDirectories: true)
            destination = output
            let native = NativeActions(userData: output)
            actions = native
            runtime.nativeCall = { method, params in try await native.handle(method: method, params: params) }
            var previousPhase = ""
            runtime.onEvent = { event, payload in
                guard event == "studio:progress", let phase = payload["phase"].stringValue, phase != previousPhase else { return }
                previousPhase = phase
                print("Live verification: \(phase)"); fflush(stdout)
            }
            try await runtime.start(userData: output)
            let chatgpt = try await requireOK(runtime.invoke("studio:authStatus"))
            let claude = try await requireOK(runtime.invoke("studio:claudeStatus"))
            guard chatgpt["status"]["loggedIn"].boolValue == true, claude["status"]["loggedIn"].boolValue == true else {
                throw StudioError("이 앱에서 ChatGPT와 Claude 로그인을 먼저 완료해 주세요.")
            }
            evidence["bothAppAccountsConnected"] = .bool(true)
            let spec = try await requireOK(runtime.invoke("studio:spec", params: .object([
                "provider": .string("chatgpt"), "mode": .string("full"), "topic": .string("MAC MOTION — 맥에서 시작하는 움직임"),
                "mood": .string("경쾌하고 리듬감 있게"), "style": .string("네이비, 레드, 크림 색상의 타이포그래피와 기하학 도형"),
                "copy": .string("MAC MOTION"), "aspectRatio": .string("1:1"), "durationSeconds": .number(8)
            ])))
            guard let id = spec["entry"]["id"].stringValue else { throw StudioError("생성 기록 ID가 없습니다.") }
            evidence["entryID"] = .string(id)
            evidence["specificationModel"] = spec["entry"]["model"]
            let board = try await requireOK(runtime.invoke("studio:board", params: .object(["id": .string(id)])))
            evidence["boardGenerated"] = board["entry"]["hasImage"]
            evidence["imageModel"] = board["entry"]["imageModel"]
            let movie = try await requireOK(runtime.invoke("studio:video", params: .object([
                "id": .string(id), "options": .object(["provider": .string("claude"), "engine": .string("direct"),
                    "musicSource": .string("mixkit"), "quality": .string("final"), "review": .bool(true)])
            ])))
            guard movie["entry"]["hasVideo"].boolValue == true else { throw StudioError("완성된 영상을 확인하지 못했습니다.") }
            let reopened = try await requireOK(runtime.invoke("studio:historyGet", params: .object(["id": .string(id)])))
            guard reopened["entry"]["videoUrl"] == movie["entry"]["videoUrl"] else { throw StudioError("기록의 영상 주소가 일치하지 않습니다.") }
            evidence["videoModel"] = movie["entry"]["videoModel"]
            evidence["video"] = movie["entry"]["videoMeta"]
            evidence["historyRoundTrip"] = .bool(true)
            evidence["ok"] = .bool(true)
            try save(evidence, to: output)
            native.renderer.closeAll(); runtime.stop()
            print("PASS: live ChatGPT specification and board, Claude direction/review, Mixkit music, native video and history.")
            print("Artifacts: \(output.path)")
            return 0
        } catch {
            actions?.renderer.closeAll(); runtime.stop()
            evidence["error"] = .string(error.localizedDescription)
            if let destination { try? save(evidence, to: destination) }
            fputs("Live verification failed: \(error.localizedDescription)\n", stderr)
            return 1
        }
    }

    private static func requireOK(_ value: JSONValue) throws -> JSONValue {
        guard value["ok"].boolValue == true else { throw StudioError(value["error"].stringValue ?? "Live operation failed.") }
        return value
    }

    private static func save(_ evidence: [String: JSONValue], to output: URL) throws {
        let encoder = JSONEncoder(); encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        try encoder.encode(JSONValue.object(evidence)).write(to: output.appendingPathComponent("live-receipt.json"), options: .atomic)
    }
}
