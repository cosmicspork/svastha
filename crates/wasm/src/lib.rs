//! WASM bindings for the svastha trust contract. Thin `#[wasm_bindgen]` wrappers
//! over [`svastha_core`] so the browser runs the exact same contract code as the
//! relay and node — `core` stays pure (no JS attributes); the glue lives here.
//!
//! Conventions at the JS boundary: binary values (sealed blobs, signatures) cross
//! as `Uint8Array`; structured contract types (events) cross as JSON strings,
//! reusing `core`'s serde derives. Errors surface as `JsError`.

use serde::Deserialize;
use wasm_bindgen::prelude::*;

use svastha_core::envelope::{DataKey, Sealed};
use svastha_core::event::{Code, Event, EventKind, EventValue, Provenance, SignedEvent};
use svastha_core::keys::Identity;

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
}

/// Verify a `SignedEvent` JSON: does the signature bind this exact event to its
/// author?
#[wasm_bindgen]
pub fn verify_event(signed_json: &str) -> Result<bool, JsError> {
    let signed: SignedEvent = serde_json::from_str(signed_json).map_err(to_js)?;
    Ok(signed.verify())
}
