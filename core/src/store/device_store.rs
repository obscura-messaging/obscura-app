use rusqlite::{Connection, OptionalExtension, params};

use crate::error::ObscuraError;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LocalDevice {
    pub device_id: String,
    pub primary_device_id: String,
}

impl LocalDevice {
    pub fn is_primary(&self) -> bool {
        self.device_id == self.primary_device_id
    }
}

pub fn get_local(conn: &Connection) -> Result<Option<LocalDevice>, ObscuraError> {
    conn.query_row(
        "SELECT device_id, primary_device_id FROM device_identity WHERE id = 1",
        [],
        |r| {
            Ok(LocalDevice {
                device_id: r.get(0)?,
                primary_device_id: r.get(1)?,
            })
        },
    )
    .optional()
    .map_err(ObscuraError::from)
}

pub fn store_local(
    conn: &Connection,
    user_id: &str,
    local: &LocalDevice,
) -> Result<(), ObscuraError> {
    conn.execute(
        "INSERT OR REPLACE INTO device_identity (id, device_id, primary_device_id) VALUES (1, ?1, ?2)",
        params![local.device_id, local.primary_device_id],
    )?;
    add(conn, user_id, &local.device_id)
}

pub fn add(conn: &Connection, user_id: &str, device_id: &str) -> Result<(), ObscuraError> {
    let existing: Option<String> = conn
        .query_row(
            "SELECT user_id FROM devices WHERE device_id = ?1",
            params![device_id],
            |r| r.get(0),
        )
        .optional()?;
    if let Some(owner) = existing
        && owner != user_id
    {
        return Err(ObscuraError::protocol(format!(
            "Device {device_id} belongs to {owner}, not {user_id}"
        )));
    }
    conn.execute(
        "INSERT OR REPLACE INTO devices (user_id, device_id) VALUES (?1, ?2)",
        params![user_id, device_id],
    )?;
    Ok(())
}

pub fn add_many(
    conn: &Connection,
    user_id: &str,
    device_ids: &[String],
) -> Result<(), ObscuraError> {
    for device_id in device_ids {
        add(conn, user_id, device_id)?;
    }
    Ok(())
}

pub fn remove(conn: &Connection, user_id: &str, device_ids: &[String]) -> Result<(), ObscuraError> {
    for device_id in device_ids {
        let deleted = conn.execute(
            "DELETE FROM devices WHERE user_id = ?1 AND device_id = ?2",
            params![user_id, device_id],
        )?;
        if deleted > 0 {
            conn.execute(
                "DELETE FROM signal_sessions WHERE address = ?1",
                params![format!("{device_id}.1")],
            )?;
        }
    }
    Ok(())
}

pub fn remove_by_user(conn: &Connection, user_id: &str) -> Result<(), ObscuraError> {
    conn.execute(
        "DELETE FROM signal_sessions WHERE address IN (SELECT device_id || '.1' FROM devices WHERE user_id = ?1)",
        params![user_id],
    )?;
    conn.execute("DELETE FROM devices WHERE user_id = ?1", params![user_id])?;
    Ok(())
}

pub fn devices_of(conn: &Connection, user_id: &str) -> Result<Vec<String>, ObscuraError> {
    let mut stmt =
        conn.prepare("SELECT device_id FROM devices WHERE user_id = ?1 ORDER BY device_id")?;
    let rows = stmt.query_map(params![user_id], |r| r.get::<_, String>(0))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(ObscuraError::from)
}

pub fn user_of(conn: &Connection, device_id: &str) -> Result<Option<String>, ObscuraError> {
    conn.query_row(
        "SELECT user_id FROM devices WHERE device_id = ?1",
        params![device_id],
        |r| r.get(0),
    )
    .optional()
    .map_err(ObscuraError::from)
}
