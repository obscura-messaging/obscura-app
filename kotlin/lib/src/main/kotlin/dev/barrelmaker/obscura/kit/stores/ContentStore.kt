package dev.barrelmaker.obscura.kit.stores

import app.cash.sqldelight.db.QueryResult
import app.cash.sqldelight.db.SqlDriver
import com.google.protobuf.ByteString
import dev.barrelmaker.obscura.kit.ConversationEntry
import dev.barrelmaker.obscura.kit.ObscuraError
import dev.barrelmaker.obscura.kit.ProfileEntry
import dev.barrelmaker.obscura.kit.StoryEntry
import dev.barrelmaker.obscura.kit.db.ObscuraDatabase
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import obscura.client.v1.Client.AttachmentPointer
import obscura.client.v1.Client.ClientMessage
import obscura.client.v1.Client.DirectMessage
import obscura.client.v1.Client.PixMessage
import obscura.client.v1.Client.ProfileUpdate
import obscura.client.v1.Client.StoredMessageRecord
import obscura.client.v1.Client.StoredProfileRecord
import obscura.client.v1.Client.StoredStoryRecord
import obscura.client.v1.Client.StoryPost

const val EXPIRE_AFTER_VIEW_MS = 15 * 60 * 1000L
const val MAX_EPHEMERAL_AGE_MS = 30L * 24 * 60 * 60 * 1000L
const val STORY_MAX_AGE_MS = 24L * 60 * 60 * 1000L

fun expiresAt(sentAt: Long, viewedAt: Long?): Long =
    if (viewedAt == null) sentAt + MAX_EPHEMERAL_AGE_MS
    else minOf(sentAt + MAX_EPHEMERAL_AGE_MS, viewedAt + EXPIRE_AFTER_VIEW_MS)

class MediaAttachment(
    val id: String,
    val contentKey: ByteArray,
    val nonce: ByteArray,
    mediaType: String = "photo",
) {
    val mediaType: String = mediaType.ifBlank { "photo" }

    fun toProto(): AttachmentPointer =
        AttachmentPointer.newBuilder()
            .setId(id)
            .setContentKey(ByteString.copyFrom(contentKey))
            .setNonce(ByteString.copyFrom(nonce))
            .setMediaType(mediaType)
            .build()

    override fun equals(other: Any?): Boolean =
        this === other || (other is MediaAttachment &&
            id == other.id &&
            contentKey.contentEquals(other.contentKey) &&
            nonce.contentEquals(other.nonce) &&
            mediaType == other.mediaType)

    override fun hashCode(): Int {
        var result = id.hashCode()
        result = 31 * result + contentKey.contentHashCode()
        result = 31 * result + nonce.contentHashCode()
        result = 31 * result + mediaType.hashCode()
        return result
    }

    companion object {
        fun fromProto(att: AttachmentPointer): MediaAttachment? =
            if (att.id.isNotBlank() && !att.contentKey.isEmpty && !att.nonce.isEmpty) {
                MediaAttachment(
                    id = att.id,
                    contentKey = att.contentKey.toByteArray(),
                    nonce = att.nonce.toByteArray(),
                    mediaType = att.mediaType,
                )
            } else null
    }
}

data class ConversationItem(
    val id: String,
    val peerUserId: String,
    val kind: String,
    val authorUserId: String,
    val sentAt: Long,
    val viewedAt: Long?,
    val expiresAt: Long = expiresAt(sentAt, viewedAt),
    val content: String,
    val attachment: MediaAttachment? = null,
    val caption: String? = null,
    val captionMeta: String? = null,
    val displayDuration: Int = 0,
    val undelivered: Boolean = false,
) {
    init {
        require(kind == "message" || kind == "pix") { "Invalid conversation item kind: $kind" }
        if (kind == "pix") {
            requireNotNull(attachment) { "pix requires an attachment" }
        } else {
            require(attachment == null && caption == null && captionMeta == null && displayDuration == 0) {
                "message cannot carry pix fields"
            }
        }
    }

    internal fun toClientMessage(): ClientMessage {
        val att = attachment
        return ClientMessage.newBuilder()
            .setTimestamp(sentAt)
            .apply {
                if (att != null) {
                    setPix(
                        PixMessage.newBuilder()
                            .setId(id)
                            .setPeerUserId(peerUserId)
                            .setAttachment(att.toProto())
                            .setCaption(caption ?: "")
                            .setCaptionMeta(captionMeta ?: "")
                            .setDisplayDurationSecs(displayDuration.coerceAtLeast(0)),
                    )
                } else {
                    setDirectMessage(
                        DirectMessage.newBuilder()
                            .setId(id)
                            .setPeerUserId(peerUserId)
                            .setContent(content),
                    )
                }
            }
            .build()
    }

    internal fun toSnapshotRecord(): StoredMessageRecord {
        val att = attachment
        return StoredMessageRecord.newBuilder()
            .setId(id)
            .setPeerUserId(peerUserId)
            .setKind(kind)
            .setAuthorUserId(authorUserId)
            .setSentAt(sentAt)
            .setViewedAt(viewedAt ?: 0L)
            .setContent(content)
            .setCaption(caption ?: "")
            .setCaptionMeta(captionMeta ?: "")
            .setDisplayDurationSecs(displayDuration)
            .apply { if (att != null) setAttachment(att.toProto()) }
            .build()
    }

    companion object {
        fun message(
            id: String,
            peerUserId: String,
            authorUserId: String,
            sentAt: Long,
            content: String,
            viewedAt: Long? = null,
            undelivered: Boolean = false,
        ): ConversationItem = ConversationItem(
            id = id,
            peerUserId = peerUserId,
            kind = "message",
            authorUserId = authorUserId,
            sentAt = sentAt,
            viewedAt = viewedAt,
            content = content,
            undelivered = undelivered,
        )

        fun pix(
            id: String,
            peerUserId: String,
            authorUserId: String,
            sentAt: Long,
            attachment: MediaAttachment,
            caption: String? = null,
            captionMeta: String? = null,
            displayDuration: Int = 0,
            viewedAt: Long? = null,
            undelivered: Boolean = false,
        ): ConversationItem = ConversationItem(
            id = id,
            peerUserId = peerUserId,
            kind = "pix",
            authorUserId = authorUserId,
            sentAt = sentAt,
            viewedAt = viewedAt,
            content = "",
            attachment = attachment,
            caption = caption,
            captionMeta = captionMeta,
            displayDuration = displayDuration,
            undelivered = undelivered,
        )
    }
}

data class StoryItem(
    val id: String,
    val authorUserId: String,
    val sentAt: Long,
    val expiresAt: Long = sentAt + STORY_MAX_AGE_MS,
    val content: String,
    val attachment: MediaAttachment? = null,
    val captionMeta: String? = null,
    val undelivered: Boolean = false,
) {
    internal fun toClientMessage(): ClientMessage {
        val att = attachment
        return ClientMessage.newBuilder()
            .setTimestamp(sentAt)
            .setStory(
                StoryPost.newBuilder()
                    .setId(id)
                    .setContent(content)
                    .setCaptionMeta(captionMeta ?: "")
                    .apply { if (att != null) setAttachment(att.toProto()) },
            )
            .build()
    }

    internal fun toSnapshotRecord(): StoredStoryRecord {
        val att = attachment
        return StoredStoryRecord.newBuilder()
            .setId(id)
            .setAuthorUserId(authorUserId)
            .setSentAt(sentAt)
            .setContent(content)
            .setCaptionMeta(captionMeta ?: "")
            .apply { if (att != null) setAttachment(att.toProto()) }
            .build()
    }
}

data class ProfileItem(
    val userId: String,
    val authorDeviceId: String,
    val updatedAt: Long,
    val displayName: String,
    val bio: String,
    val undelivered: Boolean = false,
) {
    internal fun toClientMessage(): ClientMessage =
        ClientMessage.newBuilder()
            .setTimestamp(updatedAt)
            .setProfile(
                ProfileUpdate.newBuilder()
                    .setDisplayName(displayName)
                    .setBio(bio),
            )
            .build()

    internal fun toSnapshotRecord(): StoredProfileRecord =
        StoredProfileRecord.newBuilder()
            .setUserId(userId)
            .setAuthorDeviceId(authorDeviceId)
            .setUpdatedAt(updatedAt)
            .setDisplayName(displayName)
            .setBio(bio)
            .build()
}

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

    fun insertConversationInTransaction(item: ConversationItem) {
        val att = item.attachment
        queries.insertMessage(
            id = item.id,
            peer_user_id = item.peerUserId,
            kind = item.kind,
            author_user_id = item.authorUserId,
            sent_at = item.sentAt,
            viewed_at = item.viewedAt,
            expires_at = item.expiresAt,
            content = item.content,
            media_ref = att?.id,
            content_key = att?.contentKey,
            nonce = att?.nonce,
            media_type = att?.mediaType,
            caption = item.caption,
            caption_meta = item.captionMeta,
            display_duration = item.displayDuration.toLong(),
            undelivered = if (item.undelivered) 1L else 0L,
        )
    }

    suspend fun putConversation(item: ConversationItem) = withContext(dispatcher) {
        insertConversationInTransaction(item)
    }

    fun getConversationInTransaction(id: String): ConversationItem? =
        queries.selectMessageById(id).executeAsOneOrNull()?.toData()

    suspend fun getConversation(id: String): ConversationItem? = withContext(dispatcher) {
        getConversationInTransaction(id)
    }

    /** The attachment of the pix or story [entryId], if it has one. */
    suspend fun getAttachment(entryId: String): MediaAttachment? = withContext(dispatcher) {
        queries.selectAttachment(entryId).executeAsList().firstNotNullOfOrNull {
            toAttachment(it.media_ref, it.content_key, it.nonce, it.media_type)
        }
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

    suspend fun getMessages(): List<ConversationItem> = withContext(dispatcher) {
        queries.selectAllMessages().executeAsList().map { it.toData() }
    }

    suspend fun getUndeliveredMessages(): List<ConversationItem> = withContext(dispatcher) {
        queries.selectUndeliveredMessages().executeAsList().map { it.toData() }
    }

    fun canInsertStoryInTransaction(id: String): Boolean =
        !queries.existsErased(id).executeAsOne() && !queries.existsStory(id).executeAsOne()

    fun insertStoryInTransaction(item: StoryItem) {
        val att = item.attachment
        queries.insertStory(
            id = item.id,
            author_user_id = item.authorUserId,
            sent_at = item.sentAt,
            expires_at = item.expiresAt,
            content = item.content,
            media_ref = att?.id,
            content_key = att?.contentKey,
            nonce = att?.nonce,
            media_type = att?.mediaType,
            caption_meta = item.captionMeta,
            undelivered = if (item.undelivered) 1L else 0L,
        )
    }

    suspend fun putStory(item: StoryItem) = withContext(dispatcher) {
        insertStoryInTransaction(item)
    }

    suspend fun setStoryUndelivered(id: String, undelivered: Boolean) = withContext(dispatcher) {
        queries.setStoryUndelivered(undelivered = if (undelivered) 1L else 0L, id = id)
    }

    suspend fun getStories(now: Long): List<StoryItem> = withContext(dispatcher) {
        queries.selectActiveStories(now).executeAsList().map { it.toData() }
    }

    suspend fun getAllStories(): List<StoryItem> = withContext(dispatcher) {
        queries.selectAllStories().executeAsList().map { it.toData() }
    }

    suspend fun getUndeliveredStories(): List<StoryItem> = withContext(dispatcher) {
        queries.selectUndeliveredStories().executeAsList().map { it.toData() }
    }

    fun getProfileInTransaction(userId: String): ProfileItem? =
        queries.selectProfileByUserId(userId).executeAsOneOrNull()?.toData()

    suspend fun getProfile(userId: String): ProfileItem? = withContext(dispatcher) {
        getProfileInTransaction(userId)
    }

    fun upsertProfileIfNewerInTransaction(item: ProfileItem): Boolean {
        val existing = getProfileInTransaction(item.userId)
        val wins = existing == null ||
            item.updatedAt > existing.updatedAt ||
            (item.updatedAt == existing.updatedAt && item.authorDeviceId > existing.authorDeviceId)
        if (wins) insertProfileInTransaction(item)
        return wins
    }

    fun insertProfileInTransaction(item: ProfileItem) {
        queries.insertProfile(
            user_id = item.userId,
            author_device_id = item.authorDeviceId,
            updated_at = item.updatedAt,
            display_name = item.displayName,
            bio = item.bio,
            undelivered = if (item.undelivered) 1L else 0L,
        )
    }

    suspend fun putProfile(item: ProfileItem) = withContext(dispatcher) {
        insertProfileInTransaction(item)
    }

    suspend fun setProfileUndelivered(userId: String, updatedAt: Long, undelivered: Boolean) = withContext(dispatcher) {
        queries.setProfileUndelivered(undelivered = if (undelivered) 1L else 0L, userId = userId, updatedAt = updatedAt)
    }

    suspend fun getProfiles(): List<ProfileItem> = withContext(dispatcher) {
        queries.selectAllProfiles().executeAsList().map { it.toData() }
    }

    suspend fun getUndeliveredProfiles(): List<ProfileItem> = withContext(dispatcher) {
        queries.selectUndeliveredProfiles().executeAsList().map { it.toData() }
    }

    suspend fun importSnapshot(
        messages: List<ConversationItem>,
        stories: List<StoryItem>,
        profiles: List<ProfileItem>,
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

private fun toAttachment(mediaRef: String?, contentKey: ByteArray?, nonce: ByteArray?, mediaType: String?): MediaAttachment? =
    if (!mediaRef.isNullOrBlank() && contentKey != null && nonce != null) {
        MediaAttachment(
            id = mediaRef,
            contentKey = contentKey,
            nonce = nonce,
            mediaType = mediaType.orEmpty(),
        )
    } else null

private fun ConversationEntry.toData() = ConversationItem(
    id = id,
    peerUserId = peer_user_id,
    kind = kind,
    authorUserId = author_user_id,
    sentAt = sent_at,
    viewedAt = viewed_at,
    expiresAt = expires_at,
    content = content,
    attachment = toAttachment(media_ref, content_key, nonce, media_type),
    caption = caption,
    captionMeta = caption_meta,
    displayDuration = display_duration.toInt(),
    undelivered = undelivered != 0L,
)

private fun StoryEntry.toData() = StoryItem(
    id = id,
    authorUserId = author_user_id,
    sentAt = sent_at,
    expiresAt = expires_at,
    content = content,
    attachment = toAttachment(media_ref, content_key, nonce, media_type),
    captionMeta = caption_meta,
    undelivered = undelivered != 0L,
)

private fun ProfileEntry.toData() = ProfileItem(
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
