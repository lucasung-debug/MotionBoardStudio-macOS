// Standalone verification harness; compile with JSONValue.swift and
// OriginalPageRenderer.swift. This file is not part of the application target.
import AppKit
import Foundation
import ImageIO

extension Bundle { static var module: Bundle { .main } }

@main
enum VerifyOriginalRenderer {
    @MainActor
    static func main() {
        NSApplication.shared.setActivationPolicy(.prohibited)
        Task { @MainActor in
            do {
                guard CommandLine.arguments.count == 3 else {
                    throw Failure("Usage: verify-renderer <fixture-directory> <new-output-directory>")
                }
                let fixtures = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true)
                let output = URL(fileURLWithPath: CommandLine.arguments[2], isDirectory: true)
                guard !FileManager.default.fileExists(atPath: output.path) else { throw Failure("Output directory already exists.") }
                try FileManager.default.createDirectory(at: output, withIntermediateDirectories: true)
                let renderer = OriginalPageRenderer(allowedRoots: [fixtures, output], allowRemoteFonts: false)
                defer { renderer.closeAll() }
                let opened = try await renderer.handle(method: "render.open", params: [
                    "path": .string(fixtures.appendingPathComponent("dom-motion.html").path),
                    "W": .number(640), "H": .number(360)
                ])
                guard let id = opened.objectValue?["pageId"]?.stringValue,
                      opened.objectValue?["ready"]?.boolValue == true,
                      opened.objectValue?["errors"]?.arrayValue?.isEmpty == true else { throw Failure("Fixture did not initialize.") }
                func capture(_ time: Double, format: String = "png") async throws -> Data {
                    let result = try await renderer.handle(method: "render.capture", params: [
                        "pageId": .string(id), "time": .number(time), "format": .string(format)
                    ])
                    guard let encoded = result.objectValue?["data"]?.stringValue,
                          let bytes = Data(base64Encoded: encoded) else { throw Failure("Capture returned no bytes.") }
                    return bytes
                }
                let first = try await capture(0.25)
                let changed = try await capture(0.75)
                let loop = try await capture(2.25)
                guard first != changed, first == loop else { throw Failure("DOM variation or loop determinism failed.") }
                for (name, data) in [("frame-a.png", first), ("frame-b.png", changed), ("loop.png", loop)] {
                    guard let source = CGImageSourceCreateWithData(data as CFData, nil),
                          let image = CGImageSourceCreateImageAtIndex(source, 0, nil),
                          image.width == 640, image.height == 360 else { throw Failure("PNG dimensions are not 640 x 360.") }
                    try data.write(to: output.appendingPathComponent(name), options: .atomic)
                }
                let jpeg = try await capture(0.25, format: "jpeg")
                guard let jpegSource = CGImageSourceCreateWithData(jpeg as CFData, nil),
                      let jpegImage = CGImageSourceCreateImageAtIndex(jpegSource, 0, nil),
                      jpegImage.width == 640, jpegImage.height == 360 else { throw Failure("JPEG dimensions are incorrect.") }
                try jpeg.write(to: output.appendingPathComponent("frame.jpg"), options: .atomic)
                let spreadResult = try await renderer.handle(method: "image.spread", params: ["data": .string(first.base64EncodedString())])
                guard let spread = spreadResult.objectValue?["spread"]?.doubleValue, spread > 1.5 else { throw Failure("DOM screenshot is blank.") }
                let promise = try await renderer.handle(method: "render.eval", params: [
                    "pageId": .string(id),
                    "code": .string("Promise.resolve({value: 42, bridgeKeys: Object.keys(window.webkit?.messageHandlers || {})})")
                ])
                guard promise.objectValue?["value"]?.doubleValue == 42,
                      promise.objectValue?["bridgeKeys"]?.arrayValue?.isEmpty == true else { throw Failure("Promise evaluation or render isolation failed.") }
                let loaded = try await renderer.handle(method: "image.loadForModel", params: ["path": .string(output.appendingPathComponent("frame-a.png").path)])
                guard loaded.objectValue?["mediaType"]?.stringValue == "image/jpeg",
                      let encoded = loaded.objectValue?["data"]?.stringValue,
                      let data = Data(base64Encoded: encoded), let source = CGImageSourceCreateWithData(data as CFData, nil),
                      let image = CGImageSourceCreateImageAtIndex(source, 0, nil),
                      max(image.width, image.height) <= 1568 else { throw Failure("Model image conversion failed.") }
                var rejectedPath = false
                do {
                    _ = try await renderer.handle(method: "image.loadForModel", params: ["path": .string("/etc/hosts")])
                } catch { rejectedPath = true }
                guard rejectedPath else { throw Failure("An out-of-scope file was admitted.") }
                _ = try await renderer.handle(method: "render.close", params: ["pageId": .string(id)])
                let fontsMode = OriginalPageRenderer(allowedRoots: [fixtures], allowRemoteFonts: true)
                defer { fontsMode.closeAll() }
                // The fixture itself has no remote resources. This also checks
                // that the optional font-only rule list compiles successfully.
                let fontRules = try await fontsMode.handle(method: "render.open", params: [
                    "path": .string(fixtures.appendingPathComponent("dom-motion.html").path),
                    "W": .number(640), "H": .number(360)
                ])
                guard fontRules.objectValue?["ready"]?.boolValue == true else { throw Failure("Font-only content rules failed.") }
                let receipt: [String: Any] = [
                    "width": 640, "height": 360, "spread": spread,
                    "differentTimesDiffer": true, "loopBytesIdentical": true,
                    "promiseEvaluation": true, "nativeBridgeAbsent": true,
                    "outOfScopeFileRejected": true, "remoteFontsEnabled": false,
                    "fontOnlyRuleListCompiled": true
                ]
                try JSONSerialization.data(withJSONObject: receipt, options: [.prettyPrinted, .sortedKeys])
                    .write(to: output.appendingPathComponent("receipt.json"), options: .atomic)
                print("PASS: actual DOM PNG/JPEG, exact dimensions, variation, loop, Promise evaluation, image conversion, and file confinement.")
                print("Artifacts: \(output.path)")
                exit(0)
            } catch {
                FileHandle.standardError.write(Data("FAIL: \(error.localizedDescription)\n".utf8))
                exit(1)
            }
        }
        NSApplication.shared.run()
    }

    struct Failure: LocalizedError {
        let message: String
        init(_ message: String) { self.message = message }
        var errorDescription: String? { message }
    }
}
