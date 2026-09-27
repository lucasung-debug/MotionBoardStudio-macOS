import Foundation

public struct CanvasSize: Equatable, Sendable {
    public let width: Int
    public let height: Int

    public init(width: Int, height: Int) {
        self.width = width
        self.height = height
    }
}

public enum AspectRatio: String, Codable, CaseIterable, Sendable, Identifiable {
    case landscape
    case square
    case portrait

    public var id: String { rawValue }

    public var label: String {
        switch self {
        case .landscape: "Landscape · 16:9"
        case .square: "Square · 1:1"
        case .portrait: "Portrait · 9:16"
        }
    }

    /// Produces positive even dimensions suitable for an encoded video frame.
    /// The long edge is rounded down; the short edge is rounded to the nearest
    /// even pixel. Integer arithmetic avoids overflow for unusually large inputs.
    public func size(longEdge: Int) -> CanvasSize {
        let requested = max(2, longEdge)
        let evenLongEdge = requested - requested % 2
        let halfLongEdge = evenLongEdge / 2
        let halfShortEdge = max(
            1,
            (halfLongEdge / 16) * 9 + ((halfLongEdge % 16) * 9 + 8) / 16
        )
        let shortEdge = halfShortEdge * 2

        return switch self {
        case .landscape: CanvasSize(width: evenLongEdge, height: shortEdge)
        case .square: CanvasSize(width: evenLongEdge, height: evenLongEdge)
        case .portrait: CanvasSize(width: shortEdge, height: evenLongEdge)
        }
    }
}
