//! WASM bindings for the svastha trust contract. Thin `#[wasm_bindgen]` wrappers
//! over [`svastha_core`] so the browser runs the exact same contract code as the
//! relay and node — `core` stays pure (no JS attributes); the glue lives here.
//! Also wraps `svastha_import`'s C-CDA/FHIR mapping, so document import runs
//! entirely client-side too (see the "import" section below).
//!
//! Conventions at the JS boundary: binary values (sealed blobs, signatures) cross
//! as `Uint8Array`; structured contract types (events) cross as JSON strings,
//! reusing `core`'s serde derives. Errors surface as `JsError`.

use serde::Deserialize;
use wasm_bindgen::prelude::*;

use svastha_core::curation::{merge as merge_curation_records, SignedCurationRecord};
use svastha_core::envelope::{wrap_key, DataKey, Sealed, WrappedKey};
use svastha_core::event::{Code, Event, EventKind, EventValue, Provenance, SignedEvent};
use svastha_core::keys::Identity;
use svastha_core::mailbox::{MailboxMessage, MessageKind};
use svastha_core::relay::{sign_request as relay_sign_request, AuthRequest};
use x25519_dalek::PublicKey;

/// Install a panic hook so a Rust panic shows a real message in the browser
/// console instead of an opaque `unreachable`. Runs once on module load.
#[wasm_bindgen(start)]
pub fn start() {
    console_error_panic_hook::set_once();
}

/// The on-the-wire contract version both client and relay negotiate on.
#[wasm_bindgen]
pub fn contract_version() -> u32 {
    svastha_core::CONTRACT_VERSION
}

/// Map any `Display` error to a JS exception.
fn to_js<E: std::fmt::Display>(e: E) -> JsError {
    JsError::new(&e.to_string())
}

/// A derived identity (X25519 + Ed25519 keypairs) for use from the browser. The
/// secret key material stays inside the wasm linear memory; only public keys,
/// the mnemonic (for backup), and signatures cross the boundary.
#[wasm_bindgen]
pub struct WasmIdentity {
    identity: Identity,
    mnemonic: Option<String>,
}

#[wasm_bindgen]
impl WasmIdentity {
    /// Generate a fresh 24-word identity. The mnemonic is retained so the UI can
    /// show it for backup ([`mnemonic`](Self::mnemonic)).
    pub fn generate() -> Result<WasmIdentity, JsError> {
        let (mnemonic, identity) = Identity::generate().map_err(to_js)?;
        Ok(WasmIdentity {
            identity,
            mnemonic: Some(mnemonic.to_string()),
        })
    }

    /// Derive an identity from a BIP39 mnemonic and optional passphrase (`""` for
    /// none).
    pub fn from_mnemonic(phrase: &str, passphrase: &str) -> Result<WasmIdentity, JsError> {
        let identity = Identity::from_mnemonic(phrase, passphrase).map_err(to_js)?;
        Ok(WasmIdentity {
            identity,
            mnemonic: Some(phrase.to_string()),
        })
    }

    /// The backup mnemonic, if this identity's phrase is known.
    #[wasm_bindgen(getter)]
    pub fn mnemonic(&self) -> Option<String> {
        self.mnemonic.clone()
    }

    /// The X25519 public key (the address others wrap vault keys to), hex.
    #[wasm_bindgen(getter)]
    pub fn x25519_public_hex(&self) -> String {
        hex::encode(self.identity.x25519_public().as_bytes())
    }

    /// The Ed25519 public key (signing / relay-auth identity), hex.
    #[wasm_bindgen(getter)]
    pub fn ed25519_public_hex(&self) -> String {
        hex::encode(self.identity.verifying_key().to_bytes())
    }

    /// Sign a clinical event. `content_json` is the event content
    /// (`kind`, optional `code`/`effective_at`/`value`, and `provenance`); the
    /// content-addressed id is stamped from it. Returns the `SignedEvent` JSON.
    pub fn sign_event(&self, content_json: &str) -> Result<String, JsError> {
        let content: EventContent = serde_json::from_str(content_json).map_err(to_js)?;
        let event = Event::new(
            content.kind,
            content.code,
            content.effective_at,
            content.value,
            content.provenance,
        );
        let signed = self.identity.sign_event(event);
        serde_json::to_string(&signed).map_err(to_js)
    }

    /// Sign a relay request. The canonical signed bytes (method, path, body hash,
    /// timestamp) are defined once in `core`, so the browser and relay agree. The
    /// caller sends the returned 64-byte signature plus `ed25519_public_hex` and
    /// `timestamp` as the `Svastha-*` headers. `path` includes the query string.
    pub fn sign_request(&self, method: &str, path: &str, body: &[u8], timestamp: u64) -> Vec<u8> {
        let request = AuthRequest::new(method, path, body, timestamp);
        relay_sign_request(&self.identity, &request).to_vec()
    }

    /// Sign a curation record. `content_json` is `{ key, value, updated_at }`
    /// (`value` is opaque JSON; `updated_at` is Unix milliseconds); `author` is
    /// stamped from this identity, matching how [`sign_event`](Self::sign_event)
    /// stamps the content id. Returns the flat `SignedCurationRecord` JSON
    /// (`{ key, value, updated_at, author, signature }`).
    pub fn sign_curation(&self, content_json: &str) -> Result<String, JsError> {
        let content: CurationContent = serde_json::from_str(content_json).map_err(to_js)?;
        let signed = self
            .identity
            .sign_curation(content.key, content.value, content.updated_at);
        serde_json::to_string(&signed).map_err(to_js)
    }

    /// Unwrap a data key that was wrapped to this identity's X25519 public key
    /// (see [`WasmDataKey::wrap_to`]) — used to adopt the vault key found at
    /// the relay's `vault.key` blob.
    pub fn unwrap_key(&self, wrapped: &[u8]) -> Result<WasmDataKey, JsError> {
        let wrapped = WrappedKey::from_bytes(wrapped).map_err(to_js)?;
        let key = self.identity.unwrap_key(&wrapped).map_err(to_js)?;
        Ok(WasmDataKey { key })
    }

    /// Seal and sign a typed mailbox envelope: `body` is sealed to
    /// `recipient_x25519_public` and the envelope is signed by this identity.
    /// `kind` is the wire name (`proposal`, `proposal_result`, `admin_cmd`,
    /// `admin_reply`, `chat_msg`, `key_handoff`); `sent_at` is Unix milliseconds
    /// (taken as `f64` so a JS `Date.now()` passes directly — it is exact for any
    /// real timestamp). Returns the `MailboxMessage` JSON to deposit at the
    /// recipient's mailbox. See `spec/README.md`, "Mailbox message envelope".
    pub fn seal_message(
        &self,
        recipient_x25519_public: &[u8],
        kind: &str,
        sent_at: f64,
        body: &[u8],
    ) -> Result<String, JsError> {
        let bytes: [u8; 32] = recipient_x25519_public
            .try_into()
            .map_err(|_| JsError::new("recipient public key must be 32 bytes"))?;
        let recipient = PublicKey::from(bytes);
        let kind = parse_message_kind(kind)?;
        let msg = MailboxMessage::seal(&self.identity, &recipient, kind, sent_at as i64, body);
        serde_json::to_string(&msg).map_err(to_js)
    }

    /// Open a typed mailbox envelope sealed to this identity. **Verifies first**
    /// (the verify-or-drop posture) and errors if the signature or message id does
    /// not check out, so a caller that gets bytes back knows the envelope is
    /// authentic. Returns the decrypted body plaintext.
    pub fn open_message(&self, envelope_json: &str) -> Result<Vec<u8>, JsError> {
        let msg: MailboxMessage = serde_json::from_str(envelope_json).map_err(to_js)?;
        if !msg.verify() {
            return Err(JsError::new("mailbox envelope failed verification"));
        }
        msg.open(&self.identity).map_err(to_js)
    }
}

/// Parse a mailbox message-kind wire name into the contract enum.
fn parse_message_kind(kind: &str) -> Result<MessageKind, JsError> {
    serde_json::from_value(serde_json::Value::String(kind.to_string()))
        .map_err(|_| JsError::new("unknown mailbox message kind"))
}

/// The event-content fields a caller supplies; the id is derived, not provided.
#[derive(Deserialize)]
struct EventContent {
    kind: EventKind,
    #[serde(default)]
    code: Option<Code>,
    #[serde(default)]
    effective_at: Option<String>,
    #[serde(default)]
    value: Option<EventValue>,
    provenance: Provenance,
}

/// The curation fields a caller supplies; `author` and the signature are derived.
#[derive(Deserialize)]
struct CurationContent {
    key: String,
    value: serde_json::Value,
    updated_at: i64,
}

/// A symmetric vault data key for sealing and opening payloads in the browser.
#[wasm_bindgen]
pub struct WasmDataKey {
    key: DataKey,
}

#[wasm_bindgen]
impl WasmDataKey {
    /// Generate a fresh random data key.
    pub fn generate() -> WasmDataKey {
        WasmDataKey {
            key: DataKey::generate(),
        }
    }

    /// Reconstruct a data key from its 32 raw bytes.
    pub fn from_bytes(bytes: &[u8]) -> Result<WasmDataKey, JsError> {
        let bytes: [u8; 32] = bytes
            .try_into()
            .map_err(|_| JsError::new("data key must be 32 bytes"))?;
        Ok(WasmDataKey {
            key: DataKey::from_bytes(bytes),
        })
    }

    /// Seal a payload under this key. `aad` is authenticated but not encrypted.
    /// Returns the sealed wire bytes (`nonce ‖ ciphertext+tag`).
    pub fn seal(&self, plaintext: &[u8], aad: &[u8]) -> Vec<u8> {
        self.key.seal(plaintext, aad).to_bytes()
    }

    /// Open sealed wire bytes, supplying the same `aad`. Fails on any mismatch or
    /// tampering.
    pub fn open(&self, sealed: &[u8], aad: &[u8]) -> Result<Vec<u8>, JsError> {
        let sealed = Sealed::from_bytes(sealed).map_err(to_js)?;
        self.key.open(&sealed, aad).map_err(to_js)
    }

    /// The raw 32 key bytes, so the vault key itself can be sealed into local
    /// keyvault storage (wrapped under the passphrase-derived key).
    pub fn to_bytes(&self) -> Vec<u8> {
        self.key.to_bytes().to_vec()
    }

    /// Wrap this data key to a recipient's 32-byte X25519 public key (ECIES),
    /// e.g. self-wrapping the vault key for storage at the relay's
    /// `vault.key` blob — see `docs/ARCHITECTURE.md`, "Sync and backup".
    pub fn wrap_to(&self, recipient_x25519_public: &[u8]) -> Result<Vec<u8>, JsError> {
        let bytes: [u8; 32] = recipient_x25519_public
            .try_into()
            .map_err(|_| JsError::new("recipient public key must be 32 bytes"))?;
        let recipient = PublicKey::from(bytes);
        Ok(wrap_key(&recipient, &self.key).to_bytes())
    }
}

/// Verify a `SignedEvent` JSON: does the signature bind this exact event to its
/// author?
#[wasm_bindgen]
pub fn verify_event(signed_json: &str) -> Result<bool, JsError> {
    let signed: SignedEvent = serde_json::from_str(signed_json).map_err(to_js)?;
    Ok(signed.verify())
}

/// Verify a `SignedCurationRecord` JSON: does the signature bind this exact record
/// (`key`, `value`, `updated_at`) to its `author`? The verify-or-drop check a
/// doctor-share recipient runs before merging a bundle's curation records in.
#[wasm_bindgen]
pub fn verify_curation(signed_json: &str) -> Result<bool, JsError> {
    let signed: SignedCurationRecord = serde_json::from_str(signed_json).map_err(to_js)?;
    Ok(signed.verify())
}

/// Verify a `MailboxMessage` JSON envelope: does the stored id match the
/// recomputed one and the signature bind it to `from`? The verify-or-drop check a
/// recipient runs before opening (or even acting on) a mailbox item. Opening
/// (`open_message`) verifies again, so a caller may drop on `false` here without
/// decrypting.
#[wasm_bindgen]
pub fn verify_message(envelope_json: &str) -> Result<bool, JsError> {
    let msg: MailboxMessage = serde_json::from_str(envelope_json).map_err(to_js)?;
    Ok(msg.verify())
}

/// Last-writer-wins merge of two `SignedCurationRecord` JSON strings for the same
/// key: returns the winner's JSON (higher `updated_at`, tie → greater `author`).
/// A pure tiebreak — the caller verifies both first (see [`verify_curation`]).
#[wasm_bindgen]
pub fn merge_curation(a_json: &str, b_json: &str) -> Result<String, JsError> {
    let a: SignedCurationRecord = serde_json::from_str(a_json).map_err(to_js)?;
    let b: SignedCurationRecord = serde_json::from_str(b_json).map_err(to_js)?;
    serde_json::to_string(&merge_curation_records(a, b)).map_err(to_js)
}

// --- import (crates/import): client-side C-CDA/FHIR mapping ---
//
// These three functions are the whole import surface: map a source document
// to draft events (nothing signed, nothing hashed as a content id yet), and
// separately compute the content id a draft *would* get if kept — so the web
// client can check a plan's drafts against the local event log for dedup
// before the user commits to importing anything.

/// Map a C-CDA document (a CCD or a per-encounter Summary of Care) to draft
/// events. Returns the `ImportResult` (`events`, `warnings`, `skipped`) as
/// JSON — see `crates/import`'s doc comments for the section/value mapping.
#[wasm_bindgen]
pub fn import_ccda(xml: &str) -> Result<String, JsError> {
    let result = svastha_import::import_ccda(xml).map_err(to_js)?;
    serde_json::to_string(&result).map_err(to_js)
}

/// Map a FHIR R4 `Bundle` to draft events, same `ImportResult` JSON shape as
/// [`import_ccda`].
#[wasm_bindgen]
pub fn import_fhir(json: &str) -> Result<String, JsError> {
    let result = svastha_import::import_fhir_bundle(json).map_err(to_js)?;
    serde_json::to_string(&result).map_err(to_js)
}

/// The content-addressed id an `EventContent` would get, WITHOUT signing it —
/// reuses the same `EventContent` shape as [`WasmIdentity::sign_event`]
/// (`provenance` is required by that struct but doesn't affect the id; the
/// import plan can pass an empty one). Used for dry-run dedup: checking a
/// draft's would-be id against the local event log before the user decides to
/// import it.
#[wasm_bindgen]
pub fn event_id(content_json: &str) -> Result<String, JsError> {
    let content: EventContent = serde_json::from_str(content_json).map_err(to_js)?;
    let event = Event::new(
        content.kind,
        content.code,
        content.effective_at,
        content.value,
        content.provenance,
    );
    Ok(event.id.to_hex())
}
