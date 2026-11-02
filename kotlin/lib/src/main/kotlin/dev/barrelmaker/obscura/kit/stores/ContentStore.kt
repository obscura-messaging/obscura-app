package dev.barrelmaker.obscura.kit.stores

import app.cash.sqldelight.db.QueryResult
import app.cash.sqldelight.db.SqlDriver
import dev.barrelmaker.obscura.kit.ConversationEntry
import dev.barrelmaker.obscura.kit.ObscuraError
import dev.barrelmaker.obscura.kit.ProfileEntry
import dev.barrelmaker.obscura.kit.StoryEntry
import dev.barrelmaker.obscura.kit.db.ObscuraDatabase
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

const val EXPIRE_AFTER_VIEW_MS = 15 * 60 * 1000L
const val MAX_EPHEMERAL_AGE_MS = 30L * 24 * 60 * 60 * 1000L
const val STORY_MAX_AGE_MS = 24L * 60 * 60 * 1000L

fun expiresAt(sentAt: Long, viewedAt: Long?): Long =
    if (viewedAt == null) sentAt + MAX_EPHEMERAL_AGE_MS
    else minOf(sentAt + MAX_EPHEMERAL_AGE_MS, viewedAt + EXPIRE_AFTER_VIEW_MS)

data class ConversationItemData(
    val id: String,
    val peerUserId: String,
    val kind: String,
    val authorUserId: String,
    val sentAt: Long,
    val viewedAt: Long?,
    val expiresAt: Long,
    val content: String,
    val mediaRef: String? = null,
    val contentKey: String? = null,
    val nonce: String? = null,
    val mediaType: String? = null,
    val caption: String? = null,
    val captionMeta: String? = null,
    val displayDuration: Int = 0,
    val undelivered: Boolean = false,
)

data class StoryItemData(
    val id: String,
    val authorUserId: String,
    val sentAt: Long,
    val expiresAt: Long,
    val content: String,
    val mediaRef: String? = null,
    val contentKey: String? = null,
    val nonce: String? = null,
    val mediaType: String? = null,
    val captionMeta: String? = null,
    val undelivered: Boolean = false,
)

data class ProfileItemData(
    val userId: String,
    val authorDeviceId: String,
    val updatedAt: Long,
    val displayName: String,
    val bio: String,
    val undelivered: Boolean = false,
)

data class SweepOutcome(
    val purgedMediaRefs: List<String>,
    val touchedModels: List<String>,
)

/** Typed local storage for messages, pix, stories, profiles, erased tombstones, and processed envelopes. */
internal class ContentStore(
    private val db: ObscuraDatabase,
    private val driver: SqlDriver,
) {
    private val dispatcher = Dispatchers.IO.limitedParallelism(1)
    private val queries = db.contentQueries

    suspend fun containsEnvelope(envelopeId: String): Boolean = withContext(dispatcher) {
        queries.existsEnvelope(envelopeId).executeAsOne()
    }

    /** True when [envelopeId] was newly recorded; false if already processed. */
    fun recordEnvelopeInTransaction(envelopeId: String): Boolean {
        if (queries.existsEnvelope(envelopeId).executeAsOne()) return false
        queries.insertEnvelope(envelopeId)
        check(queries.existsEnvelope(envelopeId).executeAsOne()) {
            "processed envelope $envelopeId is absent after insert"
        }
        return true
    }

    fun canInsertConversationInTransaction(id: String): Boolean =
        !queries.existsErased(id).executeAsOne() && !queries.existsMessage(id).executeAsOne()

    fun insertConversationInTransaction(item: ConversationItemData) {
        queries.insertMessage(
            id = item.id,
            peer_user_id = item.peerUserId,
            kind = item.kind,
            author_user_id = item.authorUserId,
            sent_at = item.sentAt,
            viewed_at = item.viewedAt,
            expires_at = item.expiresAt,
            content = item.content,
            media_ref = item.mediaRef,
            content_key = item.contentKey,
            nonce = item.nonce,
            media_type = item.mediaType,
            caption = item.caption,
            caption_meta = item.captionMeta,
            display_duration = item.displayDuration.toLong(),
            undelivered = if (item.undelivered) 1L else 0L,
        )
    }

    suspend fun putConversation(item: ConversationItemData) = withContext(dispatcher) {
        insertConversationInTransaction(item)
    }

    fun getConversationInTransaction(id: String): ConversationItemData? =
        queries.selectMessageById(id).executeAsOneOrNull()?.toData()

    suspend fun getConversation(id: String): ConversationItemData? = withContext(dispatcher) {
        getConversationInTransaction(id)
    }

    fun markConversationViewedInTransaction(id: String, viewedAt: Long, expiresAt: Long) {
        queries.updateMessageViewed(viewedAt = viewedAt, expiresAt = expiresAt, id = id)
    }

    suspend fun markConversationViewed(id: String, viewedAt: Long, expiresAt: Long) = withContext(dispatcher) {
        markConversationViewedInTransaction(id, viewedAt, expiresAt)
    }

    suspend fun setConversationUndelivered(id: String, undelivered: Boolean) = withContext(dispatcher) {
        queries.setMessageUndelivered(undelivered = if (undelivered) 1L else 0L, id = id)
    }

    suspend fun getMessages(): List<ConversationItemData> = withContext(dispatcher) {
        queries.selectAllMessages().executeAsList().map { it.toData() }
    }

    suspend fun getUndeliveredMessages(): List<ConversationItemData> = withContext(dispatcher) {
        queries.selectUndeliveredMessages().executeAsList().map { it.toData() }
    }

    fun canInsertStoryInTransaction(id: String): Boolean =
        !queries.existsErased(id).executeAsOne() && !queries.existsStory(id).executeAsOne()

    fun insertStoryInTransaction(item: StoryItemData) {
        queries.insertStory(
            id = item.id,
            author_user_id = item.authorUserId,
            sent_at = item.sentAt,
            expires_at = item.expiresAt,
            content = item.content,
            media_ref = item.mediaRef,
            content_key = item.contentKey,
            nonce = item.nonce,
            media_type = item.mediaType,
            caption_meta = item.captionMeta,
            undelivered = if (item.undelivered) 1L else 0L,
        )
    }

    suspend fun putStory(item: StoryItemData) = withContext(dispatcher) {
        insertStoryInTransaction(item)
    }

    suspend fun setStoryUndelivered(id: String, undelivered: Boolean) = withContext(dispatcher) {
        queries.setStoryUndelivered(undelivered = if (undelivered) 1L else 0L, id = id)
    }

    suspend fun getStories(now: Long): List<StoryItemData> = withContext(dispatcher) {
        queries.selectActiveStories(now).executeAsList().map { it.toData() }
    }

    suspend fun getAllStories(): List<StoryItemData> = withContext(dispatcher) {
        queries.selectAllStories().executeAsList().map { it.toData() }
    }

    suspend fun getUndeliveredStories(): List<StoryItemData> = withContext(dispatcher) {
        queries.selectUndeliveredStories().executeAsList().map { it.toData() }
    }

    fun getProfileInTransaction(userId: String): ProfileItemData? =
        queries.selectProfileByUserId(userId).executeAsOneOrNull()?.toData()

    suspend fun getProfile(userId: String): ProfileItemData? = withContext(dispatcher) {
        getProfileInTransaction(userId)
    }

    fun upsertProfileIfNewerInTransaction(item: ProfileItemData): Boolean {
        val existing = getProfileInTransaction(item.userId)
        val wins = existing == null ||
            item.updatedAt > existing.updatedAt ||
            (item.updatedAt == existing.updatedAt && item.authorDeviceId > existing.authorDeviceId)
        if (wins) insertProfileInTransaction(item)
        return wins
    }

    fun insertProfileInTransaction(item: ProfileItemData) {
        queries.insertProfile(
            user_id = item.userId,
            author_device_id = item.authorDeviceId,
            updated_at = item.updatedAt,
            display_name = item.displayName,
            bio = item.bio,
            undelivered = if (item.undelivered) 1L else 0L,
        )
    }

    suspend fun putProfile(item: ProfileItemData) = withContext(dispatcher) {
        insertProfileInTransaction(item)
    }

    suspend fun setProfileUndelivered(userId: String, updatedAt: Long, undelivered: Boolean) = withContext(dispatcher) {
        queries.setProfileUndelivered(undelivered = if (undelivered) 1L else 0L, userId = userId, updatedAt = updatedAt)
    }

    suspend fun getProfiles(): List<ProfileItemData> = withContext(dispatcher) {
        queries.selectAllProfiles().executeAsList().map { it.toData() }
    }

    suspend fun getUndeliveredProfiles(): List<ProfileItemData> = withContext(dispatcher) {
        queries.selectUndeliveredProfiles().executeAsList().map { it.toData() }
    }

    suspend fun importSnapshot(
        messages: List<ConversationItemData>,
        stories: List<StoryItemData>,
        profiles: List<ProfileItemData>,
    ) = withContext(dispatcher) {
        db.transaction {
            messages.forEach { if (canInsertConversationInTransaction(it.id)) insertConversationInTransaction(it) }
            stories.forEach { if (canInsertStoryInTransaction(it.id)) insertStoryInTransaction(it) }
            profiles.forEach { upsertProfileIfNewerInTransaction(it) }
        }
    }

    suspend fun sweepExpired(now: Long): SweepOutcome = withContext(dispatcher) {
        val outcome = db.transactionWithResult {
            driver.pragma("PRAGMA secure_delete = ON")
            val expiredMessages = queries.selectExpiredMessages(now).executeAsList()
            val expiredStories = queries.selectExpiredStories(now).executeAsList()

            val purgedMediaRefs = mutableListOf<String>()
            val touchedModels = mutableListOf<String>()

            if (expiredMessages.any { it.kind == "message" }) touchedModels.add("directMessage")
            if (expiredMessages.any { it.kind == "pix" }) touchedModels.add("pix")
            if (expiredStories.isNotEmpty()) touchedModels.add("story")

            for (m in expiredMessages) {
                if (!m.media_ref.isNullOrBlank()) purgedMediaRefs.add(m.media_ref)
                queries.insertErased(m.id, now)
            }
            for (s in expiredStories) {
                if (!s.media_ref.isNullOrBlank()) purgedMediaRefs.add(s.media_ref)
                queries.insertErased(s.id, now)
            }

            expiredMessages.map { it.id }.chunked(500).forEach(queries::deleteMessagesByIds)
            expiredStories.map { it.id }.chunked(500).forEach(queries::deleteStoriesByIds)
            queries.deleteExpiredErased(now - MAX_EPHEMERAL_AGE_MS)

            SweepOutcome(purgedMediaRefs = purgedMediaRefs, touchedModels = touchedModels)
        }
        driver.truncateWal()
        outcome
    }

    fun deleteAllInTransaction() {
        queries.deleteAllEnvelopes()
        queries.deleteAllMessages()
        queries.deleteAllStories()
        queries.deleteAllProfiles()
        queries.deleteAllErased()
    }
}

private fun ConversationEntry.toData() = ConversationItemData(
    id = id,
    peerUserId = peer_user_id,
    kind = kind,
    authorUserId = author_user_id,
    sentAt = sent_at,
    viewedAt = viewed_at,
    expiresAt = expires_at,
    content = content,
    mediaRef = media_ref,
    contentKey = content_key,
    nonce = nonce,
    mediaType = media_type,
    caption = caption,
    captionMeta = caption_meta,
    displayDuration = display_duration.toInt(),
    undelivered = undelivered != 0L,
)

private fun StoryEntry.toData() = StoryItemData(
    id = id,
    authorUserId = author_user_id,
    sentAt = sent_at,
    expiresAt = expires_at,
    content = content,
    mediaRef = media_ref,
    contentKey = content_key,
    nonce = nonce,
    mediaType = media_type,
    captionMeta = caption_meta,
    undelivered = undelivered != 0L,
)

private fun ProfileEntry.toData() = ProfileItemData(
    userId = user_id,
    authorDeviceId = author_device_id,
    updatedAt = updated_at,
    displayName = display_name,
    bio = bio,
    undelivered = undelivered != 0L,
)

/** PRAGMAs go through `executeQuery` because several return a row, which Android's `execute` rejects. */
internal fun SqlDriver.pragma(sql: String) {
    executeQuery(null, sql, { cursor -> cursor.next(); QueryResult.Unit }, 0)
}

internal fun SqlDriver.truncateWal() {
    executeQuery(null, "PRAGMA wal_checkpoint(TRUNCATE)", { cursor ->
        if (!cursor.next().value || cursor.getLong(0) != 0L) {
            throw ObscuraError.StorageFailed("WAL truncation could not complete; checkpoint is busy")
        }
        QueryResult.Unit
    }, 0)
}
