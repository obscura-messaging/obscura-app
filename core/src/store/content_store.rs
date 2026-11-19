use rusqlite::{Connection, OptionalExtension, params};

use crate::error::ObscuraError;
use crate::types::{
    ConversationContent, ConversationItem, ConversationKind, EntryModel, MAX_EPHEMERAL_AGE_MS,
    MediaType, ProfileItem, StoredAttachment, StoryItem, expires_at,
};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FriendReplyAction {
    Accept,
    ReplyAccept,
}

impl FriendReplyAction {
    pub fn as_str(&self) -> &'static str {
        match self {
            FriendReplyAction::Accept => "accept",
            FriendReplyAction::ReplyAccept => "reply_accept",
        }
    }

    pub fn from_db(s: &str) -> Option<Self> {
        match s {
            "accept" => Some(FriendReplyAction::Accept),
            "reply_accept" => Some(FriendReplyAction::ReplyAccept),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PendingFriendReply {
    pub envelope_id: String,
    pub peer_user_id: String,
    pub action: FriendReplyAction,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SweepOutcome {
    pub purged_media_refs: Vec<String>,
    pub touched_models: Vec<EntryModel>,
    pub should_checkpoint: bool,
}

pub fn contains_envelope(conn: &Connection, envelope_id: &str) -> Result<bool, ObscuraError> {
    conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM processed_envelopes WHERE envelope_id = ?1)",
        params![envelope_id],
        |r| r.get(0),
    )
    .map_err(ObscuraError::from)
}

pub fn record_envelope(conn: &Connection, envelope_id: &str) -> Result<bool, ObscuraError> {
    if contains_envelope(conn, envelope_id)? {
        return Ok(false);
    }
    conn.execute(
        "INSERT OR IGNORE INTO processed_envelopes (envelope_id) VALUES (?1)",
        params![envelope_id],
    )?;
    if !contains_envelope(conn, envelope_id)? {
        return Err(ObscuraError::storage(format!(
            "processed envelope {envelope_id} is absent after insert"
        )));
    }
    Ok(true)
}

pub fn get_pending_friend_reply(
    conn: &Connection,
    envelope_id: &str,
) -> Result<Option<PendingFriendReply>, ObscuraError> {
    let row: Option<(String, String)> = conn
        .query_row(
            "SELECT peer_user_id, action FROM pending_friend_replies WHERE envelope_id = ?1",
            params![envelope_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?;
    match row {
        Some((peer_user_id, action_str)) => {
            let action = FriendReplyAction::from_db(&action_str).ok_or_else(|| {
                ObscuraError::storage(format!("Invalid pending friend reply action: {action_str}"))
            })?;
            Ok(Some(PendingFriendReply {
                envelope_id: envelope_id.to_owned(),
                peer_user_id,
                action,
            }))
        }
        None => Ok(None),
    }
}

pub fn put_pending_friend_reply(
    conn: &Connection,
    envelope_id: &str,
    peer_user_id: &str,
    action: FriendReplyAction,
) -> Result<(), ObscuraError> {
    conn.execute(
        "INSERT OR REPLACE INTO pending_friend_replies (envelope_id, peer_user_id, action) VALUES (?1, ?2, ?3)",
        params![envelope_id, peer_user_id, action.as_str()],
    )?;
    Ok(())
}

pub fn complete_pending_friend_reply(
    conn: &Connection,
    envelope_id: &str,
) -> Result<(), ObscuraError> {
    conn.execute(
        "DELETE FROM pending_friend_replies WHERE envelope_id = ?1",
        params![envelope_id],
    )?;
    conn.execute(
        "INSERT OR IGNORE INTO processed_envelopes (envelope_id) VALUES (?1)",
        params![envelope_id],
    )?;
    Ok(())
}

pub fn can_insert_conversation(conn: &Connection, id: &str) -> Result<bool, ObscuraError> {
    let erased: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM erased_entries WHERE id = ?1)",
        params![id],
        |r| r.get(0),
    )?;
    if erased {
        return Ok(false);
    }
    let exists: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM conversation_entries WHERE id = ?1)",
        params![id],
        |r| r.get(0),
    )?;
    Ok(!exists)
}

pub fn insert_conversation(
    conn: &Connection,
    item: &ConversationItem,
    attachment: Option<&StoredAttachment>,
) -> Result<(), ObscuraError> {
    let (content, caption, caption_meta, display_duration) = match &item.content {
        ConversationContent::Message { text } => (text.as_str(), None, None, 0i64),
        ConversationContent::Pix {
            caption,
            caption_meta,
            display_duration,
            ..
        } => (
            "",
            caption.as_deref(),
            caption_meta.as_deref(),
            *display_duration as i64,
        ),
    };
    conn.execute(
        "INSERT OR REPLACE INTO conversation_entries (
            id, peer_user_id, kind, author_user_id, sent_at, viewed_at, expires_at,
            content, media_ref, content_key, nonce, media_type, caption, caption_meta,
            display_duration, undelivered
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, 0)",
        params![
            item.id,
            item.peer_user_id,
            item.kind().as_str(),
            item.author_user_id,
            item.sent_at,
            item.viewed_at,
            item.expires_at(),
            content,
            attachment.map(|a| a.id.as_str()),
            attachment.map(|a| a.content_key.as_slice()),
            attachment.map(|a| a.nonce.as_slice()),
            attachment.map(|a| a.media_type.as_str()),
            caption,
            caption_meta,
            display_duration,
        ],
    )?;
    Ok(())
}

pub fn get_conversation(
    conn: &Connection,
    id: &str,
) -> Result<Option<ConversationItem>, ObscuraError> {
    conn.query_row(
        "SELECT id, peer_user_id, kind, author_user_id, sent_at, viewed_at,
                content, media_ref, content_key, nonce, media_type, caption, caption_meta,
                display_duration
         FROM conversation_entries WHERE id = ?1",
        params![id],
        row_to_conversation,
    )
    .optional()
    .map_err(ObscuraError::from)
}

pub fn get_messages(conn: &Connection) -> Result<Vec<ConversationItem>, ObscuraError> {
    let mut stmt = conn.prepare(
        "SELECT id, peer_user_id, kind, author_user_id, sent_at, viewed_at,
                content, media_ref, content_key, nonce, media_type, caption, caption_meta,
                display_duration
         FROM conversation_entries ORDER BY sent_at ASC, id ASC",
    )?;
    let rows = stmt.query_map([], row_to_conversation)?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(ObscuraError::from)
}

pub fn get_messages_with_attachments(
    conn: &Connection,
) -> Result<Vec<(ConversationItem, Option<StoredAttachment>)>, ObscuraError> {
    let mut stmt = conn.prepare(
        "SELECT id, peer_user_id, kind, author_user_id, sent_at, viewed_at,
                content, media_ref, content_key, nonce, media_type, caption, caption_meta,
                display_duration
         FROM conversation_entries ORDER BY sent_at ASC, id ASC",
    )?;
    let rows = stmt.query_map([], row_to_conversation_with_attachment)?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(ObscuraError::from)
}

pub fn get_undelivered_messages(
    conn: &Connection,
) -> Result<Vec<(ConversationItem, Option<StoredAttachment>)>, ObscuraError> {
    let mut stmt = conn.prepare(
        "SELECT id, peer_user_id, kind, author_user_id, sent_at, viewed_at,
                content, media_ref, content_key, nonce, media_type, caption, caption_meta,
                display_duration
         FROM conversation_entries WHERE undelivered = 1 ORDER BY sent_at ASC, id ASC",
    )?;
    let rows = stmt.query_map([], row_to_conversation_with_attachment)?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(ObscuraError::from)
}

pub fn mark_conversation_viewed(
    conn: &Connection,
    id: &str,
    viewed_at: i64,
) -> Result<(), ObscuraError> {
    let Some(sent_at): Option<i64> = conn
        .query_row(
            "SELECT sent_at FROM conversation_entries WHERE id = ?1 AND viewed_at IS NULL",
            params![id],
            |r| r.get(0),
        )
        .optional()?
    else {
        return Ok(());
    };
    let exp = expires_at(sent_at, Some(viewed_at));
    conn.execute(
        "UPDATE conversation_entries
         SET viewed_at = ?1, expires_at = ?2
         WHERE id = ?3 AND viewed_at IS NULL",
        params![viewed_at, exp, id],
    )?;
    Ok(())
}

pub fn set_conversation_undelivered(
    conn: &Connection,
    id: &str,
    undelivered: bool,
) -> Result<(), ObscuraError> {
    conn.execute(
        "UPDATE conversation_entries SET undelivered = ?1 WHERE id = ?2",
        params![i64::from(undelivered), id],
    )?;
    Ok(())
}

pub fn get_attachment(
    conn: &Connection,
    entry_id: &str,
    now_ms: i64,
) -> Result<Option<StoredAttachment>, ObscuraError> {
    let mut stmt = conn.prepare(
        "SELECT media_ref, content_key, nonce, media_type
         FROM conversation_entries WHERE id = ?1 AND expires_at > ?2
         UNION ALL
         SELECT media_ref, content_key, nonce, media_type
         FROM story_entries WHERE id = ?1 AND expires_at > ?2",
    )?;
    let rows = stmt.query_map(params![entry_id, now_ms], |r| {
        Ok((
            r.get::<_, Option<String>>(0)?,
            r.get::<_, Option<Vec<u8>>>(1)?,
            r.get::<_, Option<Vec<u8>>>(2)?,
            r.get::<_, Option<String>>(3)?,
        ))
    })?;
    for row in rows {
        let (media_ref, content_key, nonce, media_type) = row?;
        if let Some(att) = to_attachment(media_ref, content_key, nonce, media_type) {
            return Ok(Some(att));
        }
    }
    Ok(None)
}

pub fn can_insert_story(conn: &Connection, id: &str) -> Result<bool, ObscuraError> {
    let erased: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM erased_entries WHERE id = ?1)",
        params![id],
        |r| r.get(0),
    )?;
    if erased {
        return Ok(false);
    }
    let exists: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM story_entries WHERE id = ?1)",
        params![id],
        |r| r.get(0),
    )?;
    Ok(!exists)
}

pub fn insert_story(
    conn: &Connection,
    item: &StoryItem,
    attachment: Option<&StoredAttachment>,
) -> Result<(), ObscuraError> {
    conn.execute(
        "INSERT OR REPLACE INTO story_entries (
            id, author_user_id, sent_at, expires_at, content,
            media_ref, content_key, nonce, media_type, caption_meta, undelivered
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, 0)",
        params![
            item.id,
            item.author_user_id,
            item.sent_at,
            item.expires_at(),
            item.content,
            attachment.map(|a| a.id.as_str()),
            attachment.map(|a| a.content_key.as_slice()),
            attachment.map(|a| a.nonce.as_slice()),
            attachment.map(|a| a.media_type.as_str()),
            item.caption_meta,
        ],
    )?;
    Ok(())
}

pub fn set_story_undelivered(
    conn: &Connection,
    id: &str,
    undelivered: bool,
) -> Result<(), ObscuraError> {
    conn.execute(
        "UPDATE story_entries SET undelivered = ?1 WHERE id = ?2",
        params![i64::from(undelivered), id],
    )?;
    Ok(())
}

pub fn get_stories(conn: &Connection, now: i64) -> Result<Vec<StoryItem>, ObscuraError> {
    let mut stmt = conn.prepare(
        "SELECT id, author_user_id, sent_at, content,
                media_ref, content_key, nonce, media_type, caption_meta
         FROM story_entries WHERE expires_at > ?1 ORDER BY sent_at ASC, id ASC",
    )?;
    let rows = stmt.query_map(params![now], row_to_story)?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(ObscuraError::from)
}

pub fn get_all_stories(
    conn: &Connection,
) -> Result<Vec<(StoryItem, Option<StoredAttachment>)>, ObscuraError> {
    let mut stmt = conn.prepare(
        "SELECT id, author_user_id, sent_at, content,
                media_ref, content_key, nonce, media_type, caption_meta
         FROM story_entries ORDER BY sent_at ASC, id ASC",
    )?;
    let rows = stmt.query_map([], row_to_story_with_attachment)?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(ObscuraError::from)
}

pub fn get_undelivered_stories(
    conn: &Connection,
) -> Result<Vec<(StoryItem, Option<StoredAttachment>)>, ObscuraError> {
    let mut stmt = conn.prepare(
        "SELECT id, author_user_id, sent_at, content,
                media_ref, content_key, nonce, media_type, caption_meta
         FROM story_entries WHERE undelivered = 1 ORDER BY sent_at ASC, id ASC",
    )?;
    let rows = stmt.query_map([], row_to_story_with_attachment)?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(ObscuraError::from)
}

pub fn get_profile(conn: &Connection, user_id: &str) -> Result<Option<ProfileItem>, ObscuraError> {
    conn.query_row(
        "SELECT user_id, author_device_id, updated_at, display_name, bio
         FROM profile_entries WHERE user_id = ?1",
        params![user_id],
        row_to_profile,
    )
    .optional()
    .map_err(ObscuraError::from)
}

pub fn upsert_profile_if_newer(
    conn: &Connection,
    item: &ProfileItem,
) -> Result<bool, ObscuraError> {
    let existing = get_profile(conn, &item.user_id)?;
    let wins = match existing {
        None => true,
        Some(ref ex) => {
            item.updated_at > ex.updated_at
                || (item.updated_at == ex.updated_at && item.author_device_id > ex.author_device_id)
        }
    };
    if wins {
        insert_profile(conn, item)?;
    }
    Ok(wins)
}

pub fn insert_profile(conn: &Connection, item: &ProfileItem) -> Result<(), ObscuraError> {
    conn.execute(
        "INSERT OR REPLACE INTO profile_entries (
            user_id, author_device_id, updated_at, display_name, bio, undelivered
        ) VALUES (?1, ?2, ?3, ?4, ?5, 0)",
        params![
            item.user_id,
            item.author_device_id,
            item.updated_at,
            item.display_name,
            item.bio,
        ],
    )?;
    Ok(())
}

pub fn set_profile_undelivered(
    conn: &Connection,
    user_id: &str,
    updated_at: i64,
    undelivered: bool,
) -> Result<(), ObscuraError> {
    conn.execute(
        "UPDATE profile_entries SET undelivered = ?1 WHERE user_id = ?2 AND updated_at = ?3",
        params![i64::from(undelivered), user_id, updated_at],
    )?;
    Ok(())
}

pub fn get_profiles(conn: &Connection) -> Result<Vec<ProfileItem>, ObscuraError> {
    let mut stmt = conn.prepare(
        "SELECT user_id, author_device_id, updated_at, display_name, bio
         FROM profile_entries ORDER BY user_id ASC",
    )?;
    let rows = stmt.query_map([], row_to_profile)?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(ObscuraError::from)
}

pub fn get_undelivered_profiles(conn: &Connection) -> Result<Vec<ProfileItem>, ObscuraError> {
    let mut stmt = conn.prepare(
        "SELECT user_id, author_device_id, updated_at, display_name, bio
         FROM profile_entries WHERE undelivered = 1 ORDER BY user_id ASC",
    )?;
    let rows = stmt.query_map([], row_to_profile)?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(ObscuraError::from)
}

pub fn import_snapshot(
    conn: &Connection,
    messages: &[(ConversationItem, Option<StoredAttachment>)],
    stories: &[(StoryItem, Option<StoredAttachment>)],
    profiles: &[ProfileItem],
) -> Result<(), ObscuraError> {
    for (m, att) in messages {
        if can_insert_conversation(conn, &m.id)? {
            insert_conversation(conn, m, att.as_ref())?;
        }
    }
    for (s, att) in stories {
        if can_insert_story(conn, &s.id)? {
            insert_story(conn, s, att.as_ref())?;
        }
    }
    for p in profiles {
        upsert_profile_if_newer(conn, p)?;
    }
    Ok(())
}

pub fn sweep_expired_in_tx(conn: &Connection, now: i64) -> Result<SweepOutcome, ObscuraError> {
    conn.execute_batch("PRAGMA secure_delete = ON;")?;

    let mut expired_msgs_stmt = conn
        .prepare("SELECT id, kind, media_ref FROM conversation_entries WHERE expires_at <= ?1")?;
    let expired_messages: Vec<(String, String, Option<String>)> = expired_msgs_stmt
        .query_map(params![now], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
        .collect::<Result<Vec<_>, _>>()?;

    let mut expired_stories_stmt =
        conn.prepare("SELECT id, media_ref FROM story_entries WHERE expires_at <= ?1")?;
    let expired_stories: Vec<(String, Option<String>)> = expired_stories_stmt
        .query_map(params![now], |r| Ok((r.get(0)?, r.get(1)?)))?
        .collect::<Result<Vec<_>, _>>()?;

    let mut touched_models = Vec::new();
    if expired_messages
        .iter()
        .any(|(_, kind, _)| kind == ConversationKind::Message.as_str())
    {
        touched_models.push(EntryModel::DirectMessage);
    }
    if expired_messages
        .iter()
        .any(|(_, kind, _)| kind == ConversationKind::Pix.as_str())
    {
        touched_models.push(EntryModel::Pix);
    }
    if !expired_stories.is_empty() {
        touched_models.push(EntryModel::Story);
    }

    for (id, _, media_ref) in &expired_messages {
        if let Some(mref) = media_ref
            && !mref.trim().is_empty()
        {
            conn.execute(
                "INSERT OR IGNORE INTO pending_media_purges (media_ref) VALUES (?1)",
                params![mref],
            )?;
        }
        conn.execute(
            "INSERT OR REPLACE INTO erased_entries (id, erased_at) VALUES (?1, ?2)",
            params![id, now],
        )?;
        conn.execute(
            "DELETE FROM conversation_entries WHERE id = ?1",
            params![id],
        )?;
    }

    for (id, media_ref) in &expired_stories {
        if let Some(mref) = media_ref
            && !mref.trim().is_empty()
        {
            conn.execute(
                "INSERT OR IGNORE INTO pending_media_purges (media_ref) VALUES (?1)",
                params![mref],
            )?;
        }
        conn.execute(
            "INSERT OR REPLACE INTO erased_entries (id, erased_at) VALUES (?1, ?2)",
            params![id, now],
        )?;
        conn.execute("DELETE FROM story_entries WHERE id = ?1", params![id])?;
    }

    let erased_deleted = conn.execute(
        "DELETE FROM erased_entries WHERE erased_at <= ?1",
        params![now - MAX_EPHEMERAL_AGE_MS],
    )?;

    let mut pending_stmt =
        conn.prepare("SELECT media_ref FROM pending_media_purges ORDER BY media_ref")?;
    let purged_media_refs: Vec<String> = pending_stmt
        .query_map([], |r| r.get(0))?
        .collect::<Result<Vec<_>, _>>()?;

    let should_checkpoint = !expired_messages.is_empty()
        || !expired_stories.is_empty()
        || erased_deleted > 0
        || !purged_media_refs.is_empty();

    Ok(SweepOutcome {
        purged_media_refs,
        touched_models,
        should_checkpoint,
    })
}

pub fn remove_pending_media_purge(conn: &Connection, media_ref: &str) -> Result<(), ObscuraError> {
    conn.execute(
        "DELETE FROM pending_media_purges WHERE media_ref = ?1",
        params![media_ref],
    )?;
    Ok(())
}

fn to_attachment(
    media_ref: Option<String>,
    content_key: Option<Vec<u8>>,
    nonce: Option<Vec<u8>>,
    media_type: Option<String>,
) -> Option<StoredAttachment> {
    let id = media_ref?;
    if id.trim().is_empty() {
        return None;
    }
    let content_key = content_key?;
    let nonce = nonce?;
    Some(StoredAttachment {
        id,
        content_key,
        nonce,
        media_type: MediaType::from_wire(media_type.as_deref().unwrap_or("")),
    })
}

fn row_to_conversation(r: &rusqlite::Row<'_>) -> rusqlite::Result<ConversationItem> {
    row_to_conversation_with_attachment(r).map(|(item, _)| item)
}

fn row_to_conversation_with_attachment(
    r: &rusqlite::Row<'_>,
) -> rusqlite::Result<(ConversationItem, Option<StoredAttachment>)> {
    let kind_str: String = r.get(2)?;
    let kind = ConversationKind::from_wire(&kind_str).map_err(|e| {
        rusqlite::Error::FromSqlConversionFailure(
            2,
            rusqlite::types::Type::Text,
            Box::new(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                e.to_string(),
            )),
        )
    })?;
    let text: String = r.get(6)?;
    let attachment = to_attachment(r.get(7)?, r.get(8)?, r.get(9)?, r.get(10)?);
    let caption: Option<String> = r.get(11)?;
    let caption_meta: Option<String> = r.get(12)?;
    let display_duration: i64 = r.get(13)?;
    let content = match kind {
        ConversationKind::Pix => {
            let Some(ref att) = attachment else {
                return Err(rusqlite::Error::FromSqlConversionFailure(
                    7,
                    rusqlite::types::Type::Text,
                    Box::new(std::io::Error::new(
                        std::io::ErrorKind::InvalidData,
                        "pix requires an attachment",
                    )),
                ));
            };
            ConversationContent::Pix {
                attachment: att.as_ref(),
                caption,
                caption_meta,
                display_duration: display_duration as i32,
            }
        }
        ConversationKind::Message => {
            if attachment.is_some()
                || caption.is_some()
                || caption_meta.is_some()
                || display_duration != 0
            {
                return Err(rusqlite::Error::FromSqlConversionFailure(
                    2,
                    rusqlite::types::Type::Text,
                    Box::new(std::io::Error::new(
                        std::io::ErrorKind::InvalidData,
                        "message cannot carry pix fields",
                    )),
                ));
            }
            ConversationContent::Message { text }
        }
    };
    Ok((
        ConversationItem {
            id: r.get(0)?,
            peer_user_id: r.get(1)?,
            author_user_id: r.get(3)?,
            sent_at: r.get(4)?,
            viewed_at: r.get(5)?,
            content,
        },
        attachment,
    ))
}

fn row_to_story(r: &rusqlite::Row<'_>) -> rusqlite::Result<StoryItem> {
    row_to_story_with_attachment(r).map(|(item, _)| item)
}

fn row_to_story_with_attachment(
    r: &rusqlite::Row<'_>,
) -> rusqlite::Result<(StoryItem, Option<StoredAttachment>)> {
    let attachment = to_attachment(r.get(4)?, r.get(5)?, r.get(6)?, r.get(7)?);
    Ok((
        StoryItem {
            id: r.get(0)?,
            author_user_id: r.get(1)?,
            sent_at: r.get(2)?,
            content: r.get(3)?,
            attachment: attachment.as_ref().map(StoredAttachment::as_ref),
            caption_meta: r.get(8)?,
        },
        attachment,
    ))
}

fn row_to_profile(r: &rusqlite::Row<'_>) -> rusqlite::Result<ProfileItem> {
    Ok(ProfileItem {
        user_id: r.get(0)?,
        author_device_id: r.get(1)?,
        updated_at: r.get(2)?,
        display_name: r.get(3)?,
        bio: r.get(4)?,
    })
}
