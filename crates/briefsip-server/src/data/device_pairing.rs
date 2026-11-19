use crate::{db, web::Failure};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use subtle::ConstantTimeEq;

type Result<T> = std::result::Result<T, Failure>;

const CODE_TTL: i64 = 120_000;
pub const COOKIE_AGE: i64 = 31_536_000_000;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Device {
    pub id: String,
    pub name: String,
    pub last_seen: i64,
}

pub fn initialize(db: &Connection) -> rusqlite::Result<()> {
    db.execute_batch(include_str!("device-pairing.sql"))
}

pub fn required(db: &Connection) -> Result<bool> {
    Ok(db.query_row(
        "SELECT coalesce((SELECT required FROM browser_pairing_settings WHERE id=1),0)",
        [],
        |row| row.get(0),
    )?)
}

pub fn set_required(db: &Connection, required: bool) -> Result<()> {
    db.execute(
        "INSERT INTO browser_pairing_settings VALUES(1,?) ON CONFLICT(id) DO UPDATE SET required=excluded.required",
        [required],
    )?;
    Ok(())
}

pub fn devices(db: &Connection, now: i64) -> Result<Vec<Device>> {
    let mut statement = db.prepare(
        "SELECT id,name,last_seen FROM browser_devices WHERE expires_at>? ORDER BY last_seen DESC,id",
    )?;
    let rows = statement.query_map([now], |row| {
        Ok(Device {
            id: row.get(0)?,
            name: row.get(1)?,
            last_seen: row.get(2)?,
        })
    })?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

pub fn revoke(db: &Connection, id: &str) -> Result<()> {
    db.execute("DELETE FROM browser_devices WHERE id=?", [id])?;
    Ok(())
}

pub fn device(db: &Connection, hash: &str, now: i64, seen: bool) -> Result<Option<String>> {
    let device: Option<(String, i64)> = db
        .query_row(
            "SELECT id,last_seen FROM browser_devices WHERE token_hash=? AND expires_at>?",
            params![hash, now],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    if let Some((id, last_seen)) = device {
        if seen && now - last_seen >= 60_000 {
            db.execute(
                "UPDATE browser_devices SET last_seen=? WHERE id=?",
                params![now, id],
            )?;
        }
        Ok(Some(id))
    } else {
        Ok(None)
    }
}

pub fn issue(db: &Connection, origin: &str, now: i64) -> Result<(String, i64)> {
    let code = loop {
        let mut bytes = [0; 4];
        getrandom::getrandom(&mut bytes).map_err(|_| Failure::storage())?;
        let value = u32::from_ne_bytes(bytes);
        if value < u32::MAX / 1_000_000 * 1_000_000 {
            break format!("{:06}", value % 1_000_000);
        }
    };
    let expiry = now + CODE_TTL;
    db.execute(
        "INSERT OR REPLACE INTO browser_pairing_challenge(id,origin,code,expires_at) VALUES(1,?,?,?)",
        params![origin, code, expiry],
    )?;
    Ok((code, expiry))
}

fn invalid_code() -> Failure {
    Failure::new(401, "pairing_code_invalid", "Code is invalid or expired.")
}

pub fn redeem(db: &Connection, origin: &str, code: &str, name: &str, now: i64) -> Result<String> {
    if code.len() != 6 || !code.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err(Failure::new(
            400,
            "pairing_code_format",
            "Enter a six-digit code.",
        ));
    }
    let name = name.trim();
    if name.is_empty() || name.chars().count() > 64 || name.chars().any(char::is_control) {
        return Err(Failure::new(
            400,
            "device_name_invalid",
            "Enter a device name of 1 to 64 characters.",
        ));
    }
    let transaction = db.unchecked_transaction()?;
    let (expected, attempts): (String, i64) = transaction.query_row(
        "SELECT code,attempts FROM browser_pairing_challenge WHERE id=1 AND origin=? AND expires_at>?",
        params![origin, now],
        |row| Ok((row.get(0)?, row.get(1)?)),
    ).optional()?.ok_or_else(invalid_code)?;
    if attempts == 0 {
        return Err(Failure::new(
            429,
            "pairing_rate_limited",
            "Too many attempts. Create a new code.",
        ));
    }
    if !bool::from(expected.as_bytes().ct_eq(code.as_bytes())) {
        transaction.execute(
            "UPDATE browser_pairing_challenge SET attempts=attempts-1 WHERE id=1",
            [],
        )?;
        transaction.commit()?;
        return Err(invalid_code());
    }
    let mut secret = [0; 32];
    getrandom::getrandom(&mut secret).map_err(|_| Failure::storage())?;
    let token = URL_SAFE_NO_PAD.encode(secret);
    transaction.execute(
        "INSERT INTO browser_devices VALUES(?,?,?,?,?)",
        params![
            uuid::Uuid::new_v4().to_string(),
            name,
            db::digest(&token),
            now,
            now + COOKIE_AGE
        ],
    )?;
    transaction.execute("DELETE FROM browser_pairing_challenge WHERE id=1", [])?;
    transaction.commit()?;
    Ok(token)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn setup() -> Connection {
        let db = Connection::open_in_memory().unwrap();
        initialize(&db).unwrap();
        db
    }

    const ORIGIN: &str = "https://briefsip.example";

    #[test]
    fn off_by_default_and_migration_preserves_setting() {
        let db = setup();
        assert!(!required(&db).unwrap());
        set_required(&db, true).unwrap();
        initialize(&db).unwrap();
        assert!(required(&db).unwrap());
    }

    #[test]
    fn code_expires_at_two_minutes_and_is_bound_to_origin() {
        let db = setup();
        let (code, expires) = issue(&db, ORIGIN, 10).unwrap();
        assert_eq!(expires, 120_010);
        assert_eq!(
            redeem(&db, "https://other.example", &code, "Phone", 11)
                .unwrap_err()
                .status,
            401
        );
        assert_eq!(
            redeem(&db, ORIGIN, &code, "Phone", expires)
                .unwrap_err()
                .status,
            401
        );
    }

    #[test]
    fn code_is_single_use_and_device_can_be_revoked() {
        let db = setup();
        let (code, _) = issue(&db, ORIGIN, 0).unwrap();
        let token = redeem(&db, ORIGIN, &code, "Phone", 1).unwrap();
        assert_eq!(
            redeem(&db, ORIGIN, &code, "Other phone", 2)
                .unwrap_err()
                .status,
            401
        );
        assert!(device(&db, &token, 2, false).unwrap().is_none());
        let hash = db::digest(&token);
        let id = device(&db, &hash, 70_000, true).unwrap().unwrap();
        let list = devices(&db, 70_000).unwrap();
        assert_eq!(list[0].name, "Phone");
        assert_eq!(list[0].last_seen, 70_000);
        revoke(&db, &id).unwrap();
        assert!(device(&db, &hash, 70_001, false).unwrap().is_none());
    }

    #[test]
    fn five_failed_attempts_lock_code() {
        let db = setup();
        let (code, _) = issue(&db, ORIGIN, 0).unwrap();
        let wrong = if code == "000000" { "000001" } else { "000000" };
        for _ in 0..5 {
            assert_eq!(
                redeem(&db, ORIGIN, wrong, "Phone", 1).unwrap_err().status,
                401
            );
        }
        assert_eq!(
            redeem(&db, ORIGIN, &code, "Phone", 1).unwrap_err().status,
            429
        );
        let (replacement, _) = issue(&db, ORIGIN, 2).unwrap();
        assert!(redeem(&db, ORIGIN, &replacement, "Phone", 3).is_ok());
    }
}
