import Foundation
import Security

struct StudioVault {
    let service: String
    init(service: String = "io.github.lucasung-debug.motionboardstudio.accounts") { self.service = service }

    private func query(_ account: String) throws -> [CFString: Any] {
        guard ["chatgpt", "claude"].contains(account) else { throw StudioError("알 수 없는 계정 종류입니다.") }
        return [kSecClass: kSecClassGenericPassword, kSecAttrService: service, kSecAttrAccount: account]
    }
    func read(_ account: String) throws -> String? {
        var fields = try query(account)
        fields[kSecMatchLimit] = kSecMatchLimitOne
        fields[kSecReturnData] = true
        var result: CFTypeRef?
        let status = SecItemCopyMatching(fields as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = result as? Data,
              let value = String(data: data, encoding: .utf8) else {
            throw StudioError("키체인에서 앱 계정을 읽지 못했습니다 (\(status)).")
        }
        return value
    }
    func write(_ account: String, value: String) throws {
        guard value.utf8.count <= 131_072 else { throw StudioError("계정 응답이 너무 큽니다.") }
        let fields = try query(account)
        let data = Data(value.utf8)
        var status = SecItemUpdate(fields as CFDictionary, [kSecValueData: data] as CFDictionary)
        if status == errSecItemNotFound {
            var add = fields
            add[kSecValueData] = data
            add[kSecAttrAccessible] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
            status = SecItemAdd(add as CFDictionary, nil)
        }
        guard status == errSecSuccess else { throw StudioError("키체인에 앱 계정을 저장하지 못했습니다 (\(status)).") }
    }
    func delete(_ account: String) throws {
        let status = SecItemDelete(try query(account) as CFDictionary)
        guard [errSecSuccess, errSecItemNotFound].contains(status) else {
            throw StudioError("키체인에서 앱 계정을 제거하지 못했습니다 (\(status)).")
        }
    }
}
