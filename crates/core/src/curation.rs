//! The curation overlay: the one mutable layer over the otherwise append-only,
//! immutable event log (tags, hides, notes, favorite quick-log templates, and —
//! coming in the web adoption — concept-level `status:`/`name:` records). A
//! curation record is a small, namespace-defined value keyed by an app-level
//! string, merged last-writer-wins so every device converges without a shared
//! clock (see ARCHITECTURE, "Curation overlay").
//!
//! Historically this overlay lived entirely in the web client and was
//! deliberately *unsigned*: in a single-writer vault, holding the vault key was
//! itself the authorship proof. Two changes retire that assumption — curation now
//! crosses the vault boundary inside doctor-share bundles (where a recipient has
//! the per-share key but is not the author and must be able to reject a record the
//! bundle-builder tampered with), and multi-writer vaults are on the roadmap
//! (where `author` alone can no longer distinguish two holders of the same vault
//! key). So a curation record is now an Ed25519-signed record, signed by the same
//! owner identity that signs events, and this module is its single source of truth
//! for canonical serialization, signing, verification, and the LWW merge rule (so
//! the web client and any future client share one implementation).
//!
//! `core` is namespace-agnostic: `key`/`value` are opaque here. The signing
//! preimage reuses the event/relay canonicalization (a version-tagged domain label
//! and length-prefixed fields); `spec/README.md` is authoritative and
//! `spec/vectors/curation.json` pins the bytes.

use ed25519_dalek::{Signature, VerifyingKey};
use serde::{Deserialize, Serialize};

/// The curation record body: the fields an author signs, plus the `author` public
/// key. `value` is namespace-defined and opaque to both the signature preimage
/// (it is canonicalized as JSON, below) and the merge rule.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct CurationRecord {
    /// The app-level curation key (e.g. `tag:{event_id}`). Namespaces the record;
    /// opaque to `core`.
    pub key: String,
    /// The namespace-defined payload. Opaque JSON; canonicalized (compact, object
    /// keys sorted) for signing so the same logical value always signs identically.
    pub value: serde_json::Value,
    /// A plain client clock in Unix **milliseconds** (matches the web client's
    /// `Date.now()`), not a signed or server-attested timestamp — it is the LWW
    /// ordering key, nothing more.
    pub updated_at: i64,
    /// The writer's Ed25519 public key. Both the signature-verification key (a
    /// wrong `author` fails [`SignedCurationRecord::verify`]) and the LWW
    /// tiebreaker (see [`merge`]).
    #[serde(with = "hex_bytes")]
    pub author: [u8; 32],
}

impl CurationRecord {
    /// The bytes an author signs: a version-tagged domain label (separating
    /// curation signatures from event and relay-auth ones), then the canonical
    /// `key`, `value`, and `updated_at`. `author` is **not** in the preimage — it
    /// is the verification key, exactly as [`crate::event::SignedEvent`] treats its
    /// own `author`, so changing it still fails verification (the signature was
    /// made by a different key).
    pub fn signing_bytes(&self) -> Vec<u8> {
        let mut out = Vec::new();
        out.extend_from_slice(crate::version_label("curation").as_bytes());
        put_str(&mut out, &self.key);
        put_bytes(&mut out, &canonical_value(&self.value));
        out.extend_from_slice(&self.updated_at.to_be_bytes());
        out
    }
}

/// A [`CurationRecord`] with its author's Ed25519 signature. Serializes flat —
/// `{ key, value, updated_at, author, signature }` — so it drops straight into the
/// web client's existing record shape (which gains only `signature`) and into a
/// doctor-share bundle's `curation` array, where a recipient verifies-or-drops.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct SignedCurationRecord {
    #[serde(flatten)]
    pub record: CurationRecord,
    #[serde(with = "hex_bytes")]
    signature: [u8; 64],
}

impl SignedCurationRecord {
    /// Assemble from parts (used by [`crate::keys::Identity::sign_curation`]).
    pub fn new(record: CurationRecord, signature: [u8; 64]) -> Self {
        Self { record, signature }
    }

    /// The Ed25519 signature over [`CurationRecord::signing_bytes`].
    pub fn signature(&self) -> &[u8; 64] {
        &self.signature
    }

    /// Verify the signature binds this exact record to its `author`. Any tampering
    /// with `key`, `value`, or `updated_at`, or a wrong `author`, fails. Verify is
    /// independent of the merge below: a recipient of a doctor-share bundle
    /// verifies-or-drops *before* merging anything in.
    pub fn verify(&self) -> bool {
        let Ok(author) = VerifyingKey::from_bytes(&self.record.author) else {
            return false;
        };
        let signature = Signature::from_bytes(&self.signature);
        crate::keys::verify(&author, &self.record.signing_bytes(), &signature)
    }
}

/// Last-writer-wins merge of two records for the same key: the higher `updated_at`
/// wins; a tie breaks toward the lexicographically greater `author`. Deterministic
/// and commutative, so every device that sees the same pair converges without a
/// shared clock. This is a pure tiebreak and does **not** verify signatures —
/// callers verify-or-drop first (an unverified record must never reach here).
///
/// Comparing the raw 32-byte `author` arrays is identical to comparing their
/// lowercase-hex strings (fixed-width hex is order-preserving), so this matches
/// the web client's hex-string comparison exactly.
pub fn merge(a: SignedCurationRecord, b: SignedCurationRecord) -> SignedCurationRecord {
    if a.record.updated_at != b.record.updated_at {
        if a.record.updated_at > b.record.updated_at {
            a
        } else {
            b
        }
    } else if a.record.author > b.record.author {
        a
    } else {
        b
    }
}

/// Canonical JSON of a `value`: compact (no incidental whitespace) with object
/// keys sorted — serde_json's `Value` is `BTreeMap`-backed, so re-serializing a
/// parsed value is deterministic regardless of the input key order. This is the
/// language-neutral rule a reimplementation reproduces: canonical JSON, then
/// length-prefixed like any other field.
fn canonical_value(value: &serde_json::Value) -> Vec<u8> {
    serde_json::to_vec(value).expect("serializing a serde_json::Value never fails")
}

// --- canonical encoding primitives ---
//
// The same length-prefix scheme as the event and relay-auth encodings: a field is
// u32 big-endian length ‖ bytes. Duplicated here (as relay.rs duplicates its
// `put_str`) so each contract module owns its encoding locally.

fn put_bytes(out: &mut Vec<u8>, bytes: &[u8]) {
    out.extend_from_slice(&(bytes.len() as u32).to_be_bytes());
    out.extend_from_slice(bytes);
}

fn put_str(out: &mut Vec<u8>, s: &str) {
    put_bytes(out, s.as_bytes());
}

/// serde adapter: fixed-size byte arrays as lowercase hex (matches the id and the
/// `SignedEvent` author/signature wire form). Duplicated from `event.rs` to keep
/// this module's wire encoding self-contained.
mod hex_bytes {
    use serde::{Deserialize, Deserializer, Serializer};

    pub fn serialize<S: Serializer, const N: usize>(
        bytes: &[u8; N],
        serializer: S,
    ) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&hex::encode(bytes))
    }

    pub fn deserialize<'de, D: Deserializer<'de>, const N: usize>(
        deserializer: D,
    ) -> Result<[u8; N], D::Error> {
        let s = String::deserialize(deserializer)?;
        hex::decode(&s)
            .map_err(serde::de::Error::custom)?
            .try_into()
            .map_err(|_| serde::de::Error::custom("wrong byte length"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::keys::Identity;
    use serde_json::json;

    fn rec(
        id: &Identity,
        key: &str,
        value: serde_json::Value,
        updated_at: i64,
    ) -> SignedCurationRecord {
        id.sign_curation(key.to_string(), value, updated_at)
    }

    #[test]
    fn sign_verify_round_trip() {
        let id = Identity::from_seed(b"author seed");
        let signed = rec(
            &id,
            "tag:abc",
            json!({ "tags": ["fever", "travel"] }),
            1_700_000_000_000,
        );
        assert!(signed.verify());
        assert_eq!(signed.record.author, id.verifying_key().to_bytes());
    }

    #[test]
    fn verify_rejects_tampered_value() {
        let id = Identity::from_seed(b"author seed");
        let mut signed = rec(
            &id,
            "hide:abc",
            json!({ "hidden": true }),
            1_700_000_000_000,
        );
        signed.record.value = json!({ "hidden": false });
        assert!(!signed.verify());
    }

    #[test]
    fn verify_rejects_tampered_key() {
        let id = Identity::from_seed(b"author seed");
        let mut signed = rec(&id, "tag:abc", json!({ "tags": ["a"] }), 1_700_000_000_000);
        signed.record.key = "tag:xyz".into();
        assert!(!signed.verify());
    }

    #[test]
    fn verify_rejects_tampered_timestamp() {
        let id = Identity::from_seed(b"author seed");
        let mut signed = rec(&id, "tag:abc", json!({ "tags": ["a"] }), 1_700_000_000_000);
        signed.record.updated_at = 1_700_000_000_001;
        assert!(!signed.verify());
    }

    #[test]
    fn verify_rejects_wrong_author() {
        let author = Identity::from_seed(b"author seed");
        let attacker = Identity::from_seed(b"attacker seed");
        let signed = rec(
            &author,
            "tag:abc",
            json!({ "tags": ["a"] }),
            1_700_000_000_000,
        );
        // Swap in the attacker's public key but keep the original signature.
        let forged = SignedCurationRecord::new(
            CurationRecord {
                author: attacker.verifying_key().to_bytes(),
                ..signed.record.clone()
            },
            *signed.signature(),
        );
        assert!(!forged.verify());
    }

    #[test]
    fn value_key_order_is_canonical() {
        // Two inputs differing only in JSON object key order produce the same
        // signature — the preimage canonicalizes the value.
        let id = Identity::from_seed(b"author seed");
        let a = rec(&id, "k", json!({ "a": 1, "b": 2 }), 10);
        let b = rec(&id, "k", json!({ "b": 2, "a": 1 }), 10);
        assert_eq!(a.signature(), b.signature());
    }

    #[test]
    fn merge_higher_timestamp_wins() {
        let id = Identity::from_seed(b"author seed");
        let older = rec(&id, "k", json!({ "n": 1 }), 100);
        let newer = rec(&id, "k", json!({ "n": 2 }), 200);
        // Commutative: order of arguments does not change the winner.
        assert_eq!(merge(older.clone(), newer.clone()), newer);
        assert_eq!(merge(newer.clone(), older.clone()), newer);
    }

    #[test]
    fn merge_tie_breaks_on_greater_author() {
        // Same updated_at, different authors: the lexicographically greater author
        // wins, matching the web client's hex-string comparison.
        let a = Identity::from_seed(b"author seed a");
        let b = Identity::from_seed(b"author seed b");
        let ra = rec(&a, "k", json!({ "n": 1 }), 100);
        let rb = rec(&b, "k", json!({ "n": 2 }), 100);
        let expected = if ra.record.author > rb.record.author {
            &ra
        } else {
            &rb
        };
        assert_eq!(&merge(ra.clone(), rb.clone()), expected);
        assert_eq!(&merge(rb.clone(), ra.clone()), expected);
    }

    #[test]
    fn serde_round_trip_is_flat() {
        let id = Identity::from_seed(b"author seed");
        let signed = rec(
            &id,
            "note:abc",
            json!({ "text": "follow up in 2 weeks" }),
            42,
        );
        let json = serde_json::to_value(&signed).unwrap();
        // Flat wire shape: no nested `record` object.
        for field in ["key", "value", "updated_at", "author", "signature"] {
            assert!(json.get(field).is_some(), "missing {field}");
        }
        assert!(json.get("record").is_none());
        let parsed: SignedCurationRecord = serde_json::from_value(json).unwrap();
        assert_eq!(parsed, signed);
        assert!(parsed.verify());
    }

    // --- pinned spec vectors ---

    #[derive(Deserialize)]
    struct VectorFile {
        contract_version: u32,
        records: Vec<RecordVector>,
    }

    #[derive(Deserialize)]
    struct RecordVector {
        note: String,
        valid: bool,
        signer_seed_hex: Option<String>,
        canon_hex: Option<String>,
        record: SignedCurationRecord,
    }

    const VECTORS: &str = include_str!("../../../spec/vectors/curation.json");

    #[test]
    fn matches_spec_vectors() {
        let file: VectorFile = serde_json::from_str(VECTORS).expect("parse vectors");
        assert_eq!(
            file.contract_version,
            crate::CONTRACT_VERSION,
            "vectors are pinned to a different contract version"
        );

        for v in &file.records {
            // Every vector pins the expected verify() outcome (valid, or one of the
            // three tamper cases).
            assert_eq!(v.record.verify(), v.valid, "{}", v.note);

            // The valid vector additionally pins the canonical preimage and lets a
            // reimplementation reproduce the deterministic signature from the seed.
            if let Some(seed) = &v.signer_seed_hex {
                assert_eq!(
                    hex::encode(v.record.record.signing_bytes()),
                    *v.canon_hex.as_ref().unwrap(),
                    "canon: {}",
                    v.note
                );
                let signer = Identity::from_seed(&hex::decode(seed).unwrap());
                let resigned = signer.sign_curation(
                    v.record.record.key.clone(),
                    v.record.record.value.clone(),
                    v.record.record.updated_at,
                );
                assert_eq!(
                    resigned.record.author, v.record.record.author,
                    "author: {}",
                    v.note
                );
                assert_eq!(
                    resigned.signature(),
                    v.record.signature(),
                    "signature: {}",
                    v.note
                );
            }
        }
    }
}
