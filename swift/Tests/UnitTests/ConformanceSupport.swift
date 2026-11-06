import Foundation
import XCTest

/// Loads the repository's language-neutral client conformance vectors so the
/// Swift and Kotlin implementations run the same cases.
///
/// The path is derived from this source file's location, so it is independent of
/// the test runner's working directory.
enum ConformanceVectors {

    /// Package root: <root>/Tests/UnitTests/ConformanceSupport.swift → up 3.
    static let packageRoot: URL = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent()   // UnitTests
        .deletingLastPathComponent()   // Tests
        .deletingLastPathComponent()   // <package root>
    static let repositoryRoot = packageRoot.deletingLastPathComponent()

    /// Load and parse a vector file as a JSON object.
    static func load(
        _ name: String,
        file: StaticString = #filePath,
        line: UInt = #line
    ) throws -> [String: Any] {
        let url = repositoryRoot.appendingPathComponent("protocol/conformance/\(name)")
        guard let data = try? Data(contentsOf: url) else {
            XCTFail(
                "conformance vector '\(name)' not found at \(url.path). " +
                "Is protocol/conformance present in the repository checkout?",
                file: file, line: line
            )
            throw NSError(domain: "conformance", code: 1)
        }
        guard let obj = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            XCTFail("conformance vector '\(name)' is not a JSON object", file: file, line: line)
            throw NSError(domain: "conformance", code: 2)
        }
        return obj
    }
}

/// Coerce a JSON-parsed value (NSNumber) to UInt64.
func conformanceUInt64(_ any: Any?) -> UInt64 {
    (any as? NSNumber)?.uint64Value ?? 0
}
