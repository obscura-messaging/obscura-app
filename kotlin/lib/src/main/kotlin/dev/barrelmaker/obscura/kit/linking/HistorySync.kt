package dev.barrelmaker.obscura.kit.linking

import com.google.protobuf.ByteString
import com.google.protobuf.InvalidProtocolBufferException
import dev.barrelmaker.obscura.kit.AttachmentUpload
import dev.barrelmaker.obscura.kit.ObscuraError
import dev.barrelmaker.obscura.kit.stores.ContentStore
import dev.barrelmaker.obscura.kit.stores.ConversationItem
import dev.barrelmaker.obscura.kit.stores.MediaAttachment
import dev.barrelmaker.obscura.kit.stores.ProfileItem
import dev.barrelmaker.obscura.kit.stores.StoryItem
import obscura.client.v1.Client.EntrySnapshot
import obscura.client.v1.Client.HistorySnapshot

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
            .addAllMessages(messages.map(ConversationItem::toSnapshotRecord))
            .addAllStories(stories.map(StoryItem::toSnapshotRecord))
            .addAllProfiles(profiles.map(ProfileItem::toSnapshotRecord))
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
            if (m.id.isBlank() || m.peerUserId.isBlank() || m.authorUserId.isBlank()) return@mapNotNull null
            val viewedAt = m.viewedAt.takeIf { it > 0L }
            if (m.kind == "pix") {
                val att = if (m.hasAttachment()) MediaAttachment.fromProto(m.attachment) else null
                att?.let {
                    ConversationItem.pix(
                        id = m.id,
                        peerUserId = m.peerUserId,
                        authorUserId = m.authorUserId,
                        sentAt = m.sentAt,
                        attachment = it,
                        caption = m.caption.ifEmpty { null },
                        captionMeta = m.captionMeta.ifEmpty { null },
                        displayDuration = m.displayDurationSecs,
                        viewedAt = viewedAt,
                    )
                }
            } else {
                ConversationItem.message(
                    id = m.id,
                    peerUserId = m.peerUserId,
                    authorUserId = m.authorUserId,
                    sentAt = m.sentAt,
                    content = m.content,
                    viewedAt = viewedAt,
                )
            }
        }
        val stories = snapshot.storiesList.mapNotNull { s ->
            if (s.id.isBlank() || s.authorUserId.isBlank()) return@mapNotNull null
            val att = if (s.hasAttachment()) MediaAttachment.fromProto(s.attachment) else null
            StoryItem(
                id = s.id,
                authorUserId = s.authorUserId,
                sentAt = s.sentAt,
                content = s.content,
                attachment = att,
                captionMeta = s.captionMeta.ifEmpty { null },
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
            )
        }
        content.importSnapshot(messages, stories, profiles)
    }
}
