import Foundation

public struct FrameSchedule: Equatable, Sendable {
    public let frameCount: Int
    public let times: [Double]

    /// Samples [0, duration) at a fixed rate. The end point is omitted so a
    /// looping animation does not export the same pose twice at its seam.
    public init(duration: Double, fps: Int) throws {
        try MotionProject.validateTiming(duration: duration, fps: fps)

        let rate = Double(fps)
        let upperBound = Int(ceil(duration * rate))
        var sampledTimes: [Double] = []
        sampledTimes.reserveCapacity(upperBound)
        // Inspect one extra candidate to handle floating-point multiplication
        // at an exact frame boundary. Division defines every sample time.
        for frame in 0...upperBound {
            let time = Double(frame) / rate
            guard time < duration else { break }
            sampledTimes.append(time)
        }
        frameCount = sampledTimes.count
        times = sampledTimes
    }
}
