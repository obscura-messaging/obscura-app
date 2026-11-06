package dev.barrelmaker.obscura.kit.managers

import dev.barrelmaker.obscura.kit.ObscuraError
import dev.barrelmaker.obscura.kit.SubmissionResult
import dev.barrelmaker.obscura.kit.SubmissionStatus
import dev.barrelmaker.obscura.kit.messaging.Messenger
import dev.barrelmaker.obscura.kit.messaging.PeerBundle
import dev.barrelmaker.obscura.kit.messaging.UserSubmission
import dev.barrelmaker.obscura.kit.messaging.parsePeerBundle
import dev.barrelmaker.obscura.kit.messaging.parsePeerBundles
import dev.barrelmaker.obscura.kit.messaging.requireConsistent
import dev.barrelmaker.obscura.kit.network.APIClient
import dev.barrelmaker.obscura.kit.stores.DeviceStore
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import obscura.client.v1.Client.ClientMessage
import java.util.concurrent.ConcurrentHashMap

/**
 * The one path every outgoing message takes to users' devices. Each request names every target user
 * in `recipients`, and the server queues a user's submissions only when they cover all of that
 * user's current devices, so its response decides the targets: they start as the user's devices in
 * [DeviceStore] (this device excluded), a mismatch adds the devices the server names for that user
 * (while other users in the batch are already queued and settled), and an invalid device is
 * removed. A user with no target is still named in `recipients`: it is how this device learns of
 * new own devices without an extra round-trip.
 *
 * Fetching a bundle consumes a one-time prekey, so bundles are fetched only for a target without a
 * session, one device at a time; a user absent from the directory is fetched whole. A bundle is
 * never processed over an existing session.
 */
internal class MessageSender(
    private val api: APIClient,
    private val messenger: Messenger,
    private val devices: DeviceStore,
    private val selfDeviceId: () -> String?,
) {
    // Sends to the same user are serialized in sorted userId order, so concurrent first contacts
    // share one fetch and overlapping multi-user batches cannot deadlock.
    private val recipientLocks = ConcurrentHashMap<String, Mutex>()

    suspend fun send(userId: String, message: ClientMessage): List<SubmissionResult> =
        send(listOf(userId), message)

    /**
     * Sends [message] to every device of [userIds] in a single batched request per round. Users
     * that succeed in round 1 are settled immediately; only users whose device set mismatched retry
     * in the next round.
     */
    suspend fun send(userIds: List<String>, message: ClientMessage): List<SubmissionResult> {
        val users = userIds.distinct()
        if (users.isEmpty()) return emptyList()
        return withUserLocks(users) {
            val settled = mutableMapOf<String, List<SubmissionResult>>()
            val mismatched = mutableMapOf<String, Pair<List<SubmissionResult>, List<String>>>()
            var pending = users

            repeat(MAX_ROUNDS) {
                if (pending.isEmpty()) return@repeat
                val nextPending = mutableListOf<String>()
                val targetUsers = linkedMapOf<String, Boolean>()
                val batchSubmissions = mutableListOf<UserSubmission>()

                for (userId in pending) {
                    if (!dev.barrelmaker.obscura.kit.network.isUuid(userId)) {
                        settled[userId] = listOf(rejected(userId, "Invalid user ID: $userId"))
                        continue
                    }
                    try {
                        val targets = sessionTargets(userId)
                        if (targets == null) {
                            nextPending.add(userId)
                            continue
                        }
                        val known = devices.devicesOf(userId)
                        if (known.isEmpty()) {
                            settled[userId] = listOf(rejected(userId, "No devices found"))
                            continue
                        }
                        val subs = targets.map { UserSubmission(userId, messenger.prepareSubmission(it, message)) }
                        targetUsers[userId] = selfDeviceId() in known
                        batchSubmissions.addAll(subs)
                    } catch (e: CancellationException) {
                        throw e
                    } catch (e: Exception) {
                        settled[userId] = listOf(rejected(userId, e))
                    }
                }

                if (targetUsers.isNotEmpty()) {
                    val outcome = messenger.submit(targetUsers.keys.toList(), batchSubmissions)
                    outcome.submitted.filter { it.invalidDevice }
                        .groupBy({ it.result.userId }, { it.result.deviceId!! })
                        .forEach { (u, invalid) -> devices.remove(u, invalid) }

                    for ((userId, isSelf) in targetUsers) {
                        val kept = outcome.submitted
                            .filter { it.result.userId == userId && !it.invalidDevice }
                            .map { it.result }
                        val missing = outcome.mismatches[userId]
                        if (missing != null) {
                            devices.add(userId, missing)
                            mismatched[userId] = kept to missing
                            nextPending.add(userId)
                        } else if (kept.isEmpty()) {
                            settled[userId] = if (isSelf) emptyList() else listOf(rejected(userId, "No devices found"))
                        } else {
                            settled[userId] = kept
                        }
                    }
                }
                pending = nextPending
            }

            for (userId in pending) {
                val last = mismatched[userId]
                if (last == null) {
                    settled[userId] = listOf(rejected(userId, "Sessions could not be established"))
                } else {
                    val (kept, missing) = last
                    val error = "Device mismatch after $MAX_ROUNDS rounds; missing $missing"
                    settled[userId] = kept.map { it.copy(error = error) }.ifEmpty { listOf(rejected(userId, error)) }
                }
            }

            users.flatMap { settled[it].orEmpty() }
        }
    }

    private suspend fun <T> withUserLocks(users: List<String>, block: suspend () -> T): T {
        val locks = users.sorted().map { recipientLocks.computeIfAbsent(it) { Mutex() } }
        suspend fun acquire(index: Int): T =
            if (index == locks.size) block() else locks[index].withLock { acquire(index + 1) }
        return acquire(0)
    }

    /** [send], failing when no device accepted. For control messages that must reach the user. */
    suspend fun sendOrThrow(userId: String, message: ClientMessage) {
        val results = send(userId, message)
        if (results.none { it.status == SubmissionStatus.ACCEPTED }) {
            throw ObscuraError.SendFailed(results.joinToString { it.error ?: it.status.name })
        }
    }

    private suspend fun targetsOf(userId: String): List<String> = selfDeviceId().let { self -> devices.devicesOf(userId).filter { it != self } }

    /**
     * The targets once each has a session, or null when building one dropped another's: a changed
     * account identity drops every session with the user, and the next round fetches those.
     */
    private suspend fun sessionTargets(userId: String): List<String>? {
        if (devices.devicesOf(userId).isEmpty()) establish(userId, fetchAll(userId))
        establish(userId, targetsOf(userId).filter { !messenger.hasSession(it) }.mapNotNull { fetchOne(userId, it) })
        val targets = targetsOf(userId)
        return targets.takeIf { all -> all.all { messenger.hasSession(it) } }
    }

    private suspend fun fetchAll(userId: String): List<PeerBundle> = try {
        parsePeerBundles(api.fetchPreKeyBundles(userId)).filter { it.deviceId != selfDeviceId() }
    } catch (e: ObscuraError.Http) {
        if (e.status == 404) emptyList() else throw e
    }

    /** Null, and the device forgotten, when the server no longer has it. */
    private suspend fun fetchOne(userId: String, deviceId: String): PeerBundle? = try {
        parsePeerBundle(api.fetchPreKeyBundle(userId, deviceId)).also {
            if (it.deviceId != deviceId) throw ObscuraError.ProtocolViolation("Bundle for $deviceId names device ${it.deviceId}")
        }
    } catch (e: ObscuraError.Http) {
        if (e.status != 404) throw e
        devices.remove(userId, listOf(deviceId))
        null
    }

    /** Bundles that disagree store nothing. The directory comes first: identity checks resolve through it. */
    private suspend fun establish(userId: String, bundles: List<PeerBundle>) {
        if (bundles.isEmpty()) return
        requireConsistent(bundles)
        for (peer in bundles) {
            devices.add(userId, listOf(peer.deviceId))
            messenger.establishSession(peer)
        }
    }

    private fun rejected(userId: String, error: Any) = SubmissionResult(
        userId, null, SubmissionStatus.REJECTED,
        if (error is Throwable) error.message ?: error.javaClass.simpleName else error.toString(),
    )

    private companion object {
        const val MAX_ROUNDS = 3
    }
}
