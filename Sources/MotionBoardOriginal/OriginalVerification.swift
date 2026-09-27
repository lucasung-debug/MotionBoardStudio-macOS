import AppKit
import Foundation

@MainActor
enum OriginalVerification {
    static func run(arguments: [String]) async -> Int32 {
        let runtime = RuntimeBridge()
        var actions: NativeActions?
        do {
            let output: URL
            if let index = arguments.firstIndex(of: "--output"), index + 1 < arguments.count {
                output = URL(fileURLWithPath: arguments[index + 1], isDirectory: true).standardizedFileURL
            } else { output = FileManager.default.temporaryDirectory.appendingPathComponent("motionboard-original-\(UUID().uuidString)", isDirectory: true) }
            guard !FileManager.default.fileExists(atPath: output.path) else { throw StudioError("Verification output already exists; choose a new directory.") }
            try FileManager.default.createDirectory(at: output, withIntermediateDirectories: true)
            let native = NativeActions(userData: output, verification: true)
            actions = native
            runtime.nativeCall = { method, params in try await native.handle(method: method, params: params) }
            var lastPhase = ""
            runtime.onEvent = { event, payload in
                guard event == "studio:progress", let phase = payload["phase"].stringValue, phase != lastPhase else { return }
                lastPhase = phase
                print("Offline verification: \(phase)"); fflush(stdout)
            }
            try await runtime.start(userData: output, verification: true)
            let result = try await runtime.invoke("verification:run", params: .object(["fullSize": .bool(arguments.contains("--full-size"))]))
            guard result["ok"].boolValue == true else { throw StudioError(result["error"].stringValue ?? "Original application verification failed.") }
            var receipt = result.objectValue ?? [:]
            receipt["nativeServices"] = try await verifyNativeServices(native, output: output)
            native.renderer.closeAll(); runtime.stop()
            receipt["nativeUI"] = try await OriginalUIVerification.run(dataRoot: output, output: output)
            let data = try JSONEncoder().encode(JSONValue.object(receipt))
            try data.write(to: output.appendingPathComponent("native-receipt.json"), options: .atomic)
            print("PASS: original motion workflow, image-video scene preparation/export, native interface, history, three ratios, free code, 60fps blur, cancellation.")
            print("Artifacts: \(output.path)")
            print("Provider calls were offline fixtures; real account login and generation remain unverified.")
            native.renderer.closeAll(); runtime.stop()
            return 0
        } catch {
            actions?.renderer.closeAll(); runtime.stop()
            fputs("Original verification failed: \(error.localizedDescription)\n", stderr)
            return 1
        }
    }

    static func runUI(arguments: [String]) async -> Int32 {
        do {
            guard let inputIndex = arguments.firstIndex(of: "--data-root"), inputIndex + 1 < arguments.count,
                  let outputIndex = arguments.firstIndex(of: "--output"), outputIndex + 1 < arguments.count else {
                throw StudioError("Use --verify-ui --data-root <existing fixture data> --output <new directory>.")
            }
            let root = URL(fileURLWithPath: arguments[inputIndex + 1], isDirectory: true).standardizedFileURL
            let output = URL(fileURLWithPath: arguments[outputIndex + 1], isDirectory: true).standardizedFileURL
            guard !FileManager.default.fileExists(atPath: output.path) else { throw StudioError("UI verification output already exists.") }
            _ = try await OriginalUIVerification.run(dataRoot: root, output: output)
            print("PASS: actual Mac WebKit interface and native bridge. Artifacts: \(output.path)")
            return 0
        } catch {
            fputs("Original UI verification failed: \(error.localizedDescription)\n", stderr)
            return 1
        }
    }

    private static func verifyNativeServices(_ native: NativeActions, output: URL) async throws -> JSONValue {
        let vault = StudioVault(service: "io.github.lucasung-debug.motionboardstudio.verification.\(UUID().uuidString)")
        // This isolated item is created by this test and never contains an account credential.
        try vault.write("chatgpt", value: "synthetic-first")
        do {
            guard try vault.read("chatgpt") == "synthetic-first" else { throw StudioError("Keychain read failed.") }
            try vault.write("chatgpt", value: "synthetic-updated")
            guard try vault.read("chatgpt") == "synthetic-updated" else { throw StudioError("Keychain update failed.") }
            try vault.delete("chatgpt")
            guard try vault.read("chatgpt") == nil else { throw StudioError("Keychain delete failed.") }
        } catch { try? vault.delete("chatgpt"); throw error }

        let picked = FileManager.default.temporaryDirectory.appendingPathComponent("motionboard-picked-\(UUID().uuidString).png")
        try FileManager.default.copyItem(at: output.appendingPathComponent("verification/1-1.png"), to: picked)
        defer { try? FileManager.default.removeItem(at: picked) }
        var rejected = false
        do { _ = try await native.handle(method: "image.loadForModel", params: ["path": .string(picked.path)]) }
        catch { rejected = true }
        guard rejected else { throw StudioError("An unselected external image was accepted.") }
        native.registerSelectedFiles([picked])
        let image = try await native.handle(method: "image.loadForModel", params: ["path": .string(picked.path)])
        guard image["mediaType"].stringValue == "image/jpeg", let encoded = image["data"].stringValue,
              let bytes = Data(base64Encoded: encoded), NSImage(data: bytes) != nil else {
            throw StudioError("Selected external image import failed.")
        }
        guard StudioAssetHandler.parseRange("bytes=0-1", size: 20) == 0...1,
              StudioAssetHandler.parseRange("bytes=-4", size: 20) == 16...19,
              StudioAssetHandler.parseRange("bytes=5-", size: 20) == 5...19,
              StudioAssetHandler.parseRange("bytes=20-", size: 20) == nil else { throw StudioError("Media byte ranges failed.") }
        print("PASS: isolated native Keychain CRUD, selected external image, media byte ranges.")
        return .object(["keychainSyntheticCRUD": .bool(true), "selectedImageImport": .bool(true),
                        "unselectedImageRejected": .bool(true), "mediaByteRanges": .bool(true)])
    }
}
