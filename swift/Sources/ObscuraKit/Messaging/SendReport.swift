import Foundation

public enum SubmissionStatus: String, Codable, Sendable {
    case accepted, rejected, unknown
}

public struct SubmissionResult: Codable, Sendable, Equatable {
    public let userId: String
    public let deviceId: String?
    public let status: SubmissionStatus
    public let error: String?

    init(userId: String, deviceId: String?, status: SubmissionStatus, error: String? = nil) {
        self.userId = userId
        self.deviceId = deviceId
        self.status = status
        self.error = error
    }
}

public struct SendReport: Codable, Sendable, Equatable {
    public let recipients: [SubmissionResult]
    public let selfSync: [SubmissionResult]
}

/// One submission and the recipient user it addresses.
struct UserSubmission: Equatable {
    let userId: String
    let submission: Obscura_V1_SendMessageRequest.Submission
}

/// A submission's result.
struct Submitted: Equatable {
    let result: SubmissionResult
    let invalidDevice: Bool

    init(_ result: SubmissionResult, invalidDevice: Bool = false) {
        self.result = result
        self.invalidDevice = invalidDevice
    }
}

/// One request to one or more users: each submission's result, and each mismatched user's untargeted devices.
struct SubmitOutcome: Equatable {
    let submitted: [Submitted]
    let mismatches: [String: [String]]

    var missingDeviceIds: [String] { mismatches.values.flatMap { $0 } }

    init(submitted: [Submitted], mismatches: [String: [String]] = [:]) {
        self.submitted = submitted
        self.mismatches = mismatches
    }

    init(submitted: [Submitted], missingDeviceIds: [String]) {
        self.submitted = submitted
        self.mismatches = missingDeviceIds.isEmpty ? [:] : ["": missingDeviceIds]
    }
}

func submitOutcome(
    userIds: [String],
    submissions: [UserSubmission],
    response: Obscura_V1_SendMessageResponse
) throws -> SubmitOutcome {
    let targetedDevices = Set(submissions.compactMap { uuidString($0.submission.deviceID) })
    var invalidDevices: Set<String> = []
    for bytes in response.invalidDeviceIds {
        guard let id = uuidString(bytes), targetedDevices.contains(id), invalidDevices.insert(id).inserted else {
            throw ObscuraError.protocolViolation("unknown or duplicate invalid device ids in send response")
        }
    }
    let addressed = Set(userIds)
    var mismatches: [String: [String]] = [:]
    for mismatch in response.deviceMismatches {
        guard let user = uuidString(mismatch.userID), addressed.contains(user), mismatches[user] == nil else {
            throw ObscuraError.protocolViolation("device mismatch for a user this request did not address")
        }
        mismatches[user] = try mismatch.missingDeviceIds.map { bytes in
            guard let id = uuidString(bytes) else { throw ObscuraError.protocolViolation("missing device id is not a UUID") }
            return id
        }
    }
    let submitted = submissions.map { item -> Submitted in
        let deviceId = uuidString(item.submission.deviceID)
        let isInvalid = deviceId.map(invalidDevices.contains) ?? false
        let missing = mismatches[item.userId]
        let error: String?
        if isInvalid {
            error = "Device not found"
        } else if let missing {
            error = "devices not covered: \(missing.joined(separator: ", "))"
        } else {
            error = nil
        }
        return Submitted(
            SubmissionResult(
                userId: item.userId,
                deviceId: deviceId,
                status: error == nil ? .accepted : .rejected,
                error: error
            ),
            invalidDevice: isInvalid
        )
    }
    return SubmitOutcome(submitted: submitted, mismatches: mismatches)
}

func submitOutcome(
    userId: String,
    submissions: [Obscura_V1_SendMessageRequest.Submission],
    response: Obscura_V1_SendMessageResponse
) throws -> SubmitOutcome {
    try submitOutcome(
        userIds: [userId],
        submissions: submissions.map { UserSubmission(userId: userId, submission: $0) },
        response: response
    )
}
