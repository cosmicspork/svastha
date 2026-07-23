//! The per-owner plaintext index: the decrypted, verified view of one vault that
//! D2 (OCR → proposals) and D3 (cited Q&A) build on. It is held in memory and is
//! ephemeral — a restart re-syncs it from the relay (see [`crate::sync`]).
//!
//! Two jobs:
//!
//! 1. **Verify-or-drop.** Every event and curation record is checked against the
//!    vault owner (the grant issuer / `key_handoff` sender) before it enters the
//!    index; anything that fails is dropped and counted, never indexed. A grantee
//!    outside the authoring identity cannot grandfather an unsigned or
//!    wrong-signer record the way a device merging its own vault can (the
//!    doctor-share recipient's posture — see `spec/README.md`, "Curation record").
//!
//! 2. **Curation-aware folding.** Events fold into *concepts* keyed
//!    `{kind}|{system}|{code}` (the summary's grouping key). The owner's
//!    `status:`/`name:` curation overlays those concepts — current-vs-past and
//!    display-name overrides — which is what lets later RAG answer "what am I
//!    *currently* taking" correctly rather than as a flat all-active guess.
//!
//! **Curation scope is a convention, not enforcement.** The node's grant is
//! prefix-scoped to `cur-`, but a `cur-` id is a hash of its key, so the relay
//! cannot hand over only `status:`/`name:` records — it delivers *all* curation
//! (tags, notes, hides, favourites included; see the design §4 "known limit").
//! The node therefore receives them and **ignores every namespace except
//! `status:` and `name:`** here, by documented convention: tags, notes, and hides
//! are the owner's private working state and have no bearing on a clinical
//! summary or a retrieval answer.

use std::collections::BTreeMap;

use svastha_core::curation::{merge, SignedCurationRecord};
use svastha_core::event::{Event, EventKind, EventValue, SignedEvent};

/// A captured document's metadata (bytes live in the cache dir). Keyed by the
/// plaintext content hash the event's `attachment` value carries.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AttachmentMeta {
    pub mime: String,
    pub size: usize,
}

/// A verbatim source document's metadata (bytes live in the cache dir). Keyed by
/// its own content hash.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DocMeta {
    pub name: String,
    pub size: usize,
}

/// A concept's current/past status. Defaults to [`Active`](ConceptStatus::Active)
/// when no `status:` override exists (a medication with no override is current, a
/// problem is active).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ConceptStatus {
    Active,
    Inactive,
}

/// The outcome of ingesting one curation record.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CurationOutcome {
    /// A `status:`/`name:` record that verified and was LWW-merged into the index.
    Applied,
    /// A verified record in a namespace the node ignores by convention
    /// (`tag:`/`note:`/`hide:`/`fav:`).
    IgnoredNamespace,
    /// Failed verify-or-drop (bad signature, or an author that is not the owner).
    Dropped,
}

/// The decrypted, verified index of one owner's vault.
pub struct VaultIndex {
    /// The vault owner's Ed25519 key — the signer every event and curation record
    /// must verify against.
    owner: [u8; 32],
    /// Events by content id (hex).
    events: BTreeMap<String, SignedEvent>,
    /// The winning (`status:`/`name:` only) curation record per key, LWW-merged.
    curation: BTreeMap<String, SignedCurationRecord>,
    /// Attachment metadata by plaintext content hash.
    attachments: BTreeMap<String, AttachmentMeta>,
    /// Source-document metadata by content hash.
    docs: BTreeMap<String, DocMeta>,
    /// Count of records dropped by verify-or-drop (never indexed).
    dropped: usize,
}

impl VaultIndex {
    /// A fresh index for the vault owned by `owner` (the identity that must sign
    /// everything it accepts).
    pub fn new(owner: [u8; 32]) -> Self {
        Self {
            owner,
            events: BTreeMap::new(),
            curation: BTreeMap::new(),
            attachments: BTreeMap::new(),
            docs: BTreeMap::new(),
            dropped: 0,
        }
    }

    /// The vault owner's Ed25519 key.
    pub fn owner(&self) -> [u8; 32] {
        self.owner
    }

    /// Verify-or-drop an event, indexing it if it passes. Accepts only a valid
    /// signature **by the vault owner** — a vault holds only its owner's signed
    /// events (an approved proposal is signed by the owner too, with the proposer
    /// recorded in `proposed`), so an event authored by any other key is anomalous
    /// and dropped. Returns whether it was indexed.
    pub fn ingest_event(&mut self, signed: SignedEvent) -> bool {
        if !signed.verify() || *signed.author() != self.owner {
            self.dropped += 1;
            return false;
        }
        self.events.insert(signed.event.id.to_hex(), signed);
        true
    }

    /// Verify-or-drop a curation record. Applies only `status:`/`name:` records by
    /// the owner (LWW-merged); ignores other namespaces by convention; drops
    /// anything that fails verification or is signed by a non-owner.
    pub fn ingest_curation(&mut self, record: SignedCurationRecord) -> CurationOutcome {
        if !record.verify() || record.record.author != self.owner {
            self.dropped += 1;
            return CurationOutcome::Dropped;
        }
        let key = record.record.key.clone();
        if !(key.starts_with("status:") || key.starts_with("name:")) {
            return CurationOutcome::IgnoredNamespace;
        }
        // Last-writer-wins against any record already held for this key, using the
        // trust contract's pure merge (both records already verified).
        let winner = match self.curation.remove(&key) {
            Some(existing) => merge(existing, record),
            None => record,
        };
        self.curation.insert(key, winner);
        CurationOutcome::Applied
    }

    /// Record attachment metadata (its bytes are cached out of band).
    pub fn put_attachment(&mut self, sha256: String, meta: AttachmentMeta) {
        self.attachments.insert(sha256, meta);
    }

    /// Record source-document metadata (its bytes are cached out of band).
    pub fn put_doc(&mut self, sha256: String, meta: DocMeta) {
        self.docs.insert(sha256, meta);
    }

    /// Number of indexed events.
    pub fn event_count(&self) -> usize {
        self.events.len()
    }

    /// Number of applied (`status:`/`name:`) curation records.
    pub fn curation_count(&self) -> usize {
        self.curation.len()
    }

    /// Number of indexed attachments.
    pub fn attachment_count(&self) -> usize {
        self.attachments.len()
    }

    /// Number of indexed source documents.
    pub fn doc_count(&self) -> usize {
        self.docs.len()
    }

    /// Records dropped by verify-or-drop.
    pub fn dropped(&self) -> usize {
        self.dropped
    }

    /// All indexed events, in content-id order.
    pub fn events(&self) -> impl Iterator<Item = &SignedEvent> {
        self.events.values()
    }

    /// One event by content id (hex).
    pub fn event(&self, id_hex: &str) -> Option<&SignedEvent> {
        self.events.get(id_hex)
    }

    /// Attachment metadata by content hash — a provenance-ready lookup for a
    /// proposal citing the source page it was extracted from.
    pub fn attachment(&self, sha256: &str) -> Option<&AttachmentMeta> {
        self.attachments.get(sha256)
    }

    /// The content hashes of every captured **image** attachment, in id order.
    /// This is D2's OCR work queue: `image/*` pages only — a PDF `att-` (or a
    /// structured `doc-` source) is not a page a vision model reads, so it is
    /// deliberately excluded here (see the node README's D2 scope note).
    pub fn image_attachment_shas(&self) -> Vec<String> {
        self.attachments
            .iter()
            .filter(|(_, meta)| meta.mime.starts_with("image/"))
            .map(|(sha, _)| sha.clone())
            .collect()
    }

    /// The capture time of an attachment: the `effective_at` of the `document`
    /// event whose `attachment` value addresses these bytes (the paper-record
    /// capture convention — see `docs/ARCHITECTURE.md`). OCR uses this as the
    /// draft `effective_at` fallback when the extracted fact carries no date of
    /// its own. `None` if no such event is indexed or it has no `effective_at`.
    pub fn attachment_capture_time(&self, sha256: &str) -> Option<String> {
        self.events
            .values()
            .find_map(|signed| match &signed.event.value {
                Some(EventValue::Attachment { sha256: s, .. }) if s == sha256 => {
                    signed.event.effective_at.clone()
                }
                _ => None,
            })
    }

    /// Source-document metadata by content hash.
    pub fn doc(&self, sha256: &str) -> Option<&DocMeta> {
        self.docs.get(sha256)
    }

    /// The concept key an event folds into — `{kind}|{system}|{code}` — or `None`
    /// if the event carries no code (uncoded events do not fold into a clinical
    /// concept).
    pub fn concept_key(event: &Event) -> Option<String> {
        let code = event.code.as_ref()?;
        Some(format!(
            "{}|{}|{}",
            kind_wire(&event.kind),
            code.system,
            code.code
        ))
    }

    /// The current/past status of a concept, honouring the owner's `status:`
    /// override and defaulting to [`Active`](ConceptStatus::Active).
    pub fn concept_status(&self, concept: &str) -> ConceptStatus {
        let Some(record) = self.curation.get(&format!("status:{concept}")) else {
            return ConceptStatus::Active;
        };
        match record.record.value.get("status").and_then(|v| v.as_str()) {
            Some("inactive") => ConceptStatus::Inactive,
            _ => ConceptStatus::Active,
        }
    }

    /// The owner's display-name override for a concept, if any. A cleared override
    /// is stored as an empty display (the sync model has no delete), which reads
    /// here as `None`.
    pub fn concept_display(&self, concept: &str) -> Option<String> {
        let record = self.curation.get(&format!("name:{concept}"))?;
        let display = record
            .record
            .value
            .get("display")
            .and_then(|v| v.as_str())?;
        if display.is_empty() {
            None
        } else {
            Some(display.to_string())
        }
    }
}

/// An event kind's stable `snake_case` wire name, via serde — `EventKind`'s own
/// `wire_name` is private to `core`, and serde yields the identical strings by
/// construction (guarded there by a `wire_names_match_serde` test).
fn kind_wire(kind: &EventKind) -> String {
    serde_json::to_value(kind)
        .ok()
        .and_then(|v| v.as_str().map(str::to_string))
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use svastha_core::event::{Code, Event, EventKind, EventValue, Provenance};
    use svastha_core::keys::Identity;

    fn owner() -> Identity {
        Identity::from_seed(b"vault owner seed")
    }

    fn med(owner: &Identity, rxnorm: &str, effective: &str) -> SignedEvent {
        owner.sign_event(Event::new(
            EventKind::MedicationStatement,
            Some(Code {
                system: "http://www.nlm.nih.gov/research/umls/rxnorm".into(),
                code: rxnorm.into(),
                display: None,
            }),
            Some(effective.into()),
            None,
            Provenance {
                source: "import".into(),
                source_doc: None,
            },
        ))
    }

    fn concept_of(signed: &SignedEvent) -> String {
        VaultIndex::concept_key(&signed.event).unwrap()
    }

    #[test]
    fn indexes_owner_signed_events_and_drops_tampered() {
        let owner = owner();
        let mut idx = VaultIndex::new(owner.verifying_key().to_bytes());

        let good = med(&owner, "197361", "2026-01-01T00:00:00Z");
        assert!(idx.ingest_event(good.clone()));

        // Tampered content: signature no longer verifies → dropped.
        let mut tampered = med(&owner, "197361", "2026-02-01T00:00:00Z");
        tampered.event.effective_at = Some("1999-01-01T00:00:00Z".into());
        assert!(!idx.ingest_event(tampered));

        assert_eq!(idx.event_count(), 1);
        assert_eq!(idx.dropped(), 1);
    }

    #[test]
    fn drops_event_signed_by_a_non_owner() {
        // A vault holds only its owner's events. One signed by someone else — a
        // relay-spliced foreign event — is dropped even though its own signature
        // is internally valid.
        let owner = owner();
        let intruder = Identity::from_seed(b"intruder seed");
        let mut idx = VaultIndex::new(owner.verifying_key().to_bytes());
        assert!(!idx.ingest_event(med(&intruder, "197361", "2026-01-01T00:00:00Z")));
        assert_eq!(idx.event_count(), 0);
        assert_eq!(idx.dropped(), 1);
    }

    #[test]
    fn status_override_makes_a_medication_past() {
        let owner = owner();
        let mut idx = VaultIndex::new(owner.verifying_key().to_bytes());
        let signed = med(&owner, "197361", "2025-01-01T00:00:00Z");
        let concept = concept_of(&signed);
        idx.ingest_event(signed);

        // No override yet → current.
        assert_eq!(idx.concept_status(&concept), ConceptStatus::Active);

        // Owner marks the concept inactive (a past medication).
        let rec = owner.sign_curation(
            format!("status:{concept}"),
            json!({ "status": "inactive" }),
            1_000,
        );
        assert_eq!(idx.ingest_curation(rec), CurationOutcome::Applied);
        assert_eq!(idx.concept_status(&concept), ConceptStatus::Inactive);
    }

    #[test]
    fn newer_status_wins_lww() {
        let owner = owner();
        let mut idx = VaultIndex::new(owner.verifying_key().to_bytes());
        let signed = med(&owner, "197361", "2025-01-01T00:00:00Z");
        let concept = concept_of(&signed);

        let inactive = owner.sign_curation(
            format!("status:{concept}"),
            json!({ "status": "inactive" }),
            100,
        );
        let active_again = owner.sign_curation(
            format!("status:{concept}"),
            json!({ "status": "active" }),
            200,
        );
        // Apply out of order: the higher updated_at must win regardless.
        idx.ingest_curation(active_again);
        idx.ingest_curation(inactive);
        assert_eq!(idx.concept_status(&concept), ConceptStatus::Active);
        assert_eq!(idx.curation_count(), 1);
    }

    #[test]
    fn name_override_is_applied() {
        let owner = owner();
        let mut idx = VaultIndex::new(owner.verifying_key().to_bytes());
        let signed = med(&owner, "197361", "2025-01-01T00:00:00Z");
        let concept = concept_of(&signed);

        let rec = owner.sign_curation(
            format!("name:{concept}"),
            json!({ "display": "Lisinopril 10mg" }),
            1,
        );
        assert_eq!(idx.ingest_curation(rec), CurationOutcome::Applied);
        assert_eq!(
            idx.concept_display(&concept).as_deref(),
            Some("Lisinopril 10mg")
        );

        // A cleared override (empty display) reads as no override.
        let cleared = owner.sign_curation(format!("name:{concept}"), json!({ "display": "" }), 2);
        idx.ingest_curation(cleared);
        assert_eq!(idx.concept_display(&concept), None);
    }

    #[test]
    fn tag_note_hide_namespaces_are_ignored() {
        // The grant delivers all curation (the relay cannot scope within cur-), but
        // the node honours status/name-only by convention.
        let owner = owner();
        let mut idx = VaultIndex::new(owner.verifying_key().to_bytes());
        for key in ["tag:ev-1", "note:ev-1", "hide:ev-1", "fav:vitals:abc"] {
            let rec = owner.sign_curation(key.to_string(), json!({ "x": true }), 1);
            assert_eq!(idx.ingest_curation(rec), CurationOutcome::IgnoredNamespace);
        }
        assert_eq!(idx.curation_count(), 0);
        // Ignoring is not dropping — these verified fine, they are just not ours.
        assert_eq!(idx.dropped(), 0);
    }

    #[test]
    fn curation_signed_by_a_non_owner_is_dropped() {
        let owner = owner();
        let intruder = Identity::from_seed(b"intruder seed");
        let mut idx = VaultIndex::new(owner.verifying_key().to_bytes());
        let rec = intruder.sign_curation(
            "status:medication_statement|s|c".into(),
            json!({ "status": "inactive" }),
            1,
        );
        assert_eq!(idx.ingest_curation(rec), CurationOutcome::Dropped);
        assert_eq!(idx.dropped(), 1);
    }

    #[test]
    fn provenance_ready_lookups() {
        let owner = owner();
        let mut idx = VaultIndex::new(owner.verifying_key().to_bytes());
        idx.put_attachment(
            "deadbeef".into(),
            AttachmentMeta {
                mime: "image/jpeg".into(),
                size: 1024,
            },
        );
        idx.put_doc(
            "cafe".into(),
            DocMeta {
                name: "CCD.xml".into(),
                size: 2048,
            },
        );
        assert_eq!(idx.attachment("deadbeef").unwrap().mime, "image/jpeg");
        assert_eq!(idx.doc("cafe").unwrap().name, "CCD.xml");
        assert!(idx.attachment("missing").is_none());
    }

    #[test]
    fn uncoded_events_have_no_concept() {
        let owner = owner();
        let uncoded = owner.sign_event(Event::new(
            EventKind::Document,
            None,
            Some("2026-01-01T00:00:00Z".into()),
            Some(EventValue::Text("a note".into())),
            Provenance {
                source: "self".into(),
                source_doc: None,
            },
        ));
        assert_eq!(VaultIndex::concept_key(&uncoded.event), None);
    }
}
