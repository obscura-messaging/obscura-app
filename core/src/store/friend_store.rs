use rusqlite::{Connection, OptionalExtension, params};

use crate::error::ObscuraError;
use crate::store::{DbContext, PostCommitEffect};
use crate::types::{Friend, FriendStatus};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FriendList {
    pub version: u64,
    pub friends: Vec<Friend>,
}

pub fn get(conn: &Connection, user_id: &str) -> Result<Option<Friend>, ObscuraError> {
    conn.query_row(
        "SELECT user_id, username, status FROM friends WHERE user_id = ?1",
        params![user_id],
        row_to_friend,
    )
    .optional()
    .map_err(ObscuraError::from)
}

pub fn get_all(conn: &Connection) -> Result<Vec<Friend>, ObscuraError> {
    let mut stmt =
        conn.prepare("SELECT user_id, username, status FROM friends ORDER BY username, user_id")?;
    let rows = stmt.query_map([], row_to_friend)?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(ObscuraError::from)
}

pub fn version(conn: &Connection) -> Result<u64, ObscuraError> {
    let raw: Option<i64> = conn
        .query_row(
            "SELECT version FROM friend_list_version WHERE id = 1",
            [],
            |r| r.get(0),
        )
        .optional()?;
    Ok(raw.unwrap_or(0) as u64)
}

pub fn list(conn: &Connection) -> Result<FriendList, ObscuraError> {
    Ok(FriendList {
        version: version(conn)?,
        friends: get_all(conn)?,
    })
}

pub fn add(
    ctx: &mut DbContext<'_>,
    user_id: &str,
    username: &str,
    status: FriendStatus,
) -> Result<(), ObscuraError> {
    ctx.conn.execute(
        "INSERT OR REPLACE INTO friends (user_id, username, status) VALUES (?1, ?2, ?3)",
        params![user_id, username, status.as_str()],
    )?;
    increment_version(ctx.conn)?;
    ctx.push_effect(PostCommitEffect::FriendsChanged);
    Ok(())
}

pub fn update_status(
    ctx: &mut DbContext<'_>,
    user_id: &str,
    status: FriendStatus,
) -> Result<bool, ObscuraError> {
    let changed = ctx.conn.execute(
        "UPDATE friends SET status = ?1 WHERE user_id = ?2 AND status != ?1",
        params![status.as_str(), user_id],
    )?;
    if changed > 0 {
        increment_version(ctx.conn)?;
        ctx.push_effect(PostCommitEffect::FriendsChanged);
        Ok(true)
    } else {
        Ok(false)
    }
}

pub fn prepare_request(
    ctx: &mut DbContext<'_>,
    user_id: &str,
    username: &str,
) -> Result<Option<Friend>, ObscuraError> {
    if let Some(existing) = get(ctx.conn, user_id)? {
        return Ok(Some(existing));
    }
    add(ctx, user_id, username, FriendStatus::PendingSent)?;
    Ok(None)
}

pub fn remove_pending_request(
    ctx: &mut DbContext<'_>,
    user_id: &str,
) -> Result<bool, ObscuraError> {
    let changed = ctx.conn.execute(
        "DELETE FROM friends WHERE user_id = ?1 AND status = ?2",
        params![user_id, FriendStatus::PendingSent.as_str()],
    )?;
    if changed > 0 {
        increment_version(ctx.conn)?;
        ctx.push_effect(PostCommitEffect::FriendsChanged);
        Ok(true)
    } else {
        Ok(false)
    }
}

pub fn remove(ctx: &mut DbContext<'_>, user_id: &str) -> Result<bool, ObscuraError> {
    let changed = ctx
        .conn
        .execute("DELETE FROM friends WHERE user_id = ?1", params![user_id])?;
    if changed > 0 {
        increment_version(ctx.conn)?;
        ctx.push_effect(PostCommitEffect::FriendsChanged);
        Ok(true)
    } else {
        Ok(false)
    }
}

pub fn replace(ctx: &mut DbContext<'_>, list: &FriendList) -> Result<(), ObscuraError> {
    ctx.conn.execute("DELETE FROM friends", [])?;
    for f in &list.friends {
        ctx.conn.execute(
            "INSERT OR REPLACE INTO friends (user_id, username, status) VALUES (?1, ?2, ?3)",
            params![f.user_id, f.username, f.status.as_str()],
        )?;
    }
    ctx.conn.execute(
        "INSERT OR REPLACE INTO friend_list_version (id, version) VALUES (1, ?1)",
        params![list.version as i64],
    )?;
    ctx.push_effect(PostCommitEffect::FriendsChanged);
    Ok(())
}

fn increment_version(conn: &Connection) -> Result<(), ObscuraError> {
    conn.execute(
        "INSERT INTO friend_list_version (id, version) VALUES (1, 1)
         ON CONFLICT(id) DO UPDATE SET version = version + 1",
        [],
    )?;
    Ok(())
}

fn row_to_friend(r: &rusqlite::Row<'_>) -> rusqlite::Result<Friend> {
    let user_id: String = r.get(0)?;
    let username: String = r.get(1)?;
    let status_str: String = r.get(2)?;
    let status = FriendStatus::from_db(&status_str).ok_or_else(|| {
        rusqlite::Error::FromSqlConversionFailure(
            2,
            rusqlite::types::Type::Text,
            Box::new(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                format!("Invalid friend status: {status_str}"),
            )),
        )
    })?;
    Ok(Friend {
        user_id,
        username,
        status,
    })
}
