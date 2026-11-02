import Foundation
import XCTest
@testable import ObscuraKit

final class APIClientTests: XCTestCase {
    override func setUp() {
        RetryProtocol.responses.withLock { $0 = [] }
        RetryProtocol.requests.withLock { $0 = [] }
        URLProtocol.registerClass(RetryProtocol.self)
    }

    override func tearDown() {
        URLProtocol.unregisterClass(RetryProtocol.self)
    }

    func testRetryAfterIsClampedToOneToTenSeconds() {
        XCTAssertEqual(APIClient.retryDelay(retryAfter: nil), 1)
        XCTAssertEqual(APIClient.retryDelay(retryAfter: "0"), 1)
        XCTAssertEqual(APIClient.retryDelay(retryAfter: "soon"), 1)
        XCTAssertEqual(APIClient.retryDelay(retryAfter: "3"), 3)
        XCTAssertEqual(APIClient.retryDelay(retryAfter: "120"), 10)
    }

    func testA429OrA503IsRetriedUntilItSucceeds() async throws {
        RetryProtocol.responses.withLock { $0 = [(429, "0"), (503, nil), (200, nil)] }
        let api = try APIClient(baseURL: "https://\(RetryProtocol.host)")

        let ticket = try await api.fetchGatewayTicket()

        XCTAssertEqual(ticket, "t")
        XCTAssertEqual(RetryProtocol.responses.withLock { $0.count }, 0)
    }

    func testRetriesStopAfterTwoAndTheErrorCarriesStatusAndBody() async throws {
        RetryProtocol.responses.withLock { $0 = [(429, nil), (429, nil), (429, nil), (200, nil)] }
        let api = try APIClient(baseURL: "https://\(RetryProtocol.host)")

        do {
            _ = try await api.fetchGatewayTicket()
            XCTFail("a third 429 must surface")
        } catch {
            XCTAssertEqual(error as? ObscuraError, .http(status: 429, body: "slow down"))
        }
        XCTAssertEqual(RetryProtocol.responses.withLock { $0.count }, 1)
    }

    func testOtherFailuresAreNotRetried() async throws {
        RetryProtocol.responses.withLock { $0 = [(500, nil), (200, nil)] }
        let api = try APIClient(baseURL: "https://\(RetryProtocol.host)")

        do {
            _ = try await api.fetchGatewayTicket()
            XCTFail("a 500 must surface")
        } catch {
            XCTAssertEqual((error as? ObscuraError)?.code, "HTTP_ERROR")
        }
        XCTAssertEqual(RetryProtocol.responses.withLock { $0.count }, 1)
    }

    func testAnExistingDevicesWrongPasswordNeedsOnlyOneLoginRequest() async throws {
        RetryProtocol.responses.withLock { $0 = [(401, nil), (401, nil)] }
        let client = try makeClient(apiURL: "https://\(RetryProtocol.host)")
        try client.signalStore.install(SignalKeys.generate())
        let deviceId = UUID().uuidString.lowercased()
        try await client.db.write { try DeviceStore.setLocalDevice(deviceId, primaryDeviceId: deviceId, in: $0) }

        let scenario = try await client.login("known-account", "incorrect-password")

        XCTAssertEqual(scenario, .invalidCredentials)
        XCTAssertEqual(client.authState, .loggedOut)
        let requests = RetryProtocol.requests.withLock { $0 }
        XCTAssertEqual(requests.count, 1, "401 already definitively rejects the password")
        let body = try XCTUnwrap(requests.first?.httpBody)
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: body) as? [String: String])
        XCTAssertEqual(json["deviceId"], deviceId)
    }

    func testMessageRetriesKeepTheSameBodyAndIdempotencyKeyAndEachSubmissionGetsAFreshKey() async throws {
        RetryProtocol.responses.withLock { $0 = [(429, "0"), (503, "0"), (200, nil), (200, nil)] }
        let api = try APIClient(baseURL: "https://\(RetryProtocol.host)")
        var submission = Obscura_V1_SendMessageRequest.Submission()
        submission.deviceID = withUnsafeBytes(of: UUID().uuid) { Data($0) }
        submission.message = Data([1, 2, 3])
        var recipient = Obscura_V1_SendMessageRequest.Recipient()
        recipient.userID = withUnsafeBytes(of: UUID().uuid) { Data($0) }
        recipient.submissions = [submission]
        var message = Obscura_V1_SendMessageRequest()
        message.recipients = [recipient]
        let body = try message.serializedData()

        _ = try await api.sendMessage(body)
        _ = try await api.sendMessage(body)

        let requests = RetryProtocol.requests.withLock { $0 }
        XCTAssertEqual(requests.count, 4)
        XCTAssertTrue(requests.allSatisfy { $0.httpBody == body })
        let keys = requests.compactMap { $0.value(forHTTPHeaderField: "Idempotency-Key") }
        XCTAssertEqual(keys.count, 4)
        XCTAssertEqual(Set(keys.prefix(3)).count, 1, "retries of one submission keep its key")
        XCTAssertNotEqual(keys[3], keys[0], "a new submission gets a new key")
        XCTAssertTrue(keys.allSatisfy { UUID(uuidString: $0) != nil })
    }

    func testCleartextIsRefusedExceptOnLoopback() {
        XCTAssertThrowsError(try APIClient(baseURL: "http://example.com"))
        XCTAssertNoThrow(try APIClient(baseURL: "http://localhost:3000"))
        XCTAssertNoThrow(try APIClient(baseURL: "http://127.0.0.1:3000"))
        XCTAssertNoThrow(try APIClient(baseURL: "http://[::1]:3000"))
        XCTAssertNoThrow(try APIClient(baseURL: "HTTPS://EXAMPLE.COM"))
        for url in ["http://localhost.evil.test", "http://127.0.0.1.evil.test", "http://localhost@evil.test",
                    "http://127.0.0.10", "https://", "ftp://localhost", "https://user:pass@example.com"] {
            XCTAssertThrowsError(try APIClient(baseURL: url), url)
        }
    }
}

private final class RetryProtocol: URLProtocol {
    static let host = "retry-unit.invalid"
    static let responses = Locked<[(status: Int, retryAfter: String?)]>([])
    static let requests = Locked<[URLRequest]>([])

    override class func canInit(with request: URLRequest) -> Bool { request.url?.host == host }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        var captured = request
        if captured.httpBody == nil, let stream = captured.httpBodyStream {
            stream.open()
            defer { stream.close() }
            var body = Data()
            var buffer = [UInt8](repeating: 0, count: 4096)
            while stream.hasBytesAvailable {
                let count = stream.read(&buffer, maxLength: buffer.count)
                if count <= 0 { break }
                body.append(buffer, count: count)
            }
            captured.httpBody = body
        }
        Self.requests.withLock { $0.append(captured) }
        let (status, retryAfter) = Self.responses.withLock { $0.removeFirst() }
        let headers = retryAfter.map { ["Retry-After": $0] } ?? [:]
        client?.urlProtocol(self, didReceive: HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil,
                                                              headerFields: headers)!, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(status == 200 ? #"{"ticket":"t"}"#.utf8 : "slow down".utf8))
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}
