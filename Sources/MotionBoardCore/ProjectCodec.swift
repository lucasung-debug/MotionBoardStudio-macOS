import Foundation

public enum ProjectCodec {
    public static func encode(_ project: MotionProject) throws -> Data {
        let validated = try project.validated()
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
        return try encoder.encode(validated)
    }

    public static func decode(_ data: Data) throws -> MotionProject {
        let project = try JSONDecoder().decode(MotionProject.self, from: data)
        return try project.validated()
    }
}
