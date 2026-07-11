//! Dev-only: pull this identity's relay blobs and decrypt them locally so a
//! developer can eyeball what actually landed on the relay. Never shipped to
//! users — see the crate's `publish = false` and the `just decrypt` recipe.
//!
//! This deliberately re-derives everything from first principles (the same
//! `svastha-core` trust contract the web client uses) rather than trusting
//! anything the relay says: every event signature is verified, every document
//! and curation record's content hash is checked against its blob id. A
//! mismatch is a hard error naming the blob id — ids are content hashes, not
//! PHI, so they're safe to print.

use std::fs;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::{anyhow, bail, Context, Result};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use ureq::http::StatusCode;
use ureq::Agent;

use svastha_core::envelope::{Sealed, WrappedKey};
use svastha_core::event::SignedEvent;
use svastha_core::keys::Identity;
use svastha_core::relay::{sign_request, AuthRequest};

/// Where to pull from and how to unlock it.
pub struct Config {
    pub relay_url: String,
    pub mnemonic: String,
    pub out_dir: PathBuf,
}

/// What `run` found, for the one line the binary prints. Never carries record
/// contents — only counts and blob ids (safe to print; see the module doc).
#[derive(Debug)]
pub struct Summary {
    pub events: usize,
    pub docs: usize,
    pub curation: usize,
    pub skipped: Vec<String>,
    pub out_dir: PathBuf,
}

impl std::fmt::Display for Summary {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "{} events (all signatures verified), {} documents, {} curation records, {} skipped — written to {}",
            self.events,
            self.docs,
            self.curation,
            self.skipped.len(),
            self.out_dir.display(),
        )
    }
}

/// Pull `config.relay_url`'s blobs for the identity derived from
/// `config.mnemonic`, decrypt everything, and write a clean snapshot under
/// `config.out_dir`.
pub fn run(config: &Config) -> Result<Summary> {
    // Empty BIP39 passphrase is deliberate: the app's unlock passphrase wraps
    // local storage only and is never part of seed derivation (see
    // `Identity::from_mnemonic`), so it has no bearing on which identity —
    // and which relay blobs — this pulls.
    let identity = Identity::from_mnemonic(&config.mnemonic, "")
        .map_err(|e| anyhow!("SVASTHA_MNEMONIC is not a valid BIP39 mnemonic: {e}"))?;

    let base = config.relay_url.trim_end_matches('/').to_string();
    let relay = RelayHttp::new(base, &identity);
    relay.get_info()?;

    let ids = relay.list_blobs()?;

    let vault_key_blob = relay.get_blob("vault.key")?.ok_or_else(|| {
        anyhow!("no vault.key blob on the relay for this identity — nothing else can be opened")
    })?;
    let wrapped = WrappedKey::from_bytes(&vault_key_blob).context("parse vault.key")?;
    let data_key = identity
        .unwrap_key(&wrapped)
        .context("unwrap vault.key — wrong mnemonic, or relay is for a different identity")?;

    reset_out_dir(&config.out_dir)?;
    let docs_dir = config.out_dir.join("docs");
    fs::create_dir_all(&docs_dir).with_context(|| format!("create {}", docs_dir.display()))?;

    let mut events: Vec<SignedEvent> = Vec::new();
    let mut doc_count = 0usize;
    let mut curation: Vec<serde_json::Value> = Vec::new();
    let mut skipped: Vec<String> = Vec::new();

    for id in &ids {
        if id == "vault.key" {
            continue;
        }

        let Some(blob) = relay.get_blob(id)? else {
            // Listed, then gone by the time we fetched it (concurrent delete).
            // Not a decode failure — just nothing to decrypt.
            continue;
        };

        if let Some(hex_id) = id.strip_prefix("ev-") {
            // AAD is the UTF-8 blob id: binds each sealed payload to the id it
            // was stored under, so a blob copied onto a different id (a
            // relay-swap) fails to open instead of decrypting under the wrong
            // identity, mirroring the web client's convention.
            let plaintext = open_sealed(&data_key, &blob, id)?;
            let signed: SignedEvent = serde_json::from_slice(&plaintext)
                .with_context(|| format!("parse event JSON for blob {id}"))?;
            if !signed.verify() {
                bail!("event signature verification failed for blob {id}");
            }
            if signed.event.id.to_hex() != hex_id {
                bail!(
                    "event content id does not match blob id {id} (got {})",
                    signed.event.id.to_hex()
                );
            }
            events.push(signed);
        } else if let Some(hex_id) = id.strip_prefix("doc-") {
            let plaintext = open_sealed(&data_key, &blob, id)?;
            let doc: DocEnvelope = serde_json::from_slice(&plaintext)
                .with_context(|| format!("parse document envelope for blob {id}"))?;
            let raw = BASE64
                .decode(&doc.bytes)
                .with_context(|| format!("base64-decode document bytes for blob {id}"))?;
            let digest = hex::encode(Sha256::digest(&raw));
            if digest != hex_id {
                bail!("document content hash does not match blob id {id}");
            }
            // XDM zip entries carry paths (e.g. `IHE_XDM/SUBSET01/DOC0001.XML`);
            // sanitize before touching the filesystem.
            let filename = format!("{}-{}", &digest[..12], sanitize_filename(&doc.name));
            fs::write(docs_dir.join(&filename), &raw)
                .with_context(|| format!("write document for blob {id}"))?;
            doc_count += 1;
        } else if let Some(hex_id) = id.strip_prefix("cur-") {
            let plaintext = open_sealed(&data_key, &blob, id)?;
            let record: serde_json::Value = serde_json::from_slice(&plaintext)
                .with_context(|| format!("parse curation record for blob {id}"))?;
            let key = record.get("key").and_then(|v| v.as_str()).ok_or_else(|| {
                anyhow!("curation record for blob {id} is missing string field 'key'")
            })?;
            let digest = hex::encode(Sha256::digest(key.as_bytes()));
            if digest != hex_id {
                bail!("curation record key hash does not match blob id {id}");
            }
            curation.push(record);
        } else {
            skipped.push(id.clone());
        }
    }

    events.sort_by_key(|e| e.event.id.to_hex());
    write_ndjson(&config.out_dir.join("events.ndjson"), &events)?;

    curation.sort_by_cached_key(|record| curation_key(record).to_string());
    write_ndjson(&config.out_dir.join("curation.ndjson"), &curation)?;

    Ok(Summary {
        events: events.len(),
        docs: doc_count,
        curation: curation.len(),
        skipped,
        out_dir: config.out_dir.clone(),
    })
}

fn curation_key(record: &serde_json::Value) -> &str {
    record.get("key").and_then(|v| v.as_str()).unwrap_or("")
}

fn open_sealed(
    data_key: &svastha_core::envelope::DataKey,
    blob: &[u8],
    id: &str,
) -> Result<Vec<u8>> {
    let sealed =
        Sealed::from_bytes(blob).with_context(|| format!("parse sealed bytes for blob {id}"))?;
    data_key
        .open(&sealed, id.as_bytes())
        .map_err(|_| anyhow!("failed to open sealed blob {id} — tampered ciphertext or wrong key"))
}

fn write_ndjson<T: serde::Serialize>(path: &std::path::Path, records: &[T]) -> Result<()> {
    let mut out = String::new();
    for record in records {
        out.push_str(&serde_json::to_string(record)?);
        out.push('\n');
    }
    fs::write(path, out).with_context(|| format!("write {}", path.display()))
}

/// Wipe and recreate the out dir so every run leaves a clean, diffable
/// snapshot — no stale files from a previous run (or a previous identity)
/// lingering alongside the current one.
fn reset_out_dir(dir: &std::path::Path) -> Result<()> {
    if dir.exists() {
        fs::remove_dir_all(dir).with_context(|| format!("remove existing {}", dir.display()))?;
    }
    fs::create_dir_all(dir).with_context(|| format!("create {}", dir.display()))
}

/// A document blob's plaintext envelope: the verbatim source bytes plus the
/// name it carried on import (often a path, from an XDM zip entry).
#[derive(Deserialize)]
struct DocEnvelope {
    name: String,
    bytes: String,
}

/// Collapse a document name into a single safe filename component: fold path
/// separators into a visible `__` (rather than dropping them, so
/// `IHE_XDM/SUBSET01/DOC0001.XML` stays legible), then drop everything outside
/// `[A-Za-z0-9._-]` and strip leading dots. The result can never contain a
/// `/` or start with `.`, so it cannot escape the docs directory or resolve
/// to a hidden/relative entry, however adversarial the original name.
fn sanitize_filename(name: &str) -> String {
    let folded = name.replace('/', "__");
    let mut safe: String = folded
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
        .collect();
    while safe.starts_with('.') {
        safe.remove(0);
    }
    if safe.is_empty() {
        safe = "unnamed".to_string();
    }
    safe
}

/// A minimal signed-request client over the relay's blob API. Also exposes
/// `put_blob`, which `run` never calls — it exists so the integration test can
/// seed fixtures through the same real signed requests a client would send.
pub struct RelayHttp<'a> {
    base: String,
    identity: &'a Identity,
    agent: Agent,
}

impl<'a> RelayHttp<'a> {
    pub fn new(base: String, identity: &'a Identity) -> Self {
        let config = Agent::config_builder().http_status_as_error(false).build();
        Self {
            base,
            identity,
            agent: Agent::new_with_config(config),
        }
    }

    /// The three signed-auth header values for one request. Split out from the
    /// request methods (which supply `timestamp` from the clock) so the pinned
    /// spec vectors can drive it directly with a fixed timestamp.
    fn auth_header_values(
        &self,
        method: &str,
        path: &str,
        body: &[u8],
        timestamp: u64,
    ) -> (String, String, String) {
        let auth = AuthRequest::new(method, path, body, timestamp);
        let signature = sign_request(self.identity, &auth);
        (
            hex::encode(self.identity.verifying_key().to_bytes()),
            timestamp.to_string(),
            hex::encode(signature),
        )
    }

    fn signed_headers(&self, method: &str, path: &str, body: &[u8]) -> (String, String, String) {
        self.auth_header_values(method, path, body, now_unix())
    }

    /// Contract-version negotiation (unauthenticated). Warns rather than fails
    /// on a mismatch: the tool can still make sense of most blobs even if the
    /// relay is a version ahead or behind.
    pub fn get_info(&self) -> Result<()> {
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
        if info.contract_version != svastha_core::CONTRACT_VERSION {
            eprintln!(
                "warning: relay contract_version {} does not match this tool's {} — decoding may fail",
                info.contract_version,
                svastha_core::CONTRACT_VERSION,
            );
        }
        Ok(())
    }

    pub fn list_blobs(&self) -> Result<Vec<String>> {
        #[derive(Deserialize)]
        struct BlobList {
            ids: Vec<String>,
        }

        let path = "/v0/blobs";
        let (public_key, timestamp, signature) = self.signed_headers("GET", path, b"");
        let url = format!("{}{path}", self.base);
        let mut resp = self
            .agent
            .get(&url)
            .header("Svastha-Public-Key", public_key)
            .header("Svastha-Timestamp", timestamp)
            .header("Svastha-Signature", signature)
            .call()
            .with_context(|| format!("GET {url}"))?;
        if resp.status() != StatusCode::OK {
            bail!("GET {path}: unexpected status {}", resp.status());
        }
        let body = resp
            .body_mut()
            .read_to_vec()
            .context("read /v0/blobs body")?;
        let list: BlobList = serde_json::from_slice(&body).context("parse /v0/blobs body")?;
        Ok(list.ids)
    }

    pub fn get_blob(&self, id: &str) -> Result<Option<Vec<u8>>> {
        let path = format!("/v0/blobs/{id}");
        let (public_key, timestamp, signature) = self.signed_headers("GET", &path, b"");
        let url = format!("{}{path}", self.base);
        let mut resp = self
            .agent
            .get(&url)
            .header("Svastha-Public-Key", public_key)
            .header("Svastha-Timestamp", timestamp)
            .header("Svastha-Signature", signature)
            .call()
            .with_context(|| format!("GET {url}"))?;
        match resp.status() {
            StatusCode::OK => Ok(Some(
                resp.body_mut().read_to_vec().context("read blob body")?,
            )),
            StatusCode::NOT_FOUND => Ok(None),
            status => bail!("GET {path}: unexpected status {status}"),
        }
    }

    /// PUT a blob for the identity this client signs as. Dev-tool-only (`run`
    /// never writes to the relay); kept public so the integration test can
    /// seed fixtures through the real signed-request path rather than poking
    /// the relay's stores directly.
    pub fn put_blob(&self, id: &str, bytes: &[u8]) -> Result<()> {
        let path = format!("/v0/blobs/{id}");
        let (public_key, timestamp, signature) = self.signed_headers("PUT", &path, bytes);
        let url = format!("{}{path}", self.base);
        let resp = self
            .agent
            .put(&url)
            .header("Svastha-Public-Key", public_key)
            .header("Svastha-Timestamp", timestamp)
            .header("Svastha-Signature", signature)
            .send(bytes)
            .with_context(|| format!("PUT {url}"))?;
        if resp.status() != StatusCode::NO_CONTENT {
            bail!("PUT {path}: unexpected status {}", resp.status());
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

#[cfg(test)]
mod tests {
    use super::*;

    // --- pinned spec vectors: header values must match the relay's own ---

    #[derive(Deserialize)]
    struct VectorFile {
        requests: Vec<RequestVector>,
    }

    #[derive(Deserialize)]
    struct RequestVector {
        method: String,
        path: String,
        body_hex: String,
        timestamp: u64,
        signer_seed_hex: String,
        public_key_hex: String,
        signature_hex: String,
    }

    const VECTORS: &str = include_str!("../../../spec/vectors/relay-auth.json");

    #[test]
    fn header_values_match_spec_vectors() {
        let file: VectorFile = serde_json::from_str(VECTORS).expect("parse vectors");
        for v in &file.requests {
            let body = hex::decode(&v.body_hex).unwrap();
            let signer = Identity::from_seed(&hex::decode(&v.signer_seed_hex).unwrap());
            let relay = RelayHttp::new("http://unused.invalid".to_string(), &signer);

            let (public_key, timestamp, signature) =
                relay.auth_header_values(&v.method, &v.path, &body, v.timestamp);

            assert_eq!(public_key, v.public_key_hex, "public key header");
            assert_eq!(timestamp, v.timestamp.to_string(), "timestamp header");
            assert_eq!(signature, v.signature_hex, "signature header");
        }
    }

    // --- filename sanitization ---

    #[test]
    fn sanitize_flattens_xdm_path() {
        assert_eq!(
            sanitize_filename("IHE_XDM/SUBSET01/DOC0001.XML"),
            "IHE_XDM__SUBSET01__DOC0001.XML"
        );
    }

    #[test]
    fn sanitize_defuses_traversal() {
        let result = sanitize_filename("../../etc/passwd");
        assert!(!result.starts_with('.'));
        assert!(!result.contains('/'));
        assert_eq!(result, "__..__etc__passwd");
    }

    #[test]
    fn sanitize_strips_leading_dot() {
        assert_eq!(sanitize_filename(".hidden"), "hidden");
    }

    #[test]
    fn sanitize_drops_non_ascii() {
        assert_eq!(sanitize_filename("caf\u{e9}.pdf"), "caf.pdf");
    }
}
