import Foundation

/// The one path every outgoing message takes to a user's devices.
///
/// Targets are the user's devices in the `DeviceStore` directory, never this device. A user with no
/// listed device is fetched whole; otherwise a bundle is fetched only for a target without a session,
/// one device at a time, because every bundle fetch consumes a one-time prekey. The server requires
/// each request to cover the named user's devices exactly: a mismatch names the missing devices, which
/// are added and reached in the next round, and a device the server does not know is dropped.
actor MessageSender {
    static let maxRounds = 3

    private let messenger: Messenger
    private let devices: DeviceStore
    private let api: APIClient
    private let logger: ObscuraLogger
    private let selfDeviceId: String

    // Sends to one user are serialized so concurrent first contacts share one bundle fetch.
    private var tails: [String: Task<[SubmissionResult], Never>] = [:]

    init(messenger: Messenger, devices: DeviceStore, api: APIClient, logger: ObscuraLogger, selfDeviceId: String) {
        self.messenger = messenger
        self.devices = devices
        self.api = api
        self.logger = logger
        self.selfDeviceId = selfDeviceId
    }

    func send(to userId: String, _ clientMessage: Data) async -> [SubmissionResult] {
        await send(to: [userId], clientMessage)
    }

    /// Encrypts serialized `ClientMessage` bytes to `userIds`' devices in a single batched request per
    /// round and reports each one. Users that succeed in round 1 are settled immediately; only users
    /// whose device set mismatched retry in the next round.
    func send(to userIds: [String], _ clientMessage: Data) async -> [SubmissionResult] {
        var seen: Set<String> = []
        let users = userIds.filter { seen.insert($0).inserted }
        if users.isEmpty { return [] }
        let ordered = users.sorted()
        let previousTasks = ordered.compactMap { tails[$0] }
        let task = Task {
            for previous in previousTasks { _ = await previous.value }
            return await self.attemptBatch(users, clientMessage)
        }
        for userId in ordered { tails[userId] = task }
        let results = await task.value
        for userId in ordered where tails[userId] == task { tails[userId] = nil }
        return results
    }

    /// For control messages that must reach the user: throws unless some device accepted.
    func sendOrThrow(to userId: String, _ clientMessage: Data) async throws {
        let results = await send(to: userId, clientMessage)
        guard results.contains(where: { $0.status == .accepted }) else {
            throw ObscuraError.sendFailed(results.map { $0.error ?? $0.status.rawValue }.joined(separator: "; "))
        }
    }

    private func attemptBatch(_ users: [String], _ data: Data) async -> [SubmissionResult] {
        var settled: [String: [SubmissionResult]] = [:]
        var mismatched: [String: [SubmissionResult]] = [:]
        var pending = users

        for _ in 0..<Self.maxRounds {
            if pending.isEmpty { break }
            var nextPending: [String] = []
            var targetUsers: [(userId: String, isSelf: Bool)] = []
            var batchSubmissions: [UserSubmission] = []

            for userId in pending {
                guard UUID(uuidString: userId) != nil else {
                    settled[userId] = [rejected(userId, nil, "invalid user id \(userId)")]
                    continue
                }
                do {
                    var listed = try await devices.deviceIds(of: userId)
                    if listed.isEmpty {
                        try await establish(userId, try fetchAll(userId))
                        listed = try await devices.deviceIds(of: userId)
                    }
                    let isSelf = listed.contains(selfDeviceId)
                    let targets = listed.filter { $0 != selfDeviceId }

                    var gone: [String] = []
                    for deviceId in targets {
                        guard try await !messenger.hasSession(deviceId) else { continue }
                        do {
                            let bundle = try await api.fetchPreKeyBundle(userId, deviceId: deviceId)
                            guard bundle.deviceId == deviceId else {
                                throw ObscuraError.protocolViolation("bundle deviceId \(bundle.deviceId) did not match requested \(deviceId)")
                            }
                            try await establish(userId, [bundle])
                        } catch ObscuraError.http(status: 404, body: _) {
                            gone.append(deviceId)
                        }
                    }
                    try await devices.remove(userId: userId, deviceIds: gone)

                    let remaining = try await devices.deviceIds(of: userId).filter { $0 != selfDeviceId }
                    var allHaveSessions = true
                    for deviceId in remaining where try await !messenger.hasSession(deviceId) {
                        allHaveSessions = false
                    }
                    if !allHaveSessions {
                        nextPending.append(userId)
                        continue
                    }
                    if remaining.isEmpty, !isSelf {
                        settled[userId] = [noDevices(userId)]
                        continue
                    }
                    var subs: [UserSubmission] = []
                    for deviceId in remaining {
                        let sub = try await messenger.prepareSubmission(deviceId: deviceId, clientMessage: data)
                        subs.append(UserSubmission(userId: userId, submission: sub))
                    }
                    targetUsers.append((userId, isSelf))
                    batchSubmissions.append(contentsOf: subs)
                } catch {
                    logger.sessionEstablishFailed(userId: userId, reason: "\(error)")
                    settled[userId] = [rejected(userId, nil, error)]
                }
            }

            if !targetUsers.isEmpty {
                let outcome = await messenger.submit(userIds: targetUsers.map(\.userId), submissions: batchSubmissions)
                for (userId, items) in Dictionary(grouping: outcome.submitted.filter(\.invalidDevice), by: \.result.userId) {
                    do {
                        try await devices.remove(userId: userId, deviceIds: items.compactMap(\.result.deviceId))
                    } catch {
                        logger.sessionEstablishFailed(userId: userId, reason: "\(error)")
                    }
                }

                for (userId, isSelf) in targetUsers {
                    let kept = outcome.submitted
                        .filter { $0.result.userId == userId && !$0.invalidDevice }
                        .map(\.result)
                    if let missing = outcome.mismatches[userId], !missing.isEmpty {
                        do {
                            try await devices.add(userId: userId, deviceIds: missing)
                            let mismatch = rejected(userId, nil, "devices not covered: \(missing.joined(separator: ", "))")
                            mismatched[userId] = kept.isEmpty ? [mismatch] : kept
                            nextPending.append(userId)
                        } catch {
                            logger.sessionEstablishFailed(userId: userId, reason: "\(error)")
                            settled[userId] = [rejected(userId, nil, error)]
                        }
                    } else if kept.isEmpty {
                        settled[userId] = isSelf ? [] : [noDevices(userId)]
                    } else {
                        settled[userId] = kept
                    }
                }
            }
            pending = nextPending
        }

        for userId in pending {
            settled[userId] = mismatched[userId] ?? [rejected(userId, nil, "sessions could not be established")]
        }

        return users.flatMap { settled[$0] ?? [] }
    }

    /// Consumes one one-time prekey on every device of `userId`. 404 means the user has no devices.
    private func fetchAll(_ userId: String) async throws -> [PreKeyBundleResponse] {
        do {
            return try await api.fetchPreKeyBundles(userId).filter { $0.deviceId != selfDeviceId }
        } catch ObscuraError.http(status: 404, body: _) {
            return []
        }
    }

    private func establish(_ userId: String, _ bundles: [PreKeyBundleResponse]) async throws {
        try await messenger.establishSessions(userId: userId, bundles)
    }

    private func noDevices(_ userId: String) -> SubmissionResult {
        rejected(userId, nil, "no devices found")
    }

    private func rejected(_ userId: String, _ deviceId: String?, _ error: Any) -> SubmissionResult {
        SubmissionResult(userId: userId, deviceId: deviceId, status: .rejected, error: "\(error)")
    }
}
