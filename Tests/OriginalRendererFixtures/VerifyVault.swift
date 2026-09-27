// Standalone verification harness; compile with JSONValue.swift and StudioVault.swift.
// It uses synthetic values in a new service namespace and never opens app accounts.
import Foundation

extension Bundle { static var module: Bundle { .main } }

@main
enum VerifyOriginalVault {
    private struct Failure: LocalizedError {
        let message: String
        init(_ message: String) { self.message = message }
        var errorDescription: String? { message }
    }

    static func main() {
        let service = "io.github.lucasung-debug.motionboardstudio.verification.vault.\(UUID().uuidString)"
        let vault = StudioVault(service: service)
        let accounts = ["chatgpt", "claude", "grok-video", "kling-video"]
        let rejectedAccounts = ["", "unknown", "grok", "kling", "../chatgpt"]
        var ownedAccounts = Set<String>()
        var failure: Error?

        func require(_ condition: @autoclosure () throws -> Bool, _ message: String) throws {
            guard try condition() else { throw Failure(message) }
        }
        func expectRejection(_ operation: () throws -> Void, _ message: String) throws {
            var rejected = false
            do { try operation() } catch is StudioError { rejected = true }
            try require(rejected, message)
        }

        do {
            for account in accounts {
                try require(try vault.read(account) == nil, "Isolated account unexpectedly existed: \(account)")
                try vault.write(account, value: "synthetic-first-value-\(account)")
                ownedAccounts.insert(account)
            }
            for account in accounts {
                try require(try vault.read(account) == "synthetic-first-value-\(account)", "Created value mismatch: \(account)")
                try vault.write(account, value: "synthetic-updated-value-\(account)")
                try require(try vault.read(account) == "synthetic-updated-value-\(account)", "Updated value mismatch: \(account)")
                try expectRejection({ try vault.write(account, value: String(repeating: "x", count: 131_073)) }, "Oversized value was accepted: \(account)")
                try require(try vault.read(account) == "synthetic-updated-value-\(account)", "Rejected write changed an existing value: \(account)")
            }
            for account in rejectedAccounts {
                try expectRejection({ _ = try vault.read(account) }, "Unknown account read was accepted.")
                try expectRejection({ try vault.write(account, value: "synthetic-rejected-value") }, "Unknown account write was accepted.")
                try expectRejection({ try vault.delete(account) }, "Unknown account deletion was accepted.")
            }
            // All allowed accounts remain separate after writes and rejected calls.
            for account in accounts {
                try require(try vault.read(account) == "synthetic-updated-value-\(account)", "Account isolation failed: \(account)")
                try vault.delete(account)
                try require(try vault.read(account) == nil, "Deleted account still exists: \(account)")
                try vault.delete(account)
                ownedAccounts.remove(account)
            }
        } catch { failure = error }

        // On failure, remove only entries successfully created by this invocation.
        // There is no service-wide or default-service delete query.
        var cleanupFailures = 0
        for account in ownedAccounts {
            do {
                try vault.delete(account)
                try require(try vault.read(account) == nil, "Cleanup verification failed: \(account)")
            } catch { cleanupFailures += 1 }
        }
        if let failure {
            FileHandle.standardError.write(Data("FAIL: \(failure.localizedDescription); cleanup failures: \(cleanupFailures)\n".utf8))
            exit(1)
        }
        guard cleanupFailures == 0 else {
            FileHandle.standardError.write(Data("FAIL: Isolated Keychain cleanup did not complete.\n".utf8))
            exit(1)
        }
        let receipt: [String: Any] = [
            "ok": true, "isolatedService": service, "syntheticCredentialsOnly": true,
            "accounts": accounts, "createReadUpdateDelete": true, "accountIsolation": true,
            "oversizedWritesRejectedWithoutMutation": true, "unknownAccountsRejected": rejectedAccounts.count,
            "idempotentDelete": true, "allCreatedItemsRemoved": true
        ]
        do {
            let data = try JSONSerialization.data(withJSONObject: receipt, options: [.prettyPrinted, .sortedKeys])
            FileHandle.standardOutput.write(data + Data("\n".utf8))
        } catch {
            FileHandle.standardError.write(Data("FAIL: Could not encode verification receipt.\n".utf8))
            exit(1)
        }
    }
}
