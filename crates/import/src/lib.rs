//! Client-side C-CDA and FHIR R4 mapping into the internal event model.
//!
//! Deliberately **not** part of `svastha-core`: import mapping is churny domain
//! logic (new EHR section quirks, evolving code-system tables, new resource
//! types) that will keep changing long after the trust contract is frozen.
//! Keeping it here means `core`'s canonical encoding and content-id rules — the
//! actual audit surface — never have to move to accommodate a parser fix.
//!
//! Nothing here decrypts, signs, or hashes anything. [`import_ccda`] and
//! [`import_fhir_bundle`] only produce [`EventDraft`]s; the caller (the web app,
//! via `crates/wasm`) is the one that knows the source document's provenance,
//! computes content ids to check against the local event log for dedup, and
//! signs the ones it decides to keep. See `docs/ARCHITECTURE.md`, "Data model
//! and interop".

use serde::Serialize;
use svastha_core::event::{Code, EventKind, EventValue};

pub mod ccda;
pub mod dates;
pub mod fhir;

/// Terminology system URIs shared by both mappers (also mirrored in
/// `web/src/lib/codes.ts` — keep the strings identical so a fact mapped from
/// either format uses the same system URI).
pub(crate) mod systems {
    pub const LOINC: &str = "http://loinc.org";
    pub const SNOMED: &str = "http://snomed.info/sct";
    pub const UCUM: &str = "http://unitsofmeasure.org";
    pub const RXNORM: &str = "http://www.nlm.nih.gov/research/umls/rxnorm";
    pub const CVX: &str = "http://hl7.org/fhir/sid/cvx";
    pub const ICD10CM: &str = "http://hl7.org/fhir/sid/icd-10-cm";
}

/// Failures parsing an import source document. Malformed input is rejected
/// outright; anything that parses but doesn't map to a known shape becomes a
/// [`Skipped`] entry instead of an error, so one bad entry in a 70-document
/// package never aborts the rest.
#[derive(Debug, thiserror::Error)]
pub enum ImportError {
    #[error("malformed XML: {0}")]
    Xml(#[from] roxmltree::Error),
    #[error("malformed JSON: {0}")]
    Json(#[from] serde_json::Error),
    #[error("not a FHIR bundle (resourceType must be \"Bundle\")")]
    NotABundle,
}

/// One clinical fact mapped from a source document — everything an
/// `svastha_core::event::Event` needs except `id` (content-derived) and
/// `provenance` (stamped by the caller, who knows the source document's hash
/// and label; this crate never sees them).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct EventDraft {
    pub kind: EventKind,
    pub code: Option<Code>,
    pub effective_at: Option<String>,
    pub value: Option<EventValue>,
}

/// A source entry the mapper declined to turn into a draft, with why. Every
/// unmapped section, resource type, or nullFlavor'd/unsupported field produces
/// one of these — never silently dropped.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Skipped {
    pub what: String,
    pub why: String,
}

/// The output of importing one source document.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Default)]
pub struct ImportResult {
    pub events: Vec<EventDraft>,
    pub warnings: Vec<String>,
    pub skipped: Vec<Skipped>,
}

/// Map a C-CDA document (a CCD or a per-encounter Summary of Care) to draft
/// events. See `crates/import/src/ccda.rs` for the section dispatch table.
pub fn import_ccda(xml: &str) -> Result<ImportResult, ImportError> {
    ccda::import(xml)
}

/// Map a FHIR R4 `Bundle` to draft events. See `crates/import/src/fhir.rs` for
/// the resourceType dispatch table.
pub fn import_fhir_bundle(json: &str) -> Result<ImportResult, ImportError> {
    fhir::import(json)
}
