import Foundation

public enum EffectKind: String, Codable, CaseIterable, Sendable, Identifiable {
    case reveal
    case morph
    case orbit
    case bars
    case wave
    case rings
    case stagger
    case counter
    case spotlight
    case marquee
    case draw
    case stack
    case split
    case bounce
    case grid
    case pulse

    public var id: String { rawValue }

    public var label: String {
        switch self {
        case .reveal: "Reveal"
        case .morph: "Morph"
        case .orbit: "Orbit"
        case .bars: "Bars"
        case .wave: "Wave"
        case .rings: "Rings"
        case .stagger: "Stagger"
        case .counter: "Counter"
        case .spotlight: "Spotlight"
        case .marquee: "Marquee"
        case .draw: "Draw"
        case .stack: "Stack"
        case .split: "Split"
        case .bounce: "Bounce"
        case .grid: "Grid"
        case .pulse: "Pulse"
        }
    }
}

public struct MotionTile: Codable, Equatable, Sendable, Identifiable {
    public var id: UUID
    public var title: String
    public var detail: String
    public var effect: EffectKind
    public var accent: String

    public init(
        id: UUID = UUID(),
        title: String,
        detail: String,
        effect: EffectKind,
        accent: String
    ) {
        self.id = id
        self.title = title
        self.detail = detail
        self.effect = effect
        self.accent = accent
    }
}

public enum ProjectValidationError: Error, Equatable, LocalizedError, Sendable {
    case unsupportedSchema(Int)
    case invalidProjectTitle
    case invalidDuration
    case invalidFrameRate
    case invalidTileCount
    case duplicateTileID(UUID)
    case invalidTileTitle(index: Int)
    case invalidTileDetail(index: Int)
    case invalidAccent(index: Int)

    public var errorDescription: String? {
        switch self {
        case .unsupportedSchema(let version):
            "Project version \(version) is not supported. This app reads version 1."
        case .invalidProjectTitle:
            "Enter a project title between 1 and 120 characters."
        case .invalidDuration:
            "Choose a finite duration between 2 and 30 seconds."
        case .invalidFrameRate:
            "Choose 24, 30, or 60 frames per second."
        case .invalidTileCount:
            "A project must contain between 1 and 16 motion tiles."
        case .duplicateTileID:
            "Each motion tile must have its own identifier."
        case .invalidTileTitle(let index):
            "Tile \(index + 1) needs a title between 1 and 60 characters."
        case .invalidTileDetail(let index):
            "Tile \(index + 1) has a description longer than 500 characters."
        case .invalidAccent(let index):
            "Tile \(index + 1) needs a color in #RRGGBB format."
        }
    }
}

public struct MotionProject: Codable, Equatable, Sendable {
    public var schemaVersion: Int = 1
    public var title: String
    public var duration: Double
    public var fps: Int
    public var aspectRatio: AspectRatio
    public var tiles: [MotionTile]

    public init(
        schemaVersion: Int = 1,
        title: String,
        duration: Double,
        fps: Int,
        aspectRatio: AspectRatio,
        tiles: [MotionTile]
    ) {
        self.schemaVersion = schemaVersion
        self.title = title
        self.duration = duration
        self.fps = fps
        self.aspectRatio = aspectRatio
        self.tiles = tiles
    }

    /// Validates the file contract without changing user-authored text.
    public func validated() throws -> MotionProject {
        guard schemaVersion == 1 else {
            throw ProjectValidationError.unsupportedSchema(schemaVersion)
        }
        guard Self.isTitleValid(title, limit: 120) else {
            throw ProjectValidationError.invalidProjectTitle
        }
        try Self.validateTiming(duration: duration, fps: fps)
        guard (1...16).contains(tiles.count) else {
            throw ProjectValidationError.invalidTileCount
        }

        var identifiers: Set<UUID> = []
        for (index, tile) in tiles.enumerated() {
            guard identifiers.insert(tile.id).inserted else {
                throw ProjectValidationError.duplicateTileID(tile.id)
            }
            guard Self.isTitleValid(tile.title, limit: 60) else {
                throw ProjectValidationError.invalidTileTitle(index: index)
            }
            guard tile.detail.count <= 500 else {
                throw ProjectValidationError.invalidTileDetail(index: index)
            }
            guard Self.isAccentValid(tile.accent) else {
                throw ProjectValidationError.invalidAccent(index: index)
            }
        }
        return self
    }

    static func validateTiming(duration: Double, fps: Int) throws {
        guard duration.isFinite, (2...30).contains(duration) else {
            throw ProjectValidationError.invalidDuration
        }
        guard [24, 30, 60].contains(fps) else {
            throw ProjectValidationError.invalidFrameRate
        }
    }

    private static func isTitleValid(_ title: String, limit: Int) -> Bool {
        !title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && title.count <= limit
    }

    private static func isAccentValid(_ accent: String) -> Bool {
        let bytes = Array(accent.utf8)
        guard bytes.count == 7, bytes.first == 35 else { return false }
        return bytes.dropFirst().allSatisfy {
            (48...57).contains($0) || (65...70).contains($0) || (97...102).contains($0)
        }
    }

    public static var example: MotionProject {
        let studies: [(EffectKind, String, String)] = [
            (.reveal, "Reveal", "A shape appears through a moving edge."),
            (.morph, "Morph", "A soft form changes its silhouette."),
            (.orbit, "Orbit", "Small marks travel around a shared center."),
            (.bars, "Bars", "A row of bars rises in a repeating rhythm."),
            (.wave, "Wave", "A line carries a wave across the frame."),
            (.rings, "Rings", "Concentric outlines expand from the center."),
            (.stagger, "Stagger", "Separate elements arrive one after another."),
            (.counter, "Counter", "A number advances as a timing study."),
            (.spotlight, "Spotlight", "A pool of light moves over a quiet field."),
            (.marquee, "Marquee", "A line of type moves at a steady pace."),
            (.draw, "Draw", "An outline traces its own path."),
            (.stack, "Stack", "Offset cards settle into a layered arrangement."),
            (.split, "Split", "Two halves separate and return to the center."),
            (.bounce, "Bounce", "A single form rises and settles."),
            (.grid, "Grid", "A field of cells changes in a repeating pattern."),
            (.pulse, "Pulse", "A central form grows and softens with each beat.")
        ]
        let accents = ["#FF7555", "#64C8B5", "#FFC857", "#9DA8FF"]
        return MotionProject(
            title: "Motion Study",
            duration: 8,
            fps: 30,
            aspectRatio: .landscape,
            tiles: studies.enumerated().map { index, study in
                MotionTile(
                    title: study.1,
                    detail: study.2,
                    effect: study.0,
                    accent: accents[index % accents.count]
                )
            }
        )
    }
}
