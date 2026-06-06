//! The event schema: the typed, immutable, append-only facts that make up a
//! record. Most clinical history is immutable history, so events are appended and
//! merged by union (plus de-duplication); a thin mutable curation layer lives
//! separately. This keeps conflict resolution light.
//!
//! FHIR and C-CDA are interface formats only (see ARCHITECTURE). Internally we
//! keep a lean, FHIR-informed shape and reuse the standard code systems.

use serde::{Deserialize, Serialize};

/// A coded value drawn from a standard terminology (LOINC, RxNorm, SNOMED, CVX).
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Code {
    /// Terminology URI, e.g. "http://loinc.org".
    pub system: String,
    pub code: String,
    pub display: Option<String>,
}

/// Where a fact came from. Kept for provenance and for re-derivation when the
/// parsers improve.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Provenance {
    /// Human label, e.g. "Nebraska Medicine".
    pub source: String,
    /// Content hash of the verbatim source document this fact was derived from.
    pub source_doc: Option<String>,
}

/// A single immutable clinical fact. `id` is stable and content-addressed so the
/// same fact imported from two providers can be de-duplicated on union.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Event {
    pub id: String,
    pub kind: EventKind,
    pub code: Option<Code>,
    /// ISO-8601 instant the fact pertains to.
    pub effective_at: Option<String>,
    pub provenance: Provenance,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
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
}
