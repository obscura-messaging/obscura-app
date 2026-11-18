use rusqlite::Connection;

use crate::error::ObscuraError;
use crate::proto::client::EntrySnapshot;
use crate::store::content_store;
use crate::types::{ConversationItem, ConversationKind, MediaAttachment, ProfileItem, StoryItem};

pub fn export_snapshot(conn: &Connection) -> Result<Option<EntrySnapshot>, ObscuraError> {
    let messages = content_store::get_messages(conn)?;
    let stories = content_store::get_all_stories(conn)?;
    let profiles = content_store::get_profiles(conn)?;
    if messages.is_empty() && stories.is_empty() && profiles.is_empty() {
        return Ok(None);
    }
    Ok(Some(EntrySnapshot {
        messages: messages
            .iter()
            .map(ConversationItem::to_snapshot_record)
            .collect(),
        stories: stories.iter().map(StoryItem::to_snapshot_record).collect(),
        profiles: profiles
            .iter()
            .map(ProfileItem::to_snapshot_record)
            .collect(),
    }))
}

pub fn import_snapshot(conn: &Connection, snapshot: &EntrySnapshot) -> Result<(), ObscuraError> {
    let messages: Vec<ConversationItem> = snapshot
        .messages
        .iter()
        .filter_map(|m| {
            if m.id.trim().is_empty()
                || m.peer_user_id.trim().is_empty()
                || m.author_user_id.trim().is_empty()
            {
                return None;
            }
            let sent_at = i64::try_from(m.sent_at).unwrap_or(i64::MAX);
            let viewed_at =
                (m.viewed_at > 0).then(|| i64::try_from(m.viewed_at).unwrap_or(i64::MAX));
            if m.kind == ConversationKind::Pix.as_str() {
                let att = m
                    .attachment
                    .as_ref()
                    .and_then(MediaAttachment::from_proto)?;
                Some(ConversationItem::pix(
                    m.id.clone(),
                    m.peer_user_id.clone(),
                    m.author_user_id.clone(),
                    sent_at,
                    att,
                    (!m.caption.is_empty()).then(|| m.caption.clone()),
                    (!m.caption_meta.is_empty()).then(|| m.caption_meta.clone()),
                    m.display_duration_secs as i32,
                    viewed_at,
                    false,
                ))
            } else {
                Some(ConversationItem::message(
                    m.id.clone(),
                    m.peer_user_id.clone(),
                    m.author_user_id.clone(),
                    sent_at,
                    m.content.clone(),
                    viewed_at,
                    false,
                ))
            }
        })
        .collect();

    let stories: Vec<StoryItem> = snapshot
        .stories
        .iter()
        .filter_map(|s| {
            if s.id.trim().is_empty() || s.author_user_id.trim().is_empty() {
                return None;
            }
            let att = s.attachment.as_ref().and_then(MediaAttachment::from_proto);
            Some(StoryItem::new(
                s.id.clone(),
                s.author_user_id.clone(),
                i64::try_from(s.sent_at).unwrap_or(i64::MAX),
                s.content.clone(),
                att,
                (!s.caption_meta.is_empty()).then(|| s.caption_meta.clone()),
                false,
            ))
        })
        .collect();

    let profiles: Vec<ProfileItem> = snapshot
        .profiles
        .iter()
        .filter_map(|p| {
            if p.user_id.trim().is_empty() {
                return None;
            }
            Some(ProfileItem {
                user_id: p.user_id.clone(),
                author_device_id: p.author_device_id.clone(),
                updated_at: i64::try_from(p.updated_at).unwrap_or(i64::MAX),
                display_name: p.display_name.clone(),
                bio: p.bio.clone(),
                undelivered: false,
            })
        })
        .collect();

    content_store::import_snapshot(conn, &messages, &stories, &profiles)
}
