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
//!   clinical content, *excluding* `id`, `provenance`, and `proposed`. The same
//!   immunization reported by two providers (differing only in provenance) gets
//!   the same id, so a union merge de-duplicates it; likewise a fact approved
//!   from a proposal collapses with the same fact logged directly. The id is
//!   deliberately version-*independent* so a fact keeps its identity across a
//!   contract bump.
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

/// Attestation that this event began as a *proposal* — a draft suggested by some
/// granted identity (a processing node, or a future human caregiver) that the
/// owner reviewed and signed. Optional and absent on every ordinary
/// self-authored event: when the owner signs an approved proposal, this records
/// *who* proposed it and *from what* source, so an approved event carries its own
/// provenance forward. Like [`Provenance`], it is **excluded from the content id**
/// (so an approved fact keeps the same id as the same fact logged directly, and
/// still de-duplicates), but — unlike `Provenance`, which was always present — it
/// is folded into the signing preimage *only when present*, so pre-existing
/// events sign byte-identically (see [`Event::signing_bytes`]).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Proposed {
    /// The proposer's Ed25519 identity (lowercase hex), e.g. the node that ran
    /// the extraction. Data the owner vouches for by signing, not a key verified
    /// here.
    pub by: String,
    /// The source blob the extraction drew from (an `att-` or `doc-` id).
    pub source_blob: Option<String>,
    /// The extraction method, e.g. `"ocr"`.
    pub method: Option<String>,
    /// The inference model id used, if any.
    pub model: Option<String>,
}

/// The value an event carries. Lean and FHIR-informed; numeric quantities are
/// **decimal strings**, never floats, so the canonical bytes are exact and
/// trivially reproducible by a non-Rust reimplementation.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EventValue {
    /// A measured quantity, e.g. `value = "118"`, `unit = mm[Hg]` (UCUM).
    Quantity {
        value: String,
        unit: Option<Code>,
    },
    /// A coded value, e.g. an allergy substance or a condition's clinical status.
    Coded(Code),
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
    /// How a medication is taken, as the source states it (FHIR `Dosage`, a
    /// C-CDA sig): written by import on a `medication_statement`. Validated on
    /// construction and on decode — see [`Dosage`].
    Dosage(Dosage),
}

/// A measured amount inside a [`Dosage`]: the same `value ‖ unit?` fields, and
/// the same canonical encoding, as the [`EventValue::Quantity`] variant. A
/// struct of its own only because the variant's fields are inline.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Quantity {
    pub value: String,
    pub unit: Option<Code>,
}

/// The repeat-period unit of a [`Dosage`]: a closed UCUM subset. A sig's period
/// is hours, days, weeks, or months; anything else (`min`, `s`, `a`, a
/// mis-cased `H`) is refused at decode as an unknown variant rather than carried
/// as an opaque string a later reader would have to second-guess.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum PeriodUnit {
    #[serde(rename = "h")]
    Hour,
    #[serde(rename = "d")]
    Day,
    #[serde(rename = "wk")]
    Week,
    #[serde(rename = "mo")]
    Month,
}

impl PeriodUnit {
    /// The stable wire name (matches the serde form). Used in the canonical
    /// encoding so renaming a variant cannot silently change ids.
    pub fn wire_name(self) -> &'static str {
        match self {
            PeriodUnit::Hour => "h",
            PeriodUnit::Day => "d",
            PeriodUnit::Week => "wk",
            PeriodUnit::Month => "mo",
        }
    }
}

/// The fields of a [`Dosage`], all optional, in canonical-encoding order.
/// Numbers are strings, never floats (as with [`EventValue::Quantity`]).
/// Build one and pass it to [`Dosage::new`], which validates it.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct DosageFields {
    /// The amount per administration, e.g. `500` `mg`.
    pub dose: Option<Quantity>,
    /// The free-text sig (FHIR `dosage.text`, a C-CDA free-text sig).
    pub text: Option<String>,
    /// Administrations per period (FHIR `timing.repeat.frequency`).
    pub frequency: Option<String>,
    /// The repeat period's length (FHIR `timing.repeat.period`).
    pub period: Option<String>,
    /// The repeat period's unit (FHIR `timing.repeat.periodUnit`).
    pub period_unit: Option<PeriodUnit>,
    /// An event-timing code (FHIR `timing.repeat.when`), e.g. `AC`, `HS`.
    pub when: Option<String>,
    /// Taken as needed (FHIR `asNeededBoolean`). Tri-state: absent is "the
    /// source did not say", `false` is "scheduled".
    pub as_needed: Option<bool>,
}

/// Why a [`Dosage`] was refused.
#[derive(Debug, PartialEq, Eq, thiserror::Error)]
pub enum DosageError {
    #[error("a dosage must carry at least one field")]
    Empty,
    #[error("dosage `{0}` must not be blank")]
    Blank(&'static str),
    #[error(
        "dosage `frequency` must be a positive integer in ASCII digits, without a leading zero"
    )]
    BadFrequency,
    #[error(
        "dosage `{0}` must be an unsigned ASCII decimal (`0`, `12`, `0.5`): no sign, exponent, or leading zero"
    )]
    BadDecimal(&'static str),
    #[error("dosage `period` and `period_unit` must be given together")]
    UnpairedPeriod,
}

/// A validated dosage: [`DosageFields`] that passed [`Dosage::new`]. The inner
/// fields are private and decode goes through the same check (`try_from`), so
/// an invalid dosage cannot be built, deserialized, hashed, or signed.
///
/// The rules (`spec/README.md`, "Event schema", is authoritative):
/// - at least one field is present — an empty dosage says nothing, and a blank
///   `text` or `when` would let one through, so those must be non-blank;
/// - `frequency` is a positive integer in ASCII digits, no leading zero;
/// - `period` and `dose.value` are unsigned ASCII decimals,
///   `(0|[1-9][0-9]*)(\.[0-9]+)?`, so one amount has one spelling the content
///   id can rely on and any reader can parse it without a float;
/// - `period` and `period_unit` appear together or not at all.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(try_from = "DosageFields", into = "DosageFields")]
pub struct Dosage(DosageFields);

impl Dosage {
    pub fn new(fields: DosageFields) -> Result<Self, DosageError> {
        let DosageFields {
            dose,
            text,
            frequency,
            period,
            period_unit,
            when,
            as_needed,
        } = &fields;
        if dose.is_none()
            && text.is_none()
            && frequency.is_none()
            && period.is_none()
            && period_unit.is_none()
            && when.is_none()
            && as_needed.is_none()
        {
            return Err(DosageError::Empty);
        }
        if let Some(dose) = dose {
            if !is_unsigned_decimal(&dose.value) {
                return Err(DosageError::BadDecimal("dose.value"));
            }
        }
        for (name, value) in [("text", text), ("when", when)] {
            if value.as_deref().is_some_and(|s| s.trim().is_empty()) {
                return Err(DosageError::Blank(name));
            }
        }
        if let Some(frequency) = frequency {
            if !is_positive_integer(frequency) {
                return Err(DosageError::BadFrequency);
            }
        }
        if let Some(period) = period {
            if !is_unsigned_decimal(period) {
                return Err(DosageError::BadDecimal("period"));
            }
        }
        if period.is_some() != period_unit.is_some() {
            return Err(DosageError::UnpairedPeriod);
        }
        Ok(Self(fields))
    }

    pub fn fields(&self) -> &DosageFields {
        &self.0
    }
}

impl TryFrom<DosageFields> for Dosage {
    type Error = DosageError;

    fn try_from(fields: DosageFields) -> Result<Self, DosageError> {
        Self::new(fields)
    }
}

impl From<Dosage> for DosageFields {
    fn from(dosage: Dosage) -> Self {
        dosage.0
    }
}

// Byte-wise, so a non-ASCII digit (`٣`, a full-width `２`) is refused rather
// than accepted by a Unicode-aware `is_numeric`.
fn is_positive_integer(s: &str) -> bool {
    let b = s.as_bytes();
    !b.is_empty() && b[0] != b'0' && b.iter().all(u8::is_ascii_digit)
}

fn is_unsigned_decimal(s: &str) -> bool {
    let (int, frac) = match s.split_once('.') {
        Some((int, frac)) => (int, Some(frac)),
        None => (s, None),
    };
    let digits = |p: &str| !p.is_empty() && p.bytes().all(|c| c.is_ascii_digit());
    digits(int) && (int.len() == 1 || !int.starts_with('0')) && frac.is_none_or(digits)
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
    /// Optional proposal provenance (see [`Proposed`]). Absent on ordinary
    /// self-authored events; `skip_serializing_if` keeps it off the wire when
    /// `None`, so pre-existing events serialize byte-identically.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub proposed: Option<Proposed>,
}

impl Event {
    /// Build an event, stamping its content-addressed [`id`](Event::id). The
    /// event carries no proposal provenance; attach it with
    /// [`with_proposed`](Event::with_proposed) before signing when the event
    /// began as an approved proposal.
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
            proposed: None,
        };
        event.id = event.content_id();
        event
    }

    /// Attach proposal provenance. Consumes and returns the event; does **not**
    /// change the content id (proposal provenance is excluded from it), so an
    /// approved proposal keeps the same id as the same fact logged directly.
    pub fn with_proposed(mut self, proposed: Proposed) -> Self {
        self.proposed = Some(proposed);
        self
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
        // Additive signed field. CANONICALIZATION INVARIANT: an absent `proposed`
        // appends *zero* bytes — NOT a 0x00 presence byte the way an in-struct
        // Option does (put_opt_str above). That is deliberate and load-bearing:
        // every event authored before this field existed, and every ordinary
        // self-authored event since, has `proposed == None` and MUST produce the
        // exact preimage it did before, so its signature stays valid without a
        // CONTRACT_MAJOR bump. When present, the fields are appended so the owner
        // attests to the proposal provenance. Absence and presence are
        // unambiguous — the verifier reconstructs the preimage from the event's
        // own `proposed` field — so stripping or forging the field flips the
        // recomputed preimage and fails verification.
        if let Some(p) = &self.proposed {
            put_str(&mut out, &p.by);
            put_opt_str(&mut out, &p.source_blob);
            put_opt_str(&mut out, &p.method);
            put_opt_str(&mut out, &p.model);
        }
        out
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EventKind {
    Observation,
    Condition,
    /// "I take / was on this medication": a standing statement.
    MedicationStatement,
    Immunization,
    Encounter,
    Procedure,
    AllergyIntolerance,
    Document,
    /// Self-reported food or drink intake (FHIR R5 NutritionIntake is the
    /// model). One event per item; a multi-item meal shares an `effective_at`.
    NutritionIntake,
    /// "I took this, at this time": one self-reported dose (a rescue-inhaler
    /// puff), dated by `effective_at`. Distinct from `medication_statement` so a
    /// log of doses never reads as a list of standing medications. Exports as a
    /// FHIR MedicationStatement with `effectiveDateTime`, not a
    /// MedicationAdministration (that resource is for clinician-given doses).
    MedicationDose,
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
            EventKind::MedicationDose => "medication_dose",
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
                EventValue::Dosage(dosage) => {
                    out.push(4);
                    put_dosage(out, dosage.fields());
                }
            }
        }
    }
}

/// `dose? ‖ text? ‖ frequency? ‖ period? ‖ period_unit? ‖ when? ‖ as_needed?`,
/// every field an option. A present `dose` is the quantity variant's own
/// `value ‖ unit?`, so the two spell an amount identically.
fn put_dosage(out: &mut Vec<u8>, d: &DosageFields) {
    match &d.dose {
        None => out.push(0),
        Some(q) => {
            out.push(1);
            put_str(out, &q.value);
            put_opt_code(out, &q.unit);
        }
    }
    put_opt_str(out, &d.text);
    put_opt_str(out, &d.frequency);
    put_opt_str(out, &d.period);
    match d.period_unit {
        None => out.push(0),
        Some(unit) => {
            out.push(1);
            put_str(out, unit.wire_name());
        }
    }
    put_opt_str(out, &d.when);
    match d.as_needed {
        None => out.push(0),
        Some(b) => {
            out.push(1);
            out.push(u8::from(b));
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
            EventKind::MedicationDose,
        ] {
            let json = serde_json::to_value(&kind).unwrap();
            assert_eq!(json.as_str().unwrap(), kind.wire_name());
        }
        for unit in [
            PeriodUnit::Hour,
            PeriodUnit::Day,
            PeriodUnit::Week,
            PeriodUnit::Month,
        ] {
            let json = serde_json::to_value(unit).unwrap();
            assert_eq!(json.as_str().unwrap(), unit.wire_name());
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

    // --- proposal provenance (approved-from-proposal events) ---

    fn proposed() -> Proposed {
        Proposed {
            by: "aa".repeat(32),
            source_blob: Some("att-deadbeef".into()),
            method: Some("ocr".into()),
            model: Some("some-vision-model".into()),
        }
    }

    #[test]
    fn proposed_is_excluded_from_content_id() {
        // An approved proposal must share the id of the same fact logged directly,
        // so the union/de-dup property survives the approval path.
        let plain = observation("118", "Clinic A");
        let with_prov = observation("118", "Clinic A").with_proposed(proposed());
        assert_eq!(plain.id, with_prov.id);
        assert_eq!(with_prov.id, with_prov.content_id());
    }

    #[test]
    fn absent_proposed_signs_identically_to_before() {
        // The core backward-compat guarantee: an event with `proposed == None`
        // produces the exact preimage it did before the field existed (no
        // trailing presence byte), so pre-existing signatures stay valid.
        let ev = observation("118", "Clinic A");
        let base = {
            let mut out = Vec::new();
            out.extend_from_slice(crate::version_label("event").as_bytes());
            out.extend_from_slice(ev.content_id().as_bytes());
            put_str(&mut out, &ev.provenance.source);
            put_opt_str(&mut out, &ev.provenance.source_doc);
            out
        };
        assert_eq!(ev.signing_bytes(), base);
    }

    #[test]
    fn proposed_sign_verify_round_trip() {
        let id = Identity::from_seed(b"owner seed");
        let signed = id.sign_event(observation("118", "Clinic A").with_proposed(proposed()));
        assert!(signed.verify());
    }

    #[test]
    fn verify_rejects_stripped_proposed() {
        // A signature made over an event WITH proposal provenance must fail if the
        // field is removed in transit (and, symmetrically, if one is added).
        let id = Identity::from_seed(b"owner seed");
        let mut signed = id.sign_event(observation("118", "Clinic A").with_proposed(proposed()));
        signed.event.proposed = None;
        assert!(!signed.verify());
    }

    #[test]
    fn verify_rejects_added_proposed() {
        let id = Identity::from_seed(b"owner seed");
        let mut signed = id.sign_event(observation("118", "Clinic A"));
        signed.event.proposed = Some(proposed());
        assert!(!signed.verify());
    }

    #[test]
    fn proposed_serde_omits_when_absent() {
        let ev = observation("118", "Clinic A");
        let json = serde_json::to_value(&ev).unwrap();
        assert!(
            json.get("proposed").is_none(),
            "absent proposed must not serialize"
        );
        let with_prov = ev.with_proposed(proposed());
        let json = serde_json::to_value(&with_prov).unwrap();
        assert!(json.get("proposed").is_some());
        let parsed: Event = serde_json::from_value(json).unwrap();
        assert_eq!(parsed, with_prov);
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

    // --- medication_dose kind and dosage value ---

    fn ucum(code: &str) -> Code {
        Code {
            system: "http://unitsofmeasure.org".into(),
            code: code.into(),
            display: None,
        }
    }

    fn self_reported() -> Provenance {
        Provenance {
            source: "self".into(),
            source_doc: None,
        }
    }

    fn twice_daily() -> DosageFields {
        DosageFields {
            dose: Some(Quantity {
                value: "500".into(),
                unit: Some(ucum("mg")),
            }),
            text: Some("1 tab twice daily".into()),
            frequency: Some("2".into()),
            period: Some("1".into()),
            period_unit: Some(PeriodUnit::Day),
            when: Some("C".into()),
            as_needed: Some(false),
        }
    }

    fn dosage_event(fields: DosageFields) -> Event {
        Event::new(
            EventKind::MedicationStatement,
            None,
            None,
            Some(EventValue::Dosage(Dosage::new(fields).unwrap())),
            self_reported(),
        )
    }

    /// Decode a dosage from its JSON form — the path an event from another
    /// device takes — so the decode-side check is exercised, not just `new`.
    fn decode(json: serde_json::Value) -> Result<Dosage, serde_json::Error> {
        serde_json::from_value(json)
    }

    #[test]
    fn dosage_canon_layout() {
        // tag 0x01 (present value) ‖ 0x04 (dosage) ‖ every field as an option.
        // Pinned so a reimplementation matches exactly.
        let canon = dosage_event(twice_daily()).canonical_content();
        let start = canon
            .windows(2)
            .rposition(|w| w == [0x01, 0x04])
            .expect("present-dosage tag pair");
        let mut want = vec![0x01, 0x04];
        want.extend([1, 0, 0, 0, 3, b'5', b'0', b'0']); // dose.value "500"
        want.extend([1, 0, 0, 0, 25]); // dose.unit present, system
        want.extend(b"http://unitsofmeasure.org");
        want.extend([0, 0, 0, 2, b'm', b'g', 0]); // code "mg", no display
        want.extend([1, 0, 0, 0, 17]); // text
        want.extend(b"1 tab twice daily");
        want.extend([1, 0, 0, 0, 1, b'2']); // frequency "2"
        want.extend([1, 0, 0, 0, 1, b'1']); // period "1"
        want.extend([1, 0, 0, 0, 1, b'd']); // period_unit "d"
        want.extend([1, 0, 0, 0, 1, b'C']); // when "C"
        want.extend([1, 0]); // as_needed false
        assert_eq!(&canon[start..], &want[..]);
    }

    #[test]
    fn dosage_absent_fields_are_presence_bytes() {
        let canon = dosage_event(DosageFields {
            as_needed: Some(true),
            ..Default::default()
        })
        .canonical_content();
        assert_eq!(
            &canon[canon.len() - 10..],
            &[0x01, 0x04, 0, 0, 0, 0, 0, 0, 1, 1],
            "six absent fields, then as_needed = true"
        );
    }

    #[test]
    fn dosage_serde_shape_and_round_trip() {
        let event = dosage_event(twice_daily());
        let json = serde_json::to_value(&event).unwrap();
        let dosage = &json["value"]["dosage"];
        assert_eq!(dosage["dose"]["value"], "500");
        assert_eq!(dosage["period_unit"], "d");
        assert_eq!(dosage["as_needed"], false);
        let parsed: Event = serde_json::from_value(json).unwrap();
        assert_eq!(parsed, event);
        assert_eq!(parsed.content_id(), event.id);
    }

    #[test]
    fn dosage_decode_treats_missing_fields_as_absent() {
        let parsed = decode(serde_json::json!({ "text": "as directed" })).unwrap();
        assert_eq!(parsed.fields().text.as_deref(), Some("as directed"));
        assert_eq!(parsed.fields().frequency, None);
    }

    #[test]
    fn period_unit_is_a_closed_set() {
        for good in ["h", "d", "wk", "mo"] {
            decode(serde_json::json!({ "period": "1", "period_unit": good }))
                .unwrap_or_else(|e| panic!("{good:?} should decode: {e}"));
        }
        for bad in ["min", "H", "", "D", "wk ", "s", "a", "day"] {
            assert!(
                decode(serde_json::json!({ "period": "1", "period_unit": bad })).is_err(),
                "{bad:?} must be refused"
            );
        }
    }

    #[test]
    fn frequency_is_a_positive_ascii_integer() {
        for good in ["1", "2", "12", "100"] {
            let fields = DosageFields {
                frequency: Some(good.into()),
                ..Default::default()
            };
            assert!(Dosage::new(fields).is_ok(), "{good:?}");
        }
        for bad in [
            "1.5", "-1", " 2", "2 ", "٣", "２", "0", "01", "", "+1", "1e1", "0x2",
        ] {
            let fields = DosageFields {
                frequency: Some(bad.into()),
                ..Default::default()
            };
            assert_eq!(
                Dosage::new(fields),
                Err(DosageError::BadFrequency),
                "{bad:?}"
            );
            assert!(
                decode(serde_json::json!({ "frequency": bad })).is_err(),
                "{bad:?} must not decode either"
            );
        }
    }

    #[test]
    fn period_and_dose_are_unsigned_ascii_decimals() {
        let with_period = |p: &str| DosageFields {
            period: Some(p.into()),
            period_unit: Some(PeriodUnit::Hour),
            ..Default::default()
        };
        let with_dose = |v: &str| DosageFields {
            dose: Some(Quantity {
                value: v.into(),
                unit: None,
            }),
            ..Default::default()
        };
        for good in ["0", "1", "24", "0.5", "1.50", "10.25"] {
            assert!(Dosage::new(with_period(good)).is_ok(), "period {good:?}");
            assert!(Dosage::new(with_dose(good)).is_ok(), "dose {good:?}");
        }
        for bad in [
            "1e3", "1E3", "1.5e2", "1.", ".5", "-1", "+1", "01", "00.5", "1.2.3", "1,5", "NaN",
            "inf", "٣", " 1", "1 ", "",
        ] {
            assert_eq!(
                Dosage::new(with_period(bad)),
                Err(DosageError::BadDecimal("period")),
                "period {bad:?}"
            );
            assert_eq!(
                Dosage::new(with_dose(bad)),
                Err(DosageError::BadDecimal("dose.value")),
                "dose {bad:?}"
            );
            assert!(decode(serde_json::json!({ "period": bad, "period_unit": "h" })).is_err());
        }
    }

    #[test]
    fn empty_dosage_is_refused() {
        assert_eq!(
            Dosage::new(DosageFields::default()),
            Err(DosageError::Empty)
        );
        assert!(decode(serde_json::json!({})).is_err());
        assert!(decode(serde_json::json!({
            "dose": null, "text": null, "frequency": null, "period": null,
            "period_unit": null, "when": null, "as_needed": null
        }))
        .is_err());
    }

    #[test]
    fn blank_strings_cannot_smuggle_an_empty_dosage_past_the_guard() {
        for blank in ["", " ", "\t\n"] {
            let text = DosageFields {
                text: Some(blank.into()),
                ..Default::default()
            };
            assert_eq!(Dosage::new(text), Err(DosageError::Blank("text")));
            let when = DosageFields {
                when: Some(blank.into()),
                ..Default::default()
            };
            assert_eq!(Dosage::new(when), Err(DosageError::Blank("when")));
        }
    }

    #[test]
    fn period_and_unit_come_together() {
        let period_only = DosageFields {
            period: Some("1".into()),
            ..Default::default()
        };
        assert_eq!(Dosage::new(period_only), Err(DosageError::UnpairedPeriod));
        let unit_only = DosageFields {
            period_unit: Some(PeriodUnit::Day),
            ..Default::default()
        };
        assert_eq!(Dosage::new(unit_only), Err(DosageError::UnpairedPeriod));
    }

    #[test]
    fn an_invalid_dosage_fails_the_whole_event_decode() {
        // The decode a device runs on a synced blob: a signed event carrying a
        // dosage that would not pass `Dosage::new` must not parse at all.
        let signed = Identity::from_seed(b"author seed").sign_event(dosage_event(twice_daily()));
        let mut json = serde_json::to_value(&signed).unwrap();
        json["event"]["value"]["dosage"]["frequency"] = "1.5".into();
        assert!(serde_json::from_value::<SignedEvent>(json).is_err());
    }

    #[test]
    fn dosage_is_not_tied_to_a_kind() {
        // Core is schema-agnostic about kind/value pairing (an attachment is not
        // restricted to `document` either); which kinds carry a dosage is the
        // writer's convention, so another kind still hashes, signs, and decodes.
        let event = Event::new(
            EventKind::Observation,
            None,
            None,
            Some(EventValue::Dosage(Dosage::new(twice_daily()).unwrap())),
            self_reported(),
        );
        let signed = Identity::from_seed(b"author seed").sign_event(event);
        let parsed: SignedEvent =
            serde_json::from_str(&serde_json::to_string(&signed).unwrap()).unwrap();
        assert!(parsed.verify());
    }

    #[test]
    fn a_dose_quantity_and_a_dosage_dose_are_different_facts() {
        // The same "500 mg" as a quantity value and as a dosage's dose canonicalize
        // differently (tag 0x00 vs 0x04 plus the dosage's option bytes), so they
        // have different ids. Pinned so nobody "optimizes" the dosage encoding
        // into the quantity one and silently collapses the two on union.
        let as_quantity = Event::new(
            EventKind::MedicationStatement,
            None,
            None,
            Some(EventValue::Quantity {
                value: "500".into(),
                unit: Some(ucum("mg")),
            }),
            self_reported(),
        );
        let as_dosage = dosage_event(DosageFields {
            dose: Some(Quantity {
                value: "500".into(),
                unit: Some(ucum("mg")),
            }),
            ..Default::default()
        });
        assert_ne!(as_quantity.id, as_dosage.id);
    }

    #[test]
    fn medication_dose_is_not_a_medication_statement() {
        // The kind is part of the id: a dose and a standing statement with the
        // same code, time, and value are different facts.
        let at = |kind| {
            Event::new(
                kind,
                None,
                Some("2026-10-23T14:05:00-05:00".into()),
                Some(EventValue::Text("albuterol".into())),
                self_reported(),
            )
        };
        assert_ne!(
            at(EventKind::MedicationDose).id,
            at(EventKind::MedicationStatement).id
        );
    }

    #[test]
    fn medication_dose_and_dosage_sign_verify_and_reject_tampering() {
        let id = Identity::from_seed(b"author seed");
        for event in [
            Event::new(
                EventKind::MedicationDose,
                None,
                Some("2026-10-23T14:05:00-05:00".into()),
                Some(EventValue::Quantity {
                    value: "2".into(),
                    unit: Some(ucum("{puff}")),
                }),
                self_reported(),
            ),
            dosage_event(twice_daily()),
        ] {
            let signed = id.sign_event(event);
            assert!(signed.verify());
            let parsed: SignedEvent =
                serde_json::from_str(&serde_json::to_string(&signed).unwrap()).unwrap();
            assert!(parsed.verify());
            // Relabelling a dose as a statement (or back) breaks the signature.
            let mut tampered = signed.clone();
            tampered.event.kind = match signed.event.kind {
                EventKind::MedicationDose => EventKind::MedicationStatement,
                _ => EventKind::MedicationDose,
            };
            assert!(!tampered.verify());
        }
        let mut signed = id.sign_event(dosage_event(twice_daily()));
        let mut fields = twice_daily();
        fields.as_needed = Some(true);
        signed.event.value = Some(EventValue::Dosage(Dosage::new(fields).unwrap()));
        assert!(!signed.verify());
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
