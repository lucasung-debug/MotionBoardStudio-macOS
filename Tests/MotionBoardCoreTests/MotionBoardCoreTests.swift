import Foundation
import Testing
@testable import MotionBoardCore

@Suite("Motion project files")
struct ProjectCodecTests {
    @Test("The original example covers every effect and survives a file roundtrip")
    func exampleRoundtrip() throws {
        let project = MotionProject.example
        #expect(project.schemaVersion == 1)
        #expect(project.duration == 8)
        #expect(project.fps == 30)
        #expect(project.aspectRatio == .landscape)
        #expect(project.tiles.count == 16)
        #expect(Set(project.tiles.map(\.effect)) == Set(EffectKind.allCases))
        #expect(try ProjectCodec.decode(ProjectCodec.encode(project)) == project)
    }

    @Test("Encoding preserves valid user text and produces stable bytes")
    func textIsPreserved() throws {
        var project = MotionProject.example
        project.title = "  타이포그래피 연구  "
        project.tiles[0].detail = "First line\nSecond line: <&> / 한글"
        project.tiles[0].accent = "#abcdef"
        let data = try ProjectCodec.encode(project)
        #expect(try ProjectCodec.encode(project) == data)
        #expect(try ProjectCodec.decode(data) == project)
    }

    @Test("Malformed or structurally incomplete JSON is rejected", arguments: [
        "", "{", "[]", "null", "{}", "{\"schemaVersion\":1,\"duration\":\"eight\"}"
    ])
    func malformedDecode(json: String) {
        #expect(throws: (any Error).self) {
            try ProjectCodec.decode(Data(json.utf8))
        }
    }

    @Test("An unsupported schema is rejected on both file paths")
    func unknownSchema() throws {
        var project = MotionProject.example
        project.schemaVersion = 2
        let raw = try JSONEncoder().encode(project)
        #expect(throws: ProjectValidationError.unsupportedSchema(2)) {
            try ProjectCodec.decode(raw)
        }
        #expect(throws: ProjectValidationError.unsupportedSchema(2)) {
            try ProjectCodec.encode(project)
        }
    }

    @Test("Decoded files must satisfy validation")
    func decodedInvalidProject() throws {
        var project = MotionProject.example
        project.tiles[0].accent = "red"
        let raw = try JSONEncoder().encode(project)
        #expect(throws: ProjectValidationError.invalidAccent(index: 0)) {
            try ProjectCodec.decode(raw)
        }
    }

    @Test("Duplicate tile identifiers are rejected")
    func duplicateIdentifiers() {
        var project = MotionProject.example
        project.tiles[1].id = project.tiles[0].id
        let duplicate = project.tiles[0].id
        #expect(throws: ProjectValidationError.duplicateTileID(duplicate)) {
            try project.validated()
        }
    }

    @Test("Tile count is bounded", arguments: [0, 17])
    func invalidTileCount(count: Int) {
        var project = MotionProject.example
        project.tiles = (0..<count).map { _ in
            MotionTile(title: "Study", detail: "", effect: .reveal, accent: "#123456")
        }
        #expect(throws: ProjectValidationError.invalidTileCount) {
            try project.validated()
        }
    }

    @Test("Text limits reject empty titles and oversized content")
    func textLimits() throws {
        var project = MotionProject.example
        project.title = " \n\t "
        #expect(throws: ProjectValidationError.invalidProjectTitle) { try project.validated() }
        project.title = String(repeating: "A", count: 121)
        #expect(throws: ProjectValidationError.invalidProjectTitle) { try project.validated() }
        project.title = String(repeating: "A", count: 120)
        project.tiles[0].title = "\n"
        #expect(throws: ProjectValidationError.invalidTileTitle(index: 0)) { try project.validated() }
        project.tiles[0].title = String(repeating: "B", count: 61)
        #expect(throws: ProjectValidationError.invalidTileTitle(index: 0)) { try project.validated() }
        project.tiles[0].title = String(repeating: "B", count: 60)
        project.tiles[0].detail = String(repeating: "C", count: 501)
        #expect(throws: ProjectValidationError.invalidTileDetail(index: 0)) { try project.validated() }
        project.tiles[0].detail = String(repeating: "C", count: 500)
        #expect(try project.validated() == project)
    }

    @Test("Accent colors use exactly six ASCII hexadecimal digits", arguments: [
        "123456", "#123", "#12345678", "#12GG56", "#１２３４５６", " #123456", "#123456\n"
    ])
    func invalidAccents(accent: String) {
        var project = MotionProject.example
        project.tiles[0].accent = accent
        #expect(throws: ProjectValidationError.invalidAccent(index: 0)) {
            try project.validated()
        }
    }
}

@Suite("Frame timing")
struct FrameScheduleTests {
    @Test("An eight-second loop contains 240 distinct samples and no repeated endpoint")
    func standardSchedule() throws {
        let schedule = try FrameSchedule(duration: 8, fps: 30)
        #expect(schedule.frameCount == 240)
        #expect(schedule.times.count == 240)
        #expect(schedule.times.first == 0)
        #expect(schedule.times.last == 239.0 / 30)
        #expect(!schedule.times.contains(8))
        #expect(schedule.times == (0..<240).map { Double($0) / 30 })
    }

    @Test("Fractional durations keep only samples before the requested end")
    func fractionalDuration() throws {
        let schedule = try FrameSchedule(duration: 2.01, fps: 24)
        #expect(schedule.frameCount == 49)
        #expect(schedule.times.last == 2)
        #expect(schedule.times.allSatisfy { $0 < 2.01 })
    }

    @Test("Floating-point frame boundaries have no duplicate endpoint", arguments: [24, 30, 60])
    func exactAndAdjacentBoundaries(fps: Int) throws {
        let boundary = 67.0 / Double(fps) + 2
        for duration in [boundary.nextDown, boundary, boundary.nextUp] {
            let schedule = try FrameSchedule(duration: duration, fps: fps)
            #expect(schedule.times.allSatisfy { $0 < duration })
            #expect(Double(schedule.frameCount) / Double(fps) >= duration)
            #expect(schedule.times == (0..<schedule.frameCount).map { Double($0) / Double(fps) })
        }
    }

    @Test("The maximum schedule remains bounded")
    func maximumSchedule() throws {
        let schedule = try FrameSchedule(duration: 30, fps: 60)
        #expect(schedule.frameCount == 1_800)
        #expect(schedule.times.last == 1_799.0 / 60)
    }

    @Test("Unsafe durations are rejected before allocating frames", arguments: [
        -Double.infinity, -1, 0, 1.99, 30.01, Double.infinity, Double.nan
    ])
    func invalidDuration(duration: Double) {
        #expect(throws: ProjectValidationError.invalidDuration) {
            try FrameSchedule(duration: duration, fps: 30)
        }
        var project = MotionProject.example
        project.duration = duration
        #expect(throws: ProjectValidationError.invalidDuration) { try project.validated() }
    }

    @Test("Unsupported frame rates are rejected", arguments: [Int.min, 0, 1, 25, 120, Int.max])
    func invalidFrameRate(fps: Int) {
        #expect(throws: ProjectValidationError.invalidFrameRate) {
            try FrameSchedule(duration: 8, fps: fps)
        }
        var project = MotionProject.example
        project.fps = fps
        #expect(throws: ProjectValidationError.invalidFrameRate) { try project.validated() }
    }
}

@Suite("Canvas dimensions")
struct CanvasSizeTests {
    @Test("Common output dimensions preserve the selected orientation")
    func commonSizes() {
        #expect(AspectRatio.landscape.size(longEdge: 1920) == CanvasSize(width: 1920, height: 1080))
        #expect(AspectRatio.portrait.size(longEdge: 1920) == CanvasSize(width: 1080, height: 1920))
        #expect(AspectRatio.square.size(longEdge: 1080) == CanvasSize(width: 1080, height: 1080))
        #expect(AspectRatio.landscape.size(longEdge: 1080) == CanvasSize(width: 1080, height: 608))
    }

    @Test("Odd and extreme inputs always produce positive even sizes", arguments: [
        Int.min, -1, 0, 1, 2, 3, 1279, 1919, Int.max
    ])
    func evenSizes(longEdge: Int) {
        for ratio in AspectRatio.allCases {
            let size = ratio.size(longEdge: longEdge)
            #expect(size.width >= 2 && size.height >= 2)
            #expect(size.width % 2 == 0 && size.height % 2 == 0)
        }
    }
}
