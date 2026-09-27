import Foundation
import MotionBoardCore
import CoreGraphics
import CoreVideo
import ImageIO
@preconcurrency import AVFoundation

@MainActor
enum VideoExporter {
    static func export(
        project: MotionProject,
        to destination: URL,
        longEdge: Int = 1280,
        samples: Int = 1,
        progress: @escaping (Double) -> Void
    ) async throws {
        let project = try project.validated()
        guard [1, 4].contains(samples) else { throw StudioError.message("Export samples must be 1 or 4.") }
        let schedule = try FrameSchedule(duration: project.duration, fps: project.fps)
        let size = project.aspectRatio.size(longEdge: longEdge)
        let renderer = BoardRenderer()
        try await renderer.configure(project, longEdge: longEdge)
        let temporary = destination.deletingLastPathComponent().appendingPathComponent(".motionboard-\(UUID().uuidString).mp4")
        let writer = try AVAssetWriter(outputURL: temporary, fileType: .mp4)
        var committed = false
        defer {
            if !committed {
                writer.cancelWriting()
                try? FileManager.default.removeItem(at: temporary)
            }
        }
        let input = AVAssetWriterInput(mediaType: .video, outputSettings: [
            AVVideoCodecKey: AVVideoCodecType.h264,
            AVVideoWidthKey: size.width,
            AVVideoHeightKey: size.height,
            AVVideoCompressionPropertiesKey: [
                AVVideoAverageBitRateKey: max(2_000_000, size.width * size.height * 6),
                AVVideoExpectedSourceFrameRateKey: project.fps,
                AVVideoMaxKeyFrameIntervalKey: project.fps * 2
            ]
        ])
        input.expectsMediaDataInRealTime = false
        let adaptor = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: input, sourcePixelBufferAttributes: [
            kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32ARGB,
            kCVPixelBufferWidthKey as String: size.width,
            kCVPixelBufferHeightKey as String: size.height,
            kCVPixelBufferCGImageCompatibilityKey as String: true,
            kCVPixelBufferCGBitmapContextCompatibilityKey as String: true
        ])
        guard writer.canAdd(input) else { throw StudioError.message("H.264 export is unavailable for this format.") }
        writer.add(input)
        guard writer.startWriting() else { throw writer.error ?? StudioError.message("Could not start MP4 export.") }
        writer.startSession(atSourceTime: .zero)
        for (index, time) in schedule.times.enumerated() {
            try Task.checkCancellation()
            let deadline = ContinuousClock.now + .seconds(30)
            while !input.isReadyForMoreMediaData {
                try Task.checkCancellation()
                if writer.status == .failed { throw writer.error ?? StudioError.message("Video encoding failed.") }
                guard ContinuousClock.now < deadline else { throw StudioError.message("The video encoder stopped accepting frames.") }
                try await Task.sleep(for: .milliseconds(5))
            }
            var images: [CGImage] = []
            for sample in 0..<samples {
                let offset = samples == 1 ? 0 : ((Double(sample) + 0.5) / Double(samples) - 0.5) * 0.5 / Double(project.fps)
                let bytes = try await renderer.png(at: time + offset)
                guard let source = CGImageSourceCreateWithData(bytes as CFData, nil),
                      let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else {
                    throw StudioError.message("A rendered frame could not be decoded.")
                }
                images.append(image)
            }
            guard let pool = adaptor.pixelBufferPool else { throw StudioError.message("The video encoder has no frame buffer pool.") }
            var optionalBuffer: CVPixelBuffer?
            guard CVPixelBufferPoolCreatePixelBuffer(kCFAllocatorDefault, pool, &optionalBuffer) == kCVReturnSuccess,
                  let buffer = optionalBuffer else { throw StudioError.message("Could not allocate a video frame.") }
            try draw(images, into: buffer, size: size)
            guard adaptor.append(buffer, withPresentationTime: CMTime(value: Int64(index), timescale: Int32(project.fps))) else {
                throw writer.error ?? StudioError.message("The encoder rejected a video frame.")
            }
            progress(Double(index + 1) / Double(schedule.frameCount))
        }
        input.markAsFinished()
        writer.endSession(atSourceTime: CMTime(seconds: project.duration, preferredTimescale: 600_000))
        await writer.finishWriting()
        try Task.checkCancellation()
        guard writer.status == .completed else { throw writer.error ?? StudioError.message("MP4 finalization failed.") }
        if FileManager.default.fileExists(atPath: destination.path) {
            _ = try FileManager.default.replaceItemAt(destination, withItemAt: temporary)
        } else {
            try FileManager.default.moveItem(at: temporary, to: destination)
        }
        committed = true
    }

    private static func draw(_ images: [CGImage], into buffer: CVPixelBuffer, size: CanvasSize) throws {
        CVPixelBufferLockBaseAddress(buffer, [])
        defer { CVPixelBufferUnlockBaseAddress(buffer, []) }
        guard let context = CGContext(
            data: CVPixelBufferGetBaseAddress(buffer), width: size.width, height: size.height,
            bitsPerComponent: 8, bytesPerRow: CVPixelBufferGetBytesPerRow(buffer),
            space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.noneSkipFirst.rawValue
        ) else { throw StudioError.message("Could not create a video drawing context.") }
        let rect = CGRect(x: 0, y: 0, width: size.width, height: size.height)
        context.setFillColor(CGColor(gray: 0, alpha: 1))
        context.fill(rect)
        context.setBlendMode(images.count > 1 ? .plusLighter : .copy)
        context.setAlpha(1 / CGFloat(images.count))
        for image in images { context.draw(image, in: rect) }
    }
}
