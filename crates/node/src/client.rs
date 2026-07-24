//! A blocking, signed relay client for the endpoints the node uses as a pure
//! **relay client with no inbound ports**: it reads a granting owner's vault
//! through the shared-blob endpoints, drains its own mailbox, and holds open the
//! SSE poke stream. Every request carries the standard Ed25519 auth handshake
//! (`svastha_core::relay`); the transport mirrors the devtool's `RelayHttp`.
//!
//! All calls are outbound only. The node originates every connection — there is no
//! port to expose (the localhost bootstrap page in [`crate::bootstrap`] is the one
//! listener, and it is loopback-only and bootstrap-only).

use std::io::{BufRead, BufReader};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::{bail, Context, Result};
use serde::Deserialize;
use svastha_core::keys::Identity;
use svastha_core::relay::{sign_request, AuthRequest};
use ureq::http::StatusCode;
use ureq::Agent;

use crate::poke::{poke_from_line, Poke};

/// A mailbox item as the relay lists it: the client-chosen id and the relay's
/// attestation of who deposited it (`svastha-from`), which the node binds to the
/// identity the payload itself claims.
#[derive(Clone, Debug)]
pub struct MailboxEntry {
    pub id: String,
    pub from_hex: String,
}

/// The signed relay client. Holds the node identity behind an `Arc` so the sync
/// engine and the SSE thread can share one client.
pub struct RelayClient {
    base: String,
    identity: Arc<Identity>,
    agent: Agent,
}

impl RelayClient {
    /// Build a client against `base` (already trailing-slash-trimmed), signing as
    /// `identity`.
    pub fn new(base: String, identity: Arc<Identity>) -> Self {
        // `http_status_as_error(false)` so 404/410 come back as ordinary statuses
        // to branch on, not transport errors — the same posture as the devtool.
        let config = Agent::config_builder().http_status_as_error(false).build();
        Self {
            base,
            identity,
            agent: Agent::new_with_config(config),
        }
    }

    /// The node identity these requests authenticate as — also the identity the
    /// sync engine unwraps keyrings and opens blobs with.
    pub fn identity(&self) -> &Identity {
        &self.identity
    }

    fn signed_headers(&self, method: &str, path: &str, body: &[u8]) -> (String, String, String) {
        let timestamp = now_unix();
        let auth = AuthRequest::new(method, path, body, timestamp);
        let signature = sign_request(&self.identity, &auth);
        (
            hex::encode(self.identity.verifying_key().to_bytes()),
            timestamp.to_string(),
            hex::encode(signature),
        )
    }

    fn get(&self, path: &str) -> Result<ureq::http::Response<ureq::Body>> {
        let (public_key, timestamp, signature) = self.signed_headers("GET", path, b"");
        let url = format!("{}{path}", self.base);
        self.agent
            .get(&url)
            .header("Svastha-Public-Key", public_key)
            .header("Svastha-Timestamp", timestamp)
            .header("Svastha-Signature", signature)
            .call()
            .with_context(|| format!("GET {url}"))
    }

    /// Contract-version negotiation (unauthenticated). Returns the relay's
    /// version; the caller warns on a mismatch rather than failing (the wire
    /// contract is backward compatible within a major).
    pub fn get_info(&self) -> Result<u32> {
        #[derive(Deserialize)]
        struct Info {
            contract_version: u32,
        }
        let url = format!("{}/v0/info", self.base);
        let mut resp = self
            .agent
            .get(&url)
            .call()
            .with_context(|| format!("GET {url}"))?;
        if resp.status() != StatusCode::OK {
            bail!("GET /v0/info: unexpected status {}", resp.status());
        }
        let body = resp
            .body_mut()
            .read_to_vec()
            .context("read /v0/info body")?;
        let info: Info = serde_json::from_slice(&body).context("parse /v0/info body")?;
        Ok(info.contract_version)
    }

    /// The owners who have granted this node a live grant. Discovery source for
    /// enrolment: a `key_handoff` provides the keys, this confirms the grant edge.
    pub fn list_shared_owners(&self) -> Result<Vec<String>> {
        #[derive(Deserialize)]
        struct OwnerList {
            owners: Vec<String>,
        }
        let mut resp = self.get("/v0/shared")?;
        if resp.status() != StatusCode::OK {
            bail!("GET /v0/shared: unexpected status {}", resp.status());
        }
        let body = resp
            .body_mut()
            .read_to_vec()
            .context("read /v0/shared body")?;
        let list: OwnerList = serde_json::from_slice(&body).context("parse /v0/shared body")?;
        Ok(list.owners)
    }

    /// List `owner`'s blob ids the node's grant admits. `Ok(None)` means the relay
    /// answered `404` — no live grant (revoked or expired); the node then knows it
    /// can no longer pull that vault, even while it still holds the keyring.
    pub fn list_shared_blobs(&self, owner_hex: &str) -> Result<Option<Vec<String>>> {
        #[derive(Deserialize)]
        struct BlobList {
            ids: Vec<String>,
        }
        let path = format!("/v0/shared/{owner_hex}/blobs");
        let mut resp = self.get(&path)?;
        match resp.status() {
            StatusCode::OK => {
                let body = resp
                    .body_mut()
                    .read_to_vec()
                    .context("read shared blob list")?;
                let list: BlobList =
                    serde_json::from_slice(&body).context("parse shared blob list")?;
                Ok(Some(list.ids))
            }
            StatusCode::NOT_FOUND => Ok(None),
            status => bail!("GET {path}: unexpected status {status}"),
        }
    }

    /// Fetch one of `owner`'s blobs, gated on the grant. `Ok(None)` on `404`
    /// (missing, or outside the grant's prefix scope — indistinguishable by
    /// design).
    pub fn get_shared_blob(&self, owner_hex: &str, id: &str) -> Result<Option<Vec<u8>>> {
        let path = format!("/v0/shared/{owner_hex}/blobs/{id}");
        let mut resp = self.get(&path)?;
        match resp.status() {
            StatusCode::OK => Ok(Some(
                resp.body_mut()
                    .read_to_vec()
                    .context("read shared blob body")?,
            )),
            StatusCode::NOT_FOUND => Ok(None),
            status => bail!("GET {path}: unexpected status {status}"),
        }
    }

    /// List the node's own mailbox items (ids plus the relay-attested depositor).
    pub fn list_mailbox(&self) -> Result<Vec<MailboxEntry>> {
        #[derive(Deserialize)]
        struct Summary {
            id: String,
            from: String,
        }
        #[derive(Deserialize)]
        struct MailboxList {
            items: Vec<Summary>,
        }
        let mut resp = self.get("/v0/mailbox")?;
        if resp.status() != StatusCode::OK {
            bail!("GET /v0/mailbox: unexpected status {}", resp.status());
        }
        let body = resp.body_mut().read_to_vec().context("read mailbox list")?;
        let list: MailboxList = serde_json::from_slice(&body).context("parse mailbox list")?;
        Ok(list
            .items
            .into_iter()
            .map(|s| MailboxEntry {
                id: s.id,
                from_hex: s.from,
            })
            .collect())
    }

    /// Fetch one mailbox item, returning its bytes and the relay's `svastha-from`
    /// attestation. `Ok(None)` on `404` (deleted meanwhile).
    pub fn get_mailbox(&self, id: &str) -> Result<Option<(Vec<u8>, String)>> {
        let path = format!("/v0/mailbox/{id}");
        let mut resp = self.get(&path)?;
        match resp.status() {
            StatusCode::OK => {
                let from = resp
                    .headers()
                    .get("svastha-from")
                    .and_then(|v| v.to_str().ok())
                    .unwrap_or_default()
                    .to_string();
                let body = resp.body_mut().read_to_vec().context("read mailbox item")?;
                Ok(Some((body, from)))
            }
            StatusCode::NOT_FOUND => Ok(None),
            status => bail!("GET {path}: unexpected status {status}"),
        }
    }

    /// Deposit a sealed item into `recipient`'s mailbox. The node's steady-state
    /// vault sync is read-only, so this is not on the pull path — but the node is a
    /// *depositor* into an owner's mailbox: D2 deposits `proposal` envelopes this
    /// way (node → owner), and the integration tests use it to stand in for the
    /// PWA depositing a `key_handoff` (node ← owner). Kept here so both drive the
    /// real signed-request path.
    pub fn put_mailbox(&self, recipient_hex: &str, id: &str, body: &[u8]) -> Result<()> {
        let path = format!("/v0/mailbox/{recipient_hex}/{id}");
        self.put(&path, body)
    }

    /// Delete one of the caller's own mailbox items. `204` (deleted) and `404`
    /// (already gone) are both success — a chat question or admin command is
    /// terminal once answered, so deleting it is idempotent cleanup that races
    /// harmlessly against a concurrent delete. Used by the chat/admin drains (D3)
    /// after a reply is deposited; the journal stays the authoritative idempotence
    /// record (see [`crate::journal`]) — this only keeps the mailbox tidy.
    pub fn delete_mailbox(&self, id: &str) -> Result<()> {
        let path = format!("/v0/mailbox/{id}");
        let (public_key, timestamp, signature) = self.signed_headers("DELETE", &path, b"");
        let url = format!("{}{path}", self.base);
        let resp = self
            .agent
            .delete(&url)
            .header("Svastha-Public-Key", public_key)
            .header("Svastha-Timestamp", timestamp)
            .header("Svastha-Signature", signature)
            .call()
            .with_context(|| format!("DELETE {url}"))?;
        match resp.status() {
            StatusCode::NO_CONTENT | StatusCode::NOT_FOUND => Ok(()),
            status => bail!("DELETE {path}: unexpected status {status}"),
        }
    }

    /// Store (or replace) one of the caller's own blobs. Not used by the node's
    /// read-only sync; exposed so tests can seed a vault through real signed PUTs
    /// (the same reason the devtool's `RelayHttp` exposes it).
    pub fn put_blob(&self, id: &str, body: &[u8]) -> Result<()> {
        let path = format!("/v0/blobs/{id}");
        self.put(&path, body)
    }

    /// Grant `grantee` read access to the caller's vault, with an optional scope
    /// body (`{ "prefixes": [...], "expires_at": N }`). Test-facing, for the same
    /// reason as [`put_blob`](Self::put_blob).
    pub fn put_grant(&self, grantee_hex: &str, scope: Option<&[u8]>) -> Result<()> {
        let path = format!("/v0/grants/{grantee_hex}");
        self.put(&path, scope.unwrap_or(b""))
    }

    fn put(&self, path: &str, body: &[u8]) -> Result<()> {
        let (public_key, timestamp, signature) = self.signed_headers("PUT", path, body);
        let url = format!("{}{path}", self.base);
        let resp = self
            .agent
            .put(&url)
            .header("Svastha-Public-Key", public_key)
            .header("Svastha-Timestamp", timestamp)
            .header("Svastha-Signature", signature)
            .send(body)
            .with_context(|| format!("PUT {url}"))?;
        if resp.status() != StatusCode::NO_CONTENT {
            bail!("PUT {path}: unexpected status {}", resp.status());
        }
        Ok(())
    }

    /// Open the long-lived SSE poke stream and call `on_poke` for each poke until
    /// the stream ends or errors. Blocking — the caller runs it on a dedicated
    /// thread and reconnects with backoff (pokes are lossy, so a gap is harmless:
    /// the fallback poll reconciles). The auth headers ride the initial `GET`
    /// exactly like any other request; the relay does not replay-guard reads.
    pub fn stream_pokes(&self, mut on_poke: impl FnMut(Poke)) -> Result<()> {
        let resp = self.get("/v0/events")?;
        if resp.status() != StatusCode::OK {
            bail!("GET /v0/events: unexpected status {}", resp.status());
        }
        let reader = BufReader::new(resp.into_body().into_reader());
        for line in reader.lines() {
            let line = line.context("read SSE line")?;
            if let Some(poke) = poke_from_line(&line) {
                on_poke(poke);
            }
        }
        Ok(())
    }
}

fn now_unix() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}
