import Foundation
import XCTest
@testable import ObscuraKit

final class SubmissionResultsTests: XCTestCase {
    private func submission(_ value: UInt8) -> Obscura_V1_SendMessageRequest.Submission {
        var submission = Obscura_V1_SendMessageRequest.Submission()
        submission.deviceID = Data(repeating: value, count: 16)
        submission.message = Data([value])
        return submission
    }

    func testPartialRejectionIsScopedToItsSubmission() throws {
        let a = submission(1)
        let b = submission(2)
        var response = Obscura_V1_SendMessageResponse()
        response.invalidDeviceIds = [a.deviceID]
        let outcome = try submitOutcome(userId: "user", submissions: [a, b], response: response)
        let results = outcome.submitted.map(\.result)
        XCTAssertEqual(results.map(\.status), [.rejected, .accepted])
        XCTAssertEqual(outcome.submitted.map(\.invalidDevice), [true, false])
        XCTAssertEqual(outcome.missingDeviceIds, [])
        XCTAssertEqual(results.first?.error, "Device not found")
        XCTAssertNil(results.last?.error)
        XCTAssertEqual(results.last?.deviceId, "02020202-0202-0202-0202-020202020202")
    }

    func testADeviceMismatchNamesTheMissingDevicesOfTheAddressedUser() throws {
        let userId = "03030303-0303-0303-0303-030303030303"
        let a = submission(1)
        var mismatch = Obscura_V1_SendMessageResponse.DeviceMismatch()
        mismatch.userID = Data(repeating: 3, count: 16)
        mismatch.missingDeviceIds = [Data(repeating: 4, count: 16)]
        var response = Obscura_V1_SendMessageResponse()
        response.deviceMismatches = [mismatch]

        let outcome = try submitOutcome(userId: userId, submissions: [a], response: response)

        XCTAssertEqual(outcome.submitted.map(\.invalidDevice), [false])
        XCTAssertEqual(outcome.submitted.map(\.result.status), [.rejected])
        XCTAssertEqual(outcome.missingDeviceIds, ["04040404-0404-0404-0404-040404040404"])
        XCTAssertThrowsError(try submitOutcome(userId: "another-user", submissions: [a], response: response))
        response.deviceMismatches[0].missingDeviceIds = [Data([1])]
        XCTAssertThrowsError(try submitOutcome(userId: userId, submissions: [a], response: response))
    }

    func testUnknownAndDuplicateResponseIDsAreNotSuccess() throws {
        let a = submission(1)
        var response = Obscura_V1_SendMessageResponse()
        response.invalidDeviceIds = [submission(2).deviceID]
        XCTAssertThrowsError(try submitOutcome(userId: "user", submissions: [a], response: response))
        response.invalidDeviceIds = [a.deviceID, a.deviceID]
        XCTAssertThrowsError(try submitOutcome(userId: "user", submissions: [a], response: response))
    }

    func testScopedSubmitReadsHTTP200FailuresAndMalformedResponses() async throws {
        XCTAssertTrue(URLProtocol.registerClass(SubmissionResponseProtocol.self))
        defer { URLProtocol.unregisterClass(SubmissionResponseProtocol.self) }
        let api = try APIClient(baseURL: "https://submission-unit.invalid")
        let messenger = Messenger(api: api, store: try signalStoreWithIdentity())
        let a = submission(1)
        let rejected = await messenger.submit(userId: "05050505-0505-0505-0505-050505050505", submissions: [a]).submitted.map(\.result)
        XCTAssertEqual(rejected.map(\.status), [.rejected])
        let malformed = await messenger.submit(userId: "05050505-0505-0505-0505-050505050505", submissions: [submission(2)]).submitted.map(\.result)
        XCTAssertEqual(malformed.map(\.status), [.unknown])
        XCTAssertNotNil(malformed.first?.error)
    }

    func testDefinitiveHTTPRejectionsAreNotUnknownButServerAndTransportFailuresAre() async throws {
        XCTAssertTrue(URLProtocol.registerClass(SubmissionFailureProtocol.self))
        defer { URLProtocol.unregisterClass(SubmissionFailureProtocol.self) }
        let messenger = Messenger(api: try APIClient(baseURL: "https://submission-failure.invalid"),
                                  store: try signalStoreWithIdentity())
        for status in [400, 401, 403, 413, 500] {
            SubmissionFailureProtocol.status.withLock { $0 = status }
            let results = await messenger.submit(userId: "05050505-0505-0505-0505-050505050505", submissions: [submission(1), submission(2)]).submitted.map(\.result)
            XCTAssertEqual(results.map(\.status), Array(repeating: [400, 413].contains(status) ? .rejected : .unknown,
                                                         count: 2), "HTTP \(status)")
            // A 401 with a rejected refresh signs out instead of describing the message.
            let described = status == 401 ? "\(ObscuraError.notAuthenticated)" : "\(status)"
            XCTAssertTrue(results.allSatisfy { $0.error?.contains(described) == true }, "HTTP \(status)")
        }
        SubmissionFailureProtocol.status.withLock { $0 = nil }
        let transport = await messenger.submit(userId: "05050505-0505-0505-0505-050505050505", submissions: [submission(1)]).submitted.map(\.result)
        XCTAssertEqual(transport.map(\.status), [.unknown], "a lost response does not prove non-acceptance")
    }
}

private final class SubmissionFailureProtocol: URLProtocol {
    static let status = Locked<Int?>(nil)
    override class func canInit(with request: URLRequest) -> Bool { request.url?.host == "submission-failure.invalid" }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        guard let status = Self.status.withLock({ $0 }) else {
            client?.urlProtocol(self, didFailWithError: URLError(.networkConnectionLost))
            return
        }
        client?.urlProtocol(self, didReceive: HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil,
                                                            headerFields: nil)!, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data("pre-processing failure \(status)".utf8))
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}

private final class SubmissionResponseProtocol: URLProtocol {
    override class func canInit(with request: URLRequest) -> Bool {
        request.url?.host == "submission-unit.invalid"
    }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        let response = HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil,
                                       headerFields: ["Content-Type": "application/x-protobuf"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        // Invalid device ID for device 1; submission 2 receives an unrelated ID and must remain uncertain.
        client?.urlProtocol(self, didLoad: Data([0x0a, 0x10] + Array(repeating: UInt8(1), count: 16)))
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}
