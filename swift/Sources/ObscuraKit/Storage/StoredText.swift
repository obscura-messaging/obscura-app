import Foundation
import GRDB

/// GRDB binds and reads `String` as a NUL-terminated C string, which would truncate text the kit does
/// not control. Such text is stored as its exact UTF-8 bytes in BLOB columns.
extension String {
    var storedText: Data { Data(utf8) }
}

extension Row {
    func text(_ column: String) throws -> String {
        guard let text = try optionalText(column) else { throw DatabaseError(message: "\(column) is null") }
        return text
    }

    func optionalText(_ column: String) throws -> String? {
        guard let bytes = self[column] as Data? else { return nil }
        guard let text = String(data: bytes, encoding: .utf8) else { throw DatabaseError(message: "\(column) is not UTF-8") }
        return text
    }
}
