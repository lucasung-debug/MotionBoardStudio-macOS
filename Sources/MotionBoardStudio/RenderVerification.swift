import AppKit
import CryptoKit
import Foundation
import ImageIO
import MotionBoardCore
@preconcurrency import AVFoundation

@MainActor
enum RenderVerification {
    static func run(arguments: [String]) async -> Int32 {
        do {
            guard let option = arguments.firstIndex(of: "--output"), arguments.indices.contains(option + 1) else {
                throw StudioError.message("Usage: MotionBoardStudio --verify-render --output <new-directory>")
            }
            let directory = URL(fileURLWithPath: arguments[option + 1], isDirectory: true)
            guard !FileManager.default.fileExists(atPath: directory.path) else {
                throw StudioError.message("Verification output must be a new directory.")
            }
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            var project = MotionProject.example
            project.title = "Motion studies · 모션 스터디"
            project.tiles[0].title = "한글 타이포그래피"
            project.tiles[0].detail = "함께 움직이는 열여섯 장면"
            let renderer = BoardRenderer()
            var dimensions: [[String: Any]] = []
            for aspect in AspectRatio.allCases {
                project.aspectRatio = aspect
                try await renderer.configure(project, longEdge: 1280)
                let png = try await renderer.png(at: 1.25)
                let loop = try await renderer.png(at: 1.25 + project.duration)
                guard png == loop else { throw StudioError.message("Loop determinism failed for \(aspect.rawValue).") }
                let changed = try await renderer.png(at: 3.25)
                guard png != changed else { throw StudioError.message("Motion did not change across distinct times.") }
                guard let imageSource = CGImageSourceCreateWithData(png as CFData, nil),
                      let image = CGImageSourceCreateImageAtIndex(imageSource, 0, nil) else {
                    throw StudioError.message("PNG verification could not decode the rendered image.")
                }
                let expected = aspect.size(longEdge: 1280)
                guard image.width == expected.width, image.height == expected.height else { throw StudioError.message("PNG dimensions did not match the requested canvas.") }
                try png.write(to: directory.appendingPathComponent("board-\(aspect.rawValue).png"))
                dimensions.append(["aspect": aspect.rawValue, "width": image.width, "height": image.height, "loopByteIdentical": true])
            }
            project.aspectRatio = .landscape
            try ProjectCodec.encode(project).write(to: directory.appendingPathComponent("example.json"))
            try BoardDocument.html(project: project, controls: true).write(to: directory.appendingPathComponent("board.html"), atomically: true, encoding: .utf8)
            project.duration = 2
            project.fps = 24
            let video = directory.appendingPathComponent("verification.mp4")
            try await VideoExporter.export(project: project, to: video, longEdge: 480, samples: 1) { _ in }
            let asset = AVURLAsset(url: video)
            let duration = try await asset.load(.duration)
            let tracks = try await asset.loadTracks(withMediaType: .video)
            guard let track = tracks.first else { throw StudioError.message("MP4 has no video track.") }
            let naturalSize = try await track.load(.naturalSize)
            let fps = try await track.load(.nominalFrameRate)
            let reader = try AVAssetReader(asset: asset)
            // Decode to observe presentation time after the container's edit-list mapping.
            // Compressed samples can include codec priming and non-display marker buffers.
            let output = AVAssetReaderTrackOutput(track: track, outputSettings: [
                kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA
            ])
            reader.add(output)
            guard reader.startReading() else { throw reader.error ?? StudioError.message("Could not read exported MP4.") }
            var count = 0
            var times: [Double] = []
            while let sample = output.copyNextSampleBuffer() {
                let samples = CMSampleBufferGetNumSamples(sample)
                count += samples
                for index in 0..<samples {
                    var timing = CMSampleTimingInfo()
                    guard CMSampleBufferGetSampleTimingInfo(sample, at: index, timingInfoOut: &timing) == noErr else {
                        throw StudioError.message("Could not inspect a video sample timestamp.")
                    }
                    times.append(CMTimeGetSeconds(timing.presentationTimeStamp))
                }
            }
            let schedule = try FrameSchedule(duration: 2, fps: 24)
            let sortedTimes = times.sorted()
            guard reader.status == .completed, count == schedule.frameCount,
                  abs(CMTimeGetSeconds(duration) - 2) < 0.002,
                  Int(naturalSize.width) == 480, Int(naturalSize.height) == 270,
                  abs(fps - 24) < 0.01,
                  zip(sortedTimes, schedule.times).allSatisfy({ abs($0 - $1) < 0.0001 }) else {
                throw StudioError.message("MP4 verification failed: reader=\(reader.status.rawValue), frames=\(count), duration=\(CMTimeGetSeconds(duration)), size=\(naturalSize), fps=\(fps), firstPTS=\(sortedTimes.prefix(4)).")
            }
            let generator = AVAssetImageGenerator(asset: asset)
            generator.requestedTimeToleranceBefore = .zero
            generator.requestedTimeToleranceAfter = .zero
            let decodedFrame = try await generator.image(at: CMTime(seconds: 1.25, preferredTimescale: 600))
            if let png = NSBitmapImageRep(cgImage: decodedFrame.image).representation(using: .png, properties: [:]) {
                try png.write(to: directory.appendingPathComponent("decoded-video-frame.png"))
            }
            // Cancellation must not replace an existing destination or leave a partial MP4.
            let canceledDestination = directory.appendingPathComponent("cancel-preserves-existing.mp4")
            let sentinel = Data("existing destination sentinel".utf8)
            try sentinel.write(to: canceledDestination)
            let canceled = Task { @MainActor in
                try await VideoExporter.export(project: project, to: canceledDestination, longEdge: 480) { _ in }
            }
            canceled.cancel()
            do {
                try await canceled.value
                throw StudioError.message("Canceled export unexpectedly succeeded.")
            } catch is CancellationError {}
            guard try Data(contentsOf: canceledDestination) == sentinel else { throw StudioError.message("Cancellation changed an existing destination.") }
            var activeCancellation: Task<Void, Error>?
            var renderedBeforeCancel = false
            activeCancellation = Task { @MainActor in
                try await VideoExporter.export(project: project, to: canceledDestination, longEdge: 480) { value in
                    if value > 0 {
                        renderedBeforeCancel = true
                        activeCancellation?.cancel()
                    }
                }
            }
            do {
                try await activeCancellation?.value
                throw StudioError.message("In-flight canceled export unexpectedly succeeded.")
            } catch is CancellationError {}
            guard renderedBeforeCancel, try Data(contentsOf: canceledDestination) == sentinel else {
                throw StudioError.message("In-flight cancellation did not preserve the existing destination.")
            }
            try FileManager.default.removeItem(at: canceledDestination)
            var fractional = project
            fractional.duration = 2.01
            fractional.tiles = [project.tiles[0]]
            let fractionalVideo = directory.appendingPathComponent("fractional-blur.mp4")
            try await VideoExporter.export(project: fractional, to: fractionalVideo, longEdge: 240, samples: 4) { _ in }
            let fractionalAsset = AVURLAsset(url: fractionalVideo)
            let fractionalDuration = try await fractionalAsset.load(.duration)
            guard abs(CMTimeGetSeconds(fractionalDuration) - 2.01) < 0.002 else {
                throw StudioError.message("Fractional project duration changed during export.")
            }
            let names = try FileManager.default.contentsOfDirectory(atPath: directory.path)
            guard !names.contains(where: { $0.hasPrefix(".motionboard-") }) else { throw StudioError.message("Canceled export left a temporary file.") }
            let receipt: [String: Any] = [
                "checkedAt": ISO8601DateFormatter().string(from: Date()),
                "runtime": "Native macOS WKWebView Canvas and AVFoundation; no provider requests",
                "pngChecks": dimensions,
                "video": ["width": 480, "height": 270, "fps": fps, "frames": count, "durationSeconds": CMTimeGetSeconds(duration), "presentationTimestampsMatch": true],
                "cancellationPreservesExistingDestination": true,
                "inFlightCancellationAfterFirstFrame": true,
                "fractionalDurationAndFourSampleBlur": true,
                "videoSHA256": SHA256.hash(data: try Data(contentsOf: video)).map { String(format: "%02x", $0) }.joined(),
                "limits": ["This is a synthetic offline board, not parity with the Windows application.", "Live provider integration, audio, sustained 1080p60 performance, and manual native UI acceptance are not verified by this command."]
            ]
            try JSONSerialization.data(withJSONObject: receipt, options: [.prettyPrinted, .sortedKeys]).write(to: directory.appendingPathComponent("receipt.json"))
            print("PASS: three canvas ratios, Korean text fixture, deterministic loop, 48-frame H.264 export, timestamps, and cancellation.")
            print("Artifacts: \(directory.path)")
            return 0
        } catch {
            fputs("Verification failed: \(error.localizedDescription)\n", stderr)
            return 1
        }
    }
}
