//! Generates `spec/vectors/event.json` from the implementation. Run:
//!   cargo run -p svastha-core --example event_vectors > spec/vectors/event.json
//! The committed vectors are the frozen output of this; rerun only on a
//! deliberate, version-bumped contract change.
//!
//! Each entry carries the structured event, its canonical bytes, and its derived
//! id; signed entries also carry a fixed signer seed, the author key, and the
//! (deterministic, RFC 8032) signature. The two observation entries differ only
//! in provenance to pin the cross-source id collision.

use serde::Serialize;
use svastha_core::event::{Code, Event, EventKind, EventValue, Provenance};
use svastha_core::keys::Identity;
use svastha_core::CONTRACT_VERSION;

// A fixed signer seed (HKDF IKM bytes, not a BIP39 seed); Ed25519 signing is
// deterministic, so the signature below is reproducible.
const SIGNER_SEED_HEX: &str = "0102030405060708090a0b0c0d0e0f10";

#[derive(Serialize)]
struct VectorFile {
    contract_version: u32,
    events: Vec<EventVector>,
}

#[derive(Serialize)]
struct EventVector {
    /// What this vector exercises.
    note: String,
    event: Event,
    canon_hex: String,
    id_hex: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    signer_seed_hex: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    author_hex: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    signature_hex: Option<String>,
}

fn loinc_bp() -> Code {
    Code {
        system: "http://loinc.org".into(),
        code: "85354-9".into(),
        display: Some("Blood pressure panel".into()),
    }
}

/// An unsigned vector: structured event + its canonical bytes and id.
fn unsigned(note: &str, event: Event) -> EventVector {
    EventVector {
        note: note.into(),
        canon_hex: hex::encode(event.canonical_content()),
        id_hex: event.content_id().to_hex(),
        signer_seed_hex: None,
        author_hex: None,
        signature_hex: None,
        event,
    }
}

/// A signed vector: the above, plus the author key and deterministic signature.
fn signed(note: &str, event: Event) -> EventVector {
    let signer = Identity::from_seed(&hex::decode(SIGNER_SEED_HEX).unwrap());
    let signed = signer.sign_event(event.clone());
    EventVector {
        note: note.into(),
        canon_hex: hex::encode(event.canonical_content()),
        id_hex: event.content_id().to_hex(),
        signer_seed_hex: Some(SIGNER_SEED_HEX.to_string()),
        author_hex: Some(hex::encode(signed.author())),
        signature_hex: Some(hex::encode(signed.signature())),
        event,
    }
}

fn observation(source: &str) -> Event {
    Event::new(
        EventKind::Observation,
        Some(loinc_bp()),
        Some("2026-01-02T15:04:05Z".into()),
        Some(EventValue::Quantity {
            value: "118".into(),
            unit: Some(Code {
                system: "http://unitsofmeasure.org".into(),
                code: "mm[Hg]".into(),
                display: None,
            }),
        }),
        Provenance {
            source: source.into(),
            source_doc: None,
        },
    )
}

fn main() {
    let events = vec![
        signed(
            "observation with quantity value, signed",
            observation("Nebraska Medicine"),
        ),
        unsigned(
            "same fact from a second source: identical id, different provenance",
            observation("Clinic of the Plains"),
        ),
        signed(
            "immunization coded value, no effective_at, signed",
            Event::new(
                EventKind::Immunization,
                Some(Code {
                    system: "http://hl7.org/fhir/sid/cvx".into(),
                    code: "208".into(),
                    display: Some("COVID-19, mRNA".into()),
                }),
                None,
                Some(EventValue::Coded(Code {
                    system: "http://hl7.org/fhir/sid/cvx".into(),
                    code: "208".into(),
                    display: None,
                })),
                Provenance {
                    source: "State Registry".into(),
                    source_doc: Some("sha256:deadbeef".into()),
                },
            ),
        ),
        signed(
            "nutrition intake text value, signed",
            Event::new(
                EventKind::NutritionIntake,
                None,
                Some("2026-01-02T08:30:00-06:00".into()),
                Some(EventValue::Text("black coffee".into())),
                Provenance {
                    source: "self".into(),
                    source_doc: None,
                },
            ),
        ),
        unsigned(
            "minimal text observation, no code or effective_at",
            Event::new(
                EventKind::Observation,
                None,
                None,
                Some(EventValue::Text("patient reports mild headache".into())),
                Provenance {
                    source: "Self-reported".into(),
                    source_doc: None,
                },
            ),
        ),
        signed(
            "document with an attachment value (a photographed paper record), signed",
            Event::new(
                EventKind::Document,
                None,
                Some("2026-01-02T15:04:05Z".into()),
                Some(EventValue::Attachment {
                    // 32-byte SHA-256 of the plaintext image bytes, lowercase hex.
                    sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
                        .into(),
                    mime: "image/jpeg".into(),
                    size: 148_213,
                }),
                Provenance {
                    source: "self".into(),
                    source_doc: None,
                },
            ),
        ),
        unsigned(
            "the caption sibling: a text `document` sharing the attachment's effective_at",
            Event::new(
                EventKind::Document,
                None,
                Some("2026-01-02T15:04:05Z".into()),
                Some(EventValue::Text("GI consult — Dr. Rao".into())),
                Provenance {
                    source: "self".into(),
                    source_doc: None,
                },
            ),
        ),
    ];

    let file = VectorFile {
        contract_version: CONTRACT_VERSION,
        events,
    };
    println!("{}", serde_json::to_string_pretty(&file).unwrap());
}
