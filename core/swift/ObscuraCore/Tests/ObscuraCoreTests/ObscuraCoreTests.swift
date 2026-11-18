import XCTest
import ObscuraCore

final class ObscuraCoreTests: XCTestCase {
    func testErrorCodesMatchContract() {
        XCTAssertEqual(errorCode(err: .NotAuthenticated), "NOT_AUTHENTICATED")
        XCTAssertEqual(errorMessage(err: .NotAuthenticated), "Not authenticated")
        XCTAssertEqual(errorCode(err: .InvalidFriendCode), "INVALID_FRIEND_CODE")
        XCTAssertEqual(errorCode(err: .NotPrimary), "NOT_PRIMARY")
        XCTAssertEqual(errorMessage(err: .NotPrimary), "Only the primary device can do this")
        XCTAssertEqual(errorCode(err: .DatabaseUndecryptable(reason: "bad key")), "STORAGE_ERROR")
        XCTAssertEqual(errorMessage(err: .DatabaseUndecryptable(reason: "bad key")), "bad key")
        XCTAssertEqual(errorCode(err: .StorageFailed(reason: "disk full")), "STORAGE_ERROR")
    }
}
