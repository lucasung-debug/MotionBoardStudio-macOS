import Foundation

enum JSONValue: Codable, Sendable, Equatable {
    case null, bool(Bool), number(Double), string(String), array([JSONValue]), object([String: JSONValue])

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() { self = .null }
        else if let value = try? container.decode(Bool.self) { self = .bool(value) }
        else if let value = try? container.decode(Double.self) { self = .number(value) }
        else if let value = try? container.decode(String.self) { self = .string(value) }
        else if let value = try? container.decode([JSONValue].self) { self = .array(value) }
        else { self = .object(try container.decode([String: JSONValue].self)) }
    }
    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .null: try container.encodeNil()
        case .bool(let value): try container.encode(value)
        case .number(let value): try container.encode(value)
        case .string(let value): try container.encode(value)
        case .array(let value): try container.encode(value)
        case .object(let value): try container.encode(value)
        }
    }
    init(any: Any) throws {
        let data = try JSONSerialization.data(withJSONObject: any, options: [.fragmentsAllowed])
        self = try JSONDecoder().decode(Self.self, from: data)
    }
    var foundationValue: Any {
        switch self {
        case .null: return NSNull()
        case .bool(let value): return value
        case .number(let value): return value
        case .string(let value): return value
        case .array(let value): return value.map(\.foundationValue)
        case .object(let value): return value.mapValues(\.foundationValue)
        }
    }
    var stringValue: String? { if case .string(let value) = self { return value }; return nil }
    var doubleValue: Double? { if case .number(let value) = self { return value }; return nil }
    var boolValue: Bool? { if case .bool(let value) = self { return value }; return nil }
    var objectValue: [String: JSONValue]? { if case .object(let value) = self { return value }; return nil }
    var arrayValue: [JSONValue]? { if case .array(let value) = self { return value }; return nil }
    subscript(_ key: String) -> JSONValue { objectValue?[key] ?? .null }
    func encodedString() throws -> String { String(decoding: try JSONEncoder().encode(self), as: UTF8.self) }
}

struct StudioError: LocalizedError, Sendable {
    let message: String
    var errorDescription: String? { message }
    init(_ message: String) { self.message = message }
}

enum StudioPaths {
    static var sourceRoot: URL { Bundle.module.url(forResource: "MotionBoardStudio-0.3.2", withExtension: nil)! }
    static var runtimeRoot: URL { Bundle.module.url(forResource: "Runtime", withExtension: nil)! }
    static var userData: URL {
        FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("MotionBoardStudio", isDirectory: true)
    }
    static func isInside(_ file: URL, roots: [URL]) -> Bool {
        let resolved = file.standardizedFileURL.resolvingSymlinksInPath().path
        return roots.contains {
            let root = $0.standardizedFileURL.resolvingSymlinksInPath().path
            return resolved == root || resolved.hasPrefix(root + "/")
        }
    }
}
