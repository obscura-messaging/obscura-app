package dev.barrelmaker.obscura.kit.linking

import com.google.protobuf.ByteString
import com.google.protobuf.InvalidProtocolBufferException
import dev.barrelmaker.obscura.kit.AttachmentUpload
import dev.barrelmaker.obscura.kit.ObscuraError
import dev.barrelmaker.obscura.kit.stores.ContentStore
import dev.barrelmaker.obscura.kit.stores.ConversationItem
import dev.barrelmaker.obscura.kit.stores.MediaAttachment
import dev.barrelmaker.obscura.kit.stores.ProfileItem
import dev.barrelmaker.obscura.kit.stores.STORY_MAX_AGE_MS
import dev.barrelmaker.obscura.kit.stores.StoryItem
import dev.barrelmaker.obscura.kit.stores.expiresAt
import obscura.client.v1.Client.AttachmentPointer
import obscura.client.v1.Client.EntrySnapshot
import obscura.client.v1.Client.HistorySnapshot
import obscura.client.v1.Client.StoredMessageRecord
import obscura.client.v1.Client.StoredProfileRecord
import obscura.client.v1.Client.StoredStoryRecord

/** Encrypted history snapshot export and import during device linking. */
internal object HistorySync {

    suspend fun uploadHistorySnapshot(
        content: ContentStore,
        upload: suspend (ByteArray) -> AttachmentUpload,
    ): HistorySnapshot? {
        val snapshot = exportSnapshot(content) ?: return null
        val uploaded = upload(snapshot.toByteArray())
        return HistorySnapshot.newBuilder()
            .setAttachmentId(uploaded.id)
            .setContentKey(ByteString.copyFrom(uploaded.contentKey))
            .setNonce(ByteString.copyFrom(uploaded.nonce))
            .build()
    }

    suspend fun exportSnapshot(content: ContentStore): EntrySnapshot? {
        val messages = content.getMessages()
        val stories = content.getAllStories()
        val profiles = content.getProfiles()
        if (messages.isEmpty() && stories.isEmpty() && profiles.isEmpty()) return null
        return EntrySnapshot.newBuilder()
            .addAllMessages(messages.map { m ->
                StoredMessageRecord.newBuilder()
                    .setId(m.id)
                    .setPeerUserId(m.peerUserId)
                    .setKind(m.kind)
                    .setAuthorUserId(m.authorUserId)
                    .setSentAt(m.sentAt)
                    .setViewedAt(m.viewedAt ?: 0L)
                    .setContent(m.content)
                    .setCaption(m.caption ?: "")
                    .setCaptionMeta(m.captionMeta ?: "")
                    .setDisplayDurationSecs(m.displayDuration)
                    .apply { m.attachment?.let { setAttachment(encodeAttachment(it)) } }
                    .build()
            })
            .addAllStories(stories.map { s ->
                StoredStoryRecord.newBuilder()
                    .setId(s.id)
                    .setAuthorUserId(s.authorUserId)
                    .setSentAt(s.sentAt)
                    .setContent(s.content)
                    .setCaptionMeta(s.captionMeta ?: "")
                    .apply { s.attachment?.let { setAttachment(encodeAttachment(it)) } }
                    .build()
            })
            .addAllProfiles(profiles.map { p ->
                StoredProfileRecord.newBuilder()
                    .setUserId(p.userId)
                    .setAuthorDeviceId(p.authorDeviceId)
                    .setUpdatedAt(p.updatedAt)
                    .setDisplayName(p.displayName)
                    .setBio(p.bio)
                    .build()
            })
            .build()
    }

    suspend fun restoreHistorySnapshot(
        history: HistorySnapshot,
        content: ContentStore,
        download: suspend (String, ByteArray, ByteArray) -> ByteArray,
    ) {
        val plaintext = download(history.attachmentId, history.contentKey.toByteArray(), history.nonce.toByteArray())
        val snapshot = try {
            EntrySnapshot.parseFrom(plaintext)
        } catch (e: InvalidProtocolBufferException) {
            throw ObscuraError.ProtocolViolation("Invalid history snapshot", e)
        }
        importSnapshot(snapshot, content)
    }

    suspend fun importSnapshot(snapshot: EntrySnapshot, content: ContentStore) {
        val messages = snapshot.messagesList.mapNotNull { m ->
            if (m.id.isBlank()) return@mapNotNull null
            val viewedAt = m.viewedAt.takeIf { it > 0L }
            val att = if (m.hasAttachment()) decodeAttachment(m.attachment) else null
            ConversationItem(
                id = m.id,
                peerUserId = m.peerUserId,
                kind = m.kind,
                authorUserId = m.authorUserId,
                sentAt = m.sentAt,
                viewedAt = viewedAt,
                expiresAt = expiresAt(m.sentAt, viewedAt),
                content = m.content,
                attachment = att,
                caption = if (m.kind == "pix") m.caption.ifEmpty { null } else null,
                captionMeta = if (m.kind == "pix") m.captionMeta.ifEmpty { null } else null,
                displayDuration = if (m.kind == "pix") m.displayDurationSecs else 0,
                undelivered = false,
            )
        }
        val stories = snapshot.storiesList.mapNotNull { s ->
            if (s.id.isBlank()) return@mapNotNull null
            val att = if (s.hasAttachment()) decodeAttachment(s.attachment) else null
            StoryItem(
                id = s.id,
                authorUserId = s.authorUserId,
                sentAt = s.sentAt,
                expiresAt = s.sentAt + STORY_MAX_AGE_MS,
                content = s.content,
                attachment = att,
                captionMeta = s.captionMeta.ifEmpty { null },
                undelivered = false,
            )
        }
        val profiles = snapshot.profilesList.mapNotNull { p ->
            if (p.userId.isBlank()) return@mapNotNull null
            ProfileItem(
                userId = p.userId,
                authorDeviceId = p.authorDeviceId,
                updatedAt = p.updatedAt,
                displayName = p.displayName,
                bio = p.bio,
                undelivered = false,
            )
        }
        content.importSnapshot(messages, stories, profiles)
    }

    fun encodeAttachment(att: MediaAttachment): AttachmentPointer =
        AttachmentPointer.newBuilder()
            .setId(att.id)
            .setContentKey(ByteString.copyFrom(att.contentKey))
            .setNonce(ByteString.copyFrom(att.nonce))
            .setMediaType(att.mediaType)
            .build()

    fun decodeAttachment(att: AttachmentPointer): MediaAttachment? =
        if (att.id.isNotBlank()) {
            MediaAttachment(
                id = att.id,
                contentKey = att.contentKey.toByteArray(),
                nonce = att.nonce.toByteArray(),
                mediaType = att.mediaType,
            )
        } else null
}
