//! The event schema: the typed, immutable, append-only facts that make up a
//! record. Most clinical history is immutable history, so events are appended and
//! merged by union (plus de-duplication); a thin mutable curation layer lives
//! separately. This keeps conflict resolution light.
//!
//! Two contract-critical operations live here, both over an explicit canonical
//! byte encoding (`spec/README.md` is authoritative, `spec/vectors/event.json`
//! pins the bytes):
//!
//! - **Content addressing.** [`Event::content_id`] is SHA-256 over the event's
//!   clinical content, *excluding* `id` and `provenance`. The same immunization
//!   reported by two providers (differing only in provenance) gets the same id,
//!   so a union merge de-duplicates it. The id is deliberately version-*independent*
//!   so a fact keeps its identity across a contract bump.
//! - **Signing.** [`crate::keys::Identity::sign_event`] produces a [`SignedEvent`]:
//!   the author attests to `id ‖ provenance` (the id binds all content) under a
//!   version-tagged, domain-separated Ed25519 signature.
//!
//! FHIR and C-CDA are interface formats only (see ARCHITECTURE). Internally we
//! keep a lean, FHIR-informed shape and reuse the standard code systems.

use std::fmt;

use ed25519_dalek::{Signature, VerifyingKey};
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use sha2::{Digest, Sha256};

/// Domain tag for the content-id hash. Version-*independent* on purpose (unlike
/// the key/envelope HKDF labels) so fact identity is stable across contract bumps.
const DOMAIN_EVENT_ID: &[u8] = b"svastha/event-id\0";

/// Failures parsing event types from untrusted input.
#[derive(Debug, thiserror::Error)]
pub enum EventError {
    /// An event id was not 32 bytes of lowercase hex.
    #[error("malformed event id")]
    BadId,
}

/// A coded value drawn from a standard terminology (LOINC, RxNorm, SNOMED, CVX).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Code {
    /// Terminology URI, e.g. "http://loinc.org".
    pub system: String,
    pub code: String,
    pub display: Option<String>,
}

/// Where a fact came from. Kept for provenance and for re-derivation when the
/// parsers improve. Excluded from the content id, so the same fact from two
/// sources collapses.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Provenance {
    /// Human label, e.g. "Nebraska Medicine".
    pub source: String,
    /// Content hash of the verbatim source document this fact was derived from.
    pub source_doc: Option<String>,
}

/// The value an event carries. Lean and FHIR-informed; numeric quantities are
/// **decimal strings**, never floats, so the canonical bytes are exact and
/// trivially reproducible by a non-Rust reimplementation.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EventValue {
    /// A measured quantity, e.g. `value = "118"`, `unit = mm[Hg]` (UCUM).
    Quantity { value: String, unit: Option<Code> },
    /// A coded value, e.g. an allergy substance or a condition's clinical status.
    Coded(Code),
    /// Free text.
    Text(String),
    /// A captured document (e.g. a photographed paper record). The bytes live
    /// out of band as a content-addressed, vault-sealed blob; the event carries
    /// only the address (`sha256`, the lowercase-hex SHA-256 of the *plaintext*
    /// bytes so the id is derivable pre-encryption and matches across devices),
    /// the `mime` type, and the byte `size`. The user's caption is NOT a field
    /// here: it rides as a sibling [`Text`](EventValue::Text)-valued `document`
    /// event sharing the same `effective_at` (the "one event per component,
    /// grouping is presentational" convention this schema already uses for a BP
    /// pair or a multi-item meal), so the caption lives exactly where a note's
    /// text lives and the image event's content id stays a pure function of the
    /// bytes, independent of any caption.
    Attachment {
        sha256: String,
        mime: String,
        size: u64,
    },
}

/// A content-addressed event id: SHA-256 over [`Event::canonical_content`].
/// Serializes as lowercase hex.
#[derive(Clone, Copy, PartialEq, Eq, Hash)]
pub struct EventId([u8; 32]);

impl EventId {
    /// The raw 32 hash bytes (what the signature commits to).
    pub fn as_bytes(&self) -> &[u8; 32] {
        &self.0
    }

    /// Lowercase-hex form.
    pub fn to_hex(&self) -> String {
        hex::encode(self.0)
    }

    /// Parse from 64 lowercase-hex chars.
    pub fn from_hex(s: &str) -> Result<Self, EventError> {
        let bytes: [u8; 32] = hex::decode(s)
            .map_err(|_| EventError::BadId)?
            .try_into()
            .map_err(|_| EventError::BadId)?;
        Ok(Self(bytes))
    }
}

impl fmt::Display for EventId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.to_hex())
    }
}

impl fmt::Debug for EventId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "EventId({})", self.to_hex())
    }
}

impl Serialize for EventId {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_hex())
    }
}

impl<'de> Deserialize<'de> for EventId {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        let s = String::deserialize(d)?;
        Self::from_hex(&s).map_err(serde::de::Error::custom)
    }
}

/// A single immutable clinical fact. `id` is content-addressed (a commitment to
/// the clinical content), so the same fact imported from two providers collapses
/// on union. Construct via [`Event::new`], which stamps the id.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Event {
    pub id: EventId,
    pub kind: EventKind,
    pub code: Option<Code>,
    /// ISO-8601 instant the fact pertains to.
    pub effective_at: Option<String>,
    pub value: Option<EventValue>,
    pub provenance: Provenance,
}

impl Event {
    /// Build an event, stamping its content-addressed [`id`](Event::id).
    pub fn new(
        kind: EventKind,
        code: Option<Code>,
        effective_at: Option<String>,
        value: Option<EventValue>,
        provenance: Provenance,
    ) -> Self {
        let mut event = Self {
            id: EventId([0u8; 32]),
            kind,
            code,
            effective_at,
            value,
            provenance,
        };
        event.id = event.content_id();
        event
    }

    /// The canonical byte encoding of the clinical content — `kind ‖ code? ‖
    /// effective_at? ‖ value?`. Excludes `id` and `provenance`. This is the
    /// hashed preimage of the content id and the public, language-neutral
    /// definition a reimplementation must reproduce.
    pub fn canonical_content(&self) -> Vec<u8> {
        let mut out = Vec::new();
        put_str(&mut out, self.kind.wire_name());
        put_opt_code(&mut out, &self.code);
        put_opt_str(&mut out, &self.effective_at);
        put_opt_value(&mut out, &self.value);
        out
    }

    /// The content-addressed id: SHA-256 over a domain tag and the canonical
    /// content. Independent of the stored `id` field, so it validates it too.
    pub fn content_id(&self) -> EventId {
        let mut hasher = Sha256::new();
        hasher.update(DOMAIN_EVENT_ID);
        hasher.update(self.canonical_content());
        EventId(hasher.finalize().into())
    }

    /// The bytes an author signs: a version-tagged domain prefix, the content id
    /// (a binding commitment to all content), and the canonical provenance.
    /// Recomputes the content id rather than trusting the stored field.
    pub fn signing_bytes(&self) -> Vec<u8> {
        let mut out = Vec::new();
        out.extend_from_slice(crate::version_label("event").as_bytes());
        out.extend_from_slice(self.content_id().as_bytes());
        put_str(&mut out, &self.provenance.source);
        put_opt_str(&mut out, &self.provenance.source_doc);
        out
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EventKind {
    Observation,
    Condition,
    MedicationStatement,
    Immunization,
    Encounter,
    Procedure,
    AllergyIntolerance,
    Document,
    /// Self-reported food or drink intake (FHIR R5 NutritionIntake is the
    /// model). One event per item; a multi-item meal shares an `effective_at`.
    NutritionIntake,
}

impl EventKind {
    /// The stable wire name (matches the serde `snake_case` form). Used in the
    /// canonical encoding so reordering this enum cannot silently change ids.
    fn wire_name(&self) -> &'static str {
        match self {
            EventKind::Observation => "observation",
            EventKind::Condition => "condition",
            EventKind::MedicationStatement => "medication_statement",
            EventKind::Immunization => "immunization",
            EventKind::Encounter => "encounter",
            EventKind::Procedure => "procedure",
            EventKind::AllergyIntolerance => "allergy_intolerance",
            EventKind::Document => "document",
            EventKind::NutritionIntake => "nutrition_intake",
        }
    }
}

/// An [`Event`] signed by its author's Ed25519 key. The signature covers the
/// content id and provenance; see [`Event::signing_bytes`]. Two providers'
/// identical fact share an `id` but carry different signatures — union keeps one.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SignedEvent {
    pub event: Event,
    #[serde(with = "hex_bytes")]
    author: [u8; 32],
    #[serde(with = "hex_bytes")]
    signature: [u8; 64],
}

impl SignedEvent {
    /// Assemble from parts (used by [`crate::keys::Identity::sign_event`]).
    pub fn new(event: Event, author: [u8; 32], signature: [u8; 64]) -> Self {
        Self {
            event,
            author,
            signature,
        }
    }

    /// The author's Ed25519 public key.
    pub fn author(&self) -> &[u8; 32] {
        &self.author
    }

    /// The Ed25519 signature over [`Event::signing_bytes`].
    pub fn signature(&self) -> &[u8; 64] {
        &self.signature
    }

    /// Verify the signature binds this exact event to its author. Any tampering
    /// with the event content or provenance, or a wrong author key, fails.
    pub fn verify(&self) -> bool {
        let Ok(author) = VerifyingKey::from_bytes(&self.author) else {
            return false;
        };
        let signature = Signature::from_bytes(&self.signature);
        crate::keys::verify(&author, &self.event.signing_bytes(), &signature)
    }
}

// --- canonical encoding primitives ---
//
// A field is length-prefixed bytes (u32 big-endian length ‖ bytes); an Option is
// a presence byte (0 absent, 1 present) followed by the value when present. See
// `spec/README.md` for the authoritative rules.

fn put_bytes(out: &mut Vec<u8>, bytes: &[u8]) {
    out.extend_from_slice(&(bytes.len() as u32).to_be_bytes());
    out.extend_from_slice(bytes);
}

fn put_str(out: &mut Vec<u8>, s: &str) {
    put_bytes(out, s.as_bytes());
}

/// A `u64` as 8 big-endian bytes — the same fixed-width encoding the relay-auth
/// preimage uses for its timestamp, so a reimplementation needs no new rule for
/// the attachment `size`.
fn put_u64(out: &mut Vec<u8>, n: u64) {
    out.extend_from_slice(&n.to_be_bytes());
}

fn put_opt_str(out: &mut Vec<u8>, s: &Option<String>) {
    match s {
        None => out.push(0),
        Some(v) => {
            out.push(1);
            put_str(out, v);
        }
    }
}

fn put_code(out: &mut Vec<u8>, code: &Code) {
    put_str(out, &code.system);
    put_str(out, &code.code);
    put_opt_str(out, &code.display);
}

fn put_opt_code(out: &mut Vec<u8>, code: &Option<Code>) {
    match code {
        None => out.push(0),
        Some(c) => {
            out.push(1);
            put_code(out, c);
        }
    }
}

fn put_opt_value(out: &mut Vec<u8>, value: &Option<EventValue>) {
    match value {
        None => out.push(0),
        Some(v) => {
            out.push(1);
            match v {
                EventValue::Quantity { value, unit } => {
                    out.push(0);
                    put_str(out, value);
                    put_opt_code(out, unit);
                }
                EventValue::Coded(code) => {
                    out.push(1);
                    put_code(out, code);
                }
                EventValue::Text(text) => {
                    out.push(2);
                    put_str(out, text);
                }
                EventValue::Attachment { sha256, mime, size } => {
                    out.push(3);
                    put_str(out, sha256);
                    put_str(out, mime);
                    put_u64(out, *size);
                }
            }
        }
    }
}

/// serde adapter: fixed-size byte arrays as lowercase hex strings. Avoids pulling
/// the dalek `serde` feature and keeps the wire form hex like the id.
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

    fn loinc_bp() -> Code {
        Code {
            system: "http://loinc.org".into(),
            code: "85354-9".into(),
            display: Some("Blood pressure panel".into()),
        }
    }

    fn observation(value: &str, source: &str) -> Event {
        Event::new(
            EventKind::Observation,
            Some(loinc_bp()),
            Some("2026-01-02T15:04:05Z".into()),
            Some(EventValue::Quantity {
                value: value.into(),
                unit: None,
            }),
            Provenance {
                source: source.into(),
                source_doc: None,
            },
        )
    }

    #[test]
    fn wire_names_match_serde() {
        // The canonical encoding and the JSON form must agree on kind names;
        // a variant added to one but not the other corrupts ids or parsing.
        for kind in [
            EventKind::Observation,
            EventKind::Condition,
            EventKind::MedicationStatement,
            EventKind::Immunization,
            EventKind::Encounter,
            EventKind::Procedure,
            EventKind::AllergyIntolerance,
            EventKind::Document,
            EventKind::NutritionIntake,
        ] {
            let json = serde_json::to_value(&kind).unwrap();
            assert_eq!(json.as_str().unwrap(), kind.wire_name());
        }
    }

    #[test]
    fn id_is_deterministic() {
        assert_eq!(
            observation("118", "Clinic A").id,
            observation("118", "Clinic A").id
        );
    }

    #[test]
    fn id_ignores_provenance() {
        // The same fact from two sources must collapse to one id.
        let a = observation("118", "Clinic A");
        let b = observation("118", "Clinic B");
        assert_ne!(a.provenance, b.provenance);
        assert_eq!(a.content_id(), b.content_id());
    }

    #[test]
    fn distinct_values_diverge() {
        assert_ne!(
            observation("118", "Clinic A").id,
            observation("119", "Clinic A").id
        );
    }

    #[test]
    fn stamped_id_matches_content() {
        let event = observation("118", "Clinic A");
        assert_eq!(event.id, event.content_id());
    }

    #[test]
    fn sign_verify_round_trip() {
        let id = Identity::from_seed(b"author seed");
        let signed = id.sign_event(observation("118", "Clinic A"));
        assert!(signed.verify());
        assert_eq!(signed.author(), &id.verifying_key().to_bytes());
    }

    #[test]
    fn verify_rejects_tampered_content() {
        let id = Identity::from_seed(b"author seed");
        let mut signed = id.sign_event(observation("118", "Clinic A"));
        signed.event.value = Some(EventValue::Quantity {
            value: "200".into(),
            unit: None,
        });
        assert!(!signed.verify());
    }

    #[test]
    fn verify_rejects_tampered_provenance() {
        let id = Identity::from_seed(b"author seed");
        let mut signed = id.sign_event(observation("118", "Clinic A"));
        signed.event.provenance.source = "Forged Clinic".into();
        assert!(!signed.verify());
    }

    #[test]
    fn verify_rejects_wrong_author() {
        let author = Identity::from_seed(b"author seed");
        let attacker = Identity::from_seed(b"attacker seed");
        let signed = author.sign_event(observation("118", "Clinic A"));
        let forged = SignedEvent::new(
            signed.event.clone(),
            attacker.verifying_key().to_bytes(),
            *signed.signature(),
        );
        assert!(!forged.verify());
    }

    #[test]
    fn event_serde_round_trip() {
        let id = Identity::from_seed(b"author seed");
        let signed = id.sign_event(observation("118", "Clinic A"));
        let json = serde_json::to_string(&signed).unwrap();
        let parsed: SignedEvent = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.event, signed.event);
        assert!(parsed.verify());
    }

    // --- attachment value (paper records) ---

    fn attachment_event(sha256: &str, size: u64) -> Event {
        Event::new(
            EventKind::Document,
            None,
            Some("2026-01-02T15:04:05Z".into()),
            Some(EventValue::Attachment {
                sha256: sha256.into(),
                mime: "image/jpeg".into(),
                size,
            }),
            Provenance {
                source: "self".into(),
                source_doc: None,
            },
        )
    }

    #[test]
    fn attachment_id_addresses_the_bytes() {
        // The image event's id is a pure function of the content address, so the
        // same capture on two devices collapses; a different photo diverges.
        let a = attachment_event("aa", 100);
        let b = attachment_event("aa", 100);
        let c = attachment_event("bb", 100);
        assert_eq!(a.id, b.id);
        assert_ne!(a.id, c.id);
        assert_eq!(a.id, a.content_id());
    }

    #[test]
    fn attachment_size_is_part_of_the_id() {
        // size is canonicalized (8-byte BE), so a truncated/wrong length is a
        // different fact and cannot masquerade as the original.
        assert_ne!(
            attachment_event("aa", 100).id,
            attachment_event("aa", 101).id
        );
    }

    #[test]
    fn attachment_canon_layout() {
        // tag 0x01 (present value) ‖ 0x03 (attachment variant) ‖ sha256 ‖ mime ‖
        // size(u64 BE). Pin the tail bytes so a reimplementation matches exactly.
        let canon = attachment_event("ab", 258).canonical_content();
        let value_start = canon
            .windows(2)
            .rposition(|w| w == [0x01, 0x03])
            .expect("present-attachment tag pair");
        assert_eq!(
            &canon[value_start..],
            &[
                0x01, 0x03, // present, attachment
                0, 0, 0, 2, b'a', b'b', // sha256 "ab"
                0, 0, 0, 10, b'i', b'm', b'a', b'g', b'e', b'/', b'j', b'p', b'e',
                b'g', // mime
                0, 0, 0, 0, 0, 0, 1, 2, // size 258 as u64 BE
            ]
        );
    }

    #[test]
    fn attachment_sign_verify_and_serde_round_trip() {
        let id = Identity::from_seed(b"author seed");
        let signed = id.sign_event(attachment_event("deadbeef", 12345));
        assert!(signed.verify());
        let json = serde_json::to_string(&signed).unwrap();
        let parsed: SignedEvent = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.event, signed.event);
        assert!(parsed.verify());
    }

    // --- pinned spec vectors ---

    #[derive(Deserialize)]
    struct VectorFile {
        contract_version: u32,
        events: Vec<EventVector>,
    }

    #[derive(Deserialize)]
    struct EventVector {
        event: Event,
        canon_hex: String,
        id_hex: String,
        signer_seed_hex: Option<String>,
        author_hex: Option<String>,
        signature_hex: Option<String>,
    }

    const VECTORS: &str = include_str!("../../../spec/vectors/event.json");

    #[test]
    fn matches_spec_vectors() {
        let file: VectorFile = serde_json::from_str(VECTORS).expect("parse vectors");
        assert_eq!(
            file.contract_version,
            crate::CONTRACT_VERSION,
            "vectors are pinned to a different contract version"
        );

        for v in &file.events {
            // Canonical bytes and the derived id must reproduce, and the event's
            // stored id must equal its content id.
            assert_eq!(
                hex::encode(v.event.canonical_content()),
                v.canon_hex,
                "canon"
            );
            assert_eq!(v.event.content_id().to_hex(), v.id_hex, "id");
            assert_eq!(v.event.id.to_hex(), v.id_hex, "stored id");

            if let Some(seed) = &v.signer_seed_hex {
                let signer = Identity::from_seed(&hex::decode(seed).unwrap());
                let signed = signer.sign_event(v.event.clone());
                assert_eq!(
                    hex::encode(signed.author()),
                    *v.author_hex.as_ref().unwrap(),
                    "author",
                );
                assert_eq!(
                    hex::encode(signed.signature()),
                    *v.signature_hex.as_ref().unwrap(),
                    "signature",
                );
                assert!(signed.verify(), "verify");
            }
        }
    }
}
