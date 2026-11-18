use crate::{
    config::AuthConfig,
    db::{self, Database},
    web::Failure,
};
use axum::http::{HeaderMap, Method};
use jsonwebtoken::{decode, decode_header, jwk::JwkSet, Algorithm, DecodingKey, Validation};
use rusqlite::OptionalExtension;
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};
use tokio::sync::Mutex as AsyncMutex;

#[derive(Clone)]
pub struct Auth {
    config: AuthConfig,
    bridge: Option<crate::data::options::CanonicalBridge>,
    client: reqwest::Client,
    keys: Arc<AsyncMutex<Option<(i64, JwkSet)>>>,
}
pub struct Actor {
    pub account: String,
    pub subject: String,
    pub session: String,
    pub expires: i64,
}
fn denied() -> Failure {
    Failure::new(401, "session_invalid", "Session is invalid or expired.")
}

impl Auth {
    pub fn new(
        config: AuthConfig,
        bridge: Option<crate::data::options::CanonicalBridge>,
    ) -> db::Result<Self> {
        Ok(Self {
            config,
            bridge,
            client: reqwest::Client::builder()
                .no_proxy()
                .redirect(reqwest::redirect::Policy::none())
                .timeout(std::time::Duration::from_secs(5))
                .build()?,
            keys: Arc::new(AsyncMutex::new(None)),
        })
    }
    async fn key(&self, token: &str, now: i64) -> Result<DecodingKey, Failure> {
        if let Some(pem) = &self.config.jwt_key {
            return DecodingKey::from_rsa_pem(pem.as_bytes()).map_err(|_| denied());
        }
        let header = decode_header(token).map_err(|_| denied())?;
        let kid = header.kid.ok_or_else(denied)?;
        let mut keys = self.keys.lock().await;
        if let Some((expires, set)) = keys.as_ref() {
            if *expires > now {
                if let Some(key) = set.find(&kid) {
                    return DecodingKey::from_jwk(key).map_err(|_| denied());
                }
            }
        }
        if let Some(bridge) = self.bridge.as_ref().filter(|b| b.clerk) {
            let set: JwkSet = serde_json::from_value(
                bridge
                    .call("clerk-keys", &json!({}))
                    .map_err(|_| denied())?,
            )
            .map_err(|_| denied())?;
            let key = set
                .find(&kid)
                .and_then(|key| DecodingKey::from_jwk(key).ok());
            *keys = Some((now + 300000, set));
            return key.ok_or_else(denied);
        }
        let base = self
            .config
            .api_url
            .as_deref()
            .unwrap_or("https://api.clerk.com");
        let mut response = self
            .client
            .get(format!("{base}/v1/jwks"))
            .bearer_auth(&self.config.secret_key)
            .send()
            .await
            .map_err(|_| denied())?;
        if !response.status().is_success() {
            return Err(denied());
        }
        let mut bytes = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(|_| denied())? {
            if bytes.len() + chunk.len() > 65536 {
                return Err(denied());
            }
            bytes.extend_from_slice(&chunk);
        }
        let set: JwkSet = serde_json::from_slice(&bytes).map_err(|_| denied())?;
        let key = set
            .find(&kid)
            .and_then(|key| DecodingKey::from_jwk(key).ok());
        *keys = Some((now + 300_000, set));
        key.ok_or_else(denied)
    }
    pub async fn authenticate(
        &self,
        db: &Mutex<Database>,
        headers: &HeaderMap,
        method: &Method,
        now: i64,
    ) -> Result<Actor, Failure> {
        let bearer = headers
            .get("authorization")
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.strip_prefix("Bearer "))
            .filter(|value| {
                !value.is_empty() && !value.chars().any(|c| c.is_whitespace() || c == ',')
            })
            .ok_or_else(denied)?;
        if !matches!(*method, Method::GET | Method::HEAD)
            && headers.get("origin").and_then(|value| value.to_str().ok())
                != Some(self.config.origin.as_str())
        {
            return Err(Failure::new(403, "origin_denied", "Origin is not allowed."));
        }
        if decode_header(bearer).map_err(|_| denied())?.alg != Algorithm::RS256 {
            return Err(denied());
        }
        let key = self.key(bearer, now).await?;
        let mut validation = Validation::new(Algorithm::RS256);
        validation.leeway = 0;
        validation.validate_exp = false;
        validation.validate_nbf = false;
        validation.set_issuer(&[&self.config.issuer]);
        validation.validate_aud = false;
        let claims: Value = decode(bearer, &key, &validation)
            .map_err(|_| denied())?
            .claims;
        let string = |key| {
            claims
                .get(key)
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty())
                .ok_or_else(denied)
        };
        let issuer = string("iss")?;
        let subject = string("sub")?;
        let sid = string("sid")?;
        let exp = claims["exp"]
            .as_i64()
            .filter(|value| value.unsigned_abs() <= 9_007_199_254_740_991)
            .and_then(|value| value.checked_mul(1000))
            .ok_or_else(denied)?;
        let nbf = claims["nbf"]
            .as_i64()
            .filter(|value| value.unsigned_abs() <= 9_007_199_254_740_991)
            .and_then(|value| value.checked_mul(1000))
            .ok_or_else(denied)?;
        if issuer != self.config.issuer
            || claims["azp"].as_str() != Some(&self.config.origin)
            || exp <= now
            || nbf > now
            || claims["sts"] == "pending"
        {
            return Err(denied());
        }
        if let Some(audience) = &self.config.audience {
            if claims["aud"].as_str() != Some(audience)
                && !claims["aud"]
                    .as_array()
                    .is_some_and(|items| items.iter().any(|item| item.as_str() == Some(audience)))
            {
                return Err(denied());
            }
        }
        let mut guard = db.lock().map_err(|_| Failure::storage())?;
        let transaction = guard
            .connection
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        let existing: Option<(String, i64)> = transaction
            .query_row(
                "SELECT id,blocked FROM accounts WHERE issuer=? AND clerk_sub=?",
                [issuer, subject],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        let account = match existing {
            Some((_, blocked)) if blocked != 0 => return Err(denied()),
            Some((id, _)) => id,
            None => {
                let id = uuid::Uuid::new_v4().to_string();
                transaction.execute(
                    "INSERT INTO accounts(id,issuer,clerk_sub,created) VALUES(?,?,?,?)",
                    rusqlite::params![id, issuer, subject, now],
                )?;
                id
            }
        };
        if transaction
            .query_row(
                "SELECT 1 FROM session_denials WHERE issuer=? AND sid=?",
                [issuer, sid],
                |_| Ok(()),
            )
            .optional()?
            .is_some()
        {
            return Err(denied());
        }
        transaction.commit()?;
        Ok(Actor {
            account,
            subject: subject.to_owned(),
            session: sid.to_owned(),
            expires: exp,
        })
    }
    pub fn require_current(
        &self,
        db: &Mutex<Database>,
        actor: &Actor,
        now: i64,
    ) -> Result<(), Failure> {
        let guard = db.lock().map_err(|_| Failure::storage())?;
        if actor.expires <= now || guard.connection.query_row("SELECT 1 FROM accounts WHERE id=? AND issuer=? AND clerk_sub=? AND blocked=0 AND NOT EXISTS(SELECT 1 FROM session_denials WHERE issuer=? AND sid=?)",rusqlite::params![actor.account,self.config.issuer,actor.subject,self.config.issuer,actor.session], |_|Ok(())).optional()?.is_none() { return Err(denied()); }
        Ok(())
    }
    pub async fn verified_mailboxes(
        &self,
        db: &Mutex<Database>,
        actor: &Actor,
        now: i64,
    ) -> Result<Vec<String>, Failure> {
        self.require_current(db, actor, now)?;
        let base = self
            .config
            .api_url
            .as_deref()
            .unwrap_or("https://api.clerk.com");
        let failed = || {
            let mut e = Failure::new(
                503,
                "identity_unavailable",
                "Mailbox verification is not available yet.",
            );
            e.retryable = true;
            e
        };
        if let Some(bridge) = self.bridge.as_ref().filter(|b| b.clerk) {
            let user = bridge
                .call("clerk-user", &json!({"subject":actor.subject}))
                .map_err(|_| failed())?;
            self.require_current(db, actor, now)?;
            return Self::mailboxes(&user, actor);
        }
        let mut url = url::Url::parse(&format!("{base}/v1/users/")).map_err(|_| failed())?;
        url.path_segments_mut()
            .map_err(|_| failed())?
            .push(&actor.subject);
        let response = self
            .client
            .get(url)
            .bearer_auth(&self.config.secret_key)
            .send()
            .await
            .map_err(|_| failed())?;
        if !response.status().is_success() {
            return Err(failed());
        }
        let mut response = response;
        let mut bytes = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(|_| failed())? {
            if bytes.len() + chunk.len() > 1024 * 1024 {
                return Err(failed());
            }
            bytes.extend_from_slice(&chunk);
        }
        let user: Value = serde_json::from_slice(&bytes).map_err(|_| failed())?;
        self.require_current(db, actor, now)?;
        Self::mailboxes(&user, actor)
    }
    fn mailboxes(user: &Value, actor: &Actor) -> Result<Vec<String>, Failure> {
        if user["id"] != actor.subject || user["banned"] == true || user["locked"] == true {
            return Err(denied());
        }
        let mut emails = Vec::new();
        for email in user["email_addresses"].as_array().into_iter().flatten() {
            if email["verification"]["status"] == "verified" {
                emails.push(crate::data::normalize_email(&email["email_address"])?);
            }
        }
        Ok(emails)
    }
    pub async fn logout(
        &self,
        db: &Mutex<Database>,
        actor: &Actor,
        now: i64,
    ) -> Result<Value, Failure> {
        {
            let mut guard = db.lock().map_err(|_| Failure::storage())?;
            let transaction = guard
                .connection
                .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
            let current = transaction.query_row("SELECT 1 FROM accounts WHERE id=? AND issuer=? AND clerk_sub=? AND blocked=0 AND NOT EXISTS(SELECT 1 FROM session_denials WHERE issuer=? AND sid=?)", rusqlite::params![actor.account,self.config.issuer,actor.subject,self.config.issuer,actor.session], |_| Ok(())).optional()?.is_some();
            if !current || actor.expires <= now {
                return Err(denied());
            }
            transaction.execute("INSERT INTO session_denials VALUES(?,?,?,?,'logout_pending',?) ON CONFLICT(issuer,sid) DO UPDATE SET expires_at=max(expires_at,excluded.expires_at),reason='logout_pending'", rusqlite::params![self.config.issuer, actor.session, actor.account, actor.expires, now])?;
            transaction.commit()?;
        }
        let revoked = self.revoke(&actor.session).await;
        if revoked {
            db.lock()
                .map_err(|_| Failure::storage())?
                .connection
                .execute(
                    "UPDATE session_denials SET reason='logout_complete' WHERE issuer=? AND sid=?",
                    [&self.config.issuer, &actor.session],
                )?;
        }
        Ok(json!({"state": if revoked { "revoked" } else { "upstream_pending" }}))
    }
    async fn revoke(&self, sid: &str) -> bool {
        if let Some(bridge) = self.bridge.as_ref().filter(|b| b.clerk) {
            return bridge.call("clerk-revoke", &json!({"session":sid})).is_ok();
        }
        let mut url = match url::Url::parse(
            self.config
                .api_url
                .as_deref()
                .unwrap_or("https://api.clerk.com"),
        ) {
            Ok(url) => url,
            Err(_) => return false,
        };
        if let Ok(mut path) = url.path_segments_mut() {
            path.extend(["v1", "sessions", sid, "revoke"]);
        } else {
            return false;
        }
        self.client
            .post(url)
            .bearer_auth(&self.config.secret_key)
            .send()
            .await
            .is_ok_and(|response| response.status().is_success())
    }
    pub async fn retry_logouts(&self, db: &Mutex<Database>) -> Result<(), Failure> {
        let rows = {
            let guard = db.lock().map_err(|_| Failure::storage())?;
            let mut statement = guard.connection.prepare("SELECT sid FROM session_denials WHERE issuer=? AND reason='logout_pending' ORDER BY created LIMIT 100")?;
            let rows = statement
                .query_map([&self.config.issuer], |row| row.get::<_, String>(0))?
                .collect::<Result<Vec<_>, _>>()?;
            rows
        };
        for sid in rows {
            if self.revoke(&sid).await {
                db.lock()
                    .map_err(|_| Failure::storage())?
                    .connection
                    .execute(
                    "UPDATE session_denials SET reason='logout_complete' WHERE issuer=? AND sid=?",
                    [&self.config.issuer, &sid],
                )?;
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clerk_mailboxes_require_verified_addresses_and_the_current_user() -> Result<(), Failure> {
        let actor = Actor {
            account: "account".into(),
            subject: "user_fixture".into(),
            session: "session".into(),
            expires: 1000,
        };
        let mut user = json!({
            "id": "user_fixture",
            "banned": false,
            "locked": false,
            "email_addresses": [
                {"email_address": "Member@Example.COM", "verification": {"status": "verified"}},
                {"email_address": "other@example.com", "verification": {"status": "unverified"}}
            ]
        });
        assert_eq!(Auth::mailboxes(&user, &actor)?, ["member@example.com"]);
        user["email_addresses"][0]["verification"]["status"] = json!("unverified");
        assert!(Auth::mailboxes(&user, &actor)?.is_empty());
        for (field, invalid, valid) in [
            ("id", json!("other_user"), json!("user_fixture")),
            ("locked", json!(true), json!(false)),
            ("banned", json!(true), json!(false)),
        ] {
            user[field] = invalid;
            assert_eq!(
                Auth::mailboxes(&user, &actor)
                    .err()
                    .map(|error| error.status),
                Some(401)
            );
            user[field] = valid;
        }
        Ok(())
    }
}
