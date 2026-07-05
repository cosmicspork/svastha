//! Fixture-driven tests against `fixtures/ccda/minimal-ccd.xml` (see
//! `fixtures/README.md`). Assert exact shape, not just "it didn't crash" —
//! a section silently gaining or losing an event is exactly the failure mode
//! this fixture exists to catch.

use svastha_core::event::{Code, Event, EventKind, EventValue, Provenance};
use svastha_import::import_ccda;

const FIXTURE: &str = include_str!("../../../fixtures/ccda/minimal-ccd.xml");

fn events() -> Vec<svastha_import::EventDraft> {
    import_ccda(FIXTURE).unwrap().events
}

#[test]
fn maps_every_section_to_its_expected_event_count() {
    let result = import_ccda(FIXTURE).unwrap();

    let count = |kind: EventKind| result.events.iter().filter(|e| e.kind == kind).count();
    assert_eq!(count(EventKind::AllergyIntolerance), 1);
    assert_eq!(
        count(EventKind::Condition),
        1,
        "only the nullFlavor'd problem should be dropped"
    );
    assert_eq!(count(EventKind::MedicationStatement), 1);
    assert_eq!(
        count(EventKind::Immunization),
        1,
        "the negated shot must not become an event"
    );
    assert_eq!(
        count(EventKind::Observation),
        4,
        "2 results + 2 vitals (BP pair)"
    );
    assert_eq!(count(EventKind::Procedure), 1);
    assert_eq!(count(EventKind::Encounter), 1);
    assert_eq!(result.events.len(), 10);
}

#[test]
fn allergy_substance_falls_back_to_translation() {
    // The playingEntity's root <code> is nullFlavor="OTH"; only the
    // <translation> carries a real SNOMED code.
    let allergy = events()
        .into_iter()
        .find(|e| e.kind == EventKind::AllergyIntolerance)
        .unwrap();
    assert_eq!(
        allergy.code,
        Some(Code {
            system: "http://snomed.info/sct".into(),
            code: "256349002".into(),
            display: Some("Peanut".into())
        })
    );
    assert_eq!(allergy.effective_at.as_deref(), Some("2010-06-04"));
}

#[test]
fn medication_dose_becomes_a_quantity_with_ucum_unit() {
    let med = events()
        .into_iter()
        .find(|e| e.kind == EventKind::MedicationStatement)
        .unwrap();
    assert_eq!(
        med.value,
        Some(EventValue::Quantity {
            value: "10".into(),
            unit: Some(Code {
                system: "http://unitsofmeasure.org".into(),
                code: "mg".into(),
                display: None
            })
        })
    );
}

#[test]
fn ivl_pq_result_collapses_to_low_with_a_warning() {
    let result = import_ccda(FIXTURE).unwrap();
    let a1c = result
        .events
        .iter()
        .find(|e| e.code.as_ref().is_some_and(|c| c.code == "4548-4"))
        .unwrap();
    assert_eq!(
        a1c.value,
        Some(EventValue::Quantity {
            value: "5.4".into(),
            unit: Some(Code {
                system: "http://unitsofmeasure.org".into(),
                code: "%".into(),
                display: None
            })
        })
    );
    assert!(
        result
            .warnings
            .iter()
            .any(|w| w.contains("IVL_PQ") && w.contains("collapsed")),
        "warnings: {:?}",
        result.warnings
    );
}

#[test]
fn negated_immunization_is_skipped_with_a_warning_not_an_event() {
    let result = import_ccda(FIXTURE).unwrap();
    assert_eq!(
        result
            .events
            .iter()
            .filter(|e| e.kind == EventKind::Immunization)
            .count(),
        1
    );
    assert!(
        result.warnings.iter().any(|w| w.contains("negated")),
        "warnings: {:?}",
        result.warnings
    );
}

#[test]
fn unmappable_nullflavor_problem_is_skipped_not_silently_dropped() {
    let result = import_ccda(FIXTURE).unwrap();
    assert!(
        result
            .skipped
            .iter()
            .any(|s| s.what == "problem entry" && s.why.contains("nullFlavor")),
        "skipped: {:?}",
        result.skipped
    );
}

#[test]
fn unmapped_section_is_recorded_as_skipped() {
    let result = import_ccda(FIXTURE).unwrap();
    assert!(
        result
            .skipped
            .iter()
            .any(|s| s.what.contains("29762-2") && s.why.contains("not mapped")),
        "skipped: {:?}",
        result.skipped
    );
}

#[test]
fn encounter_interval_uses_the_low_bound() {
    let enc = events()
        .into_iter()
        .find(|e| e.kind == EventKind::Encounter)
        .unwrap();
    assert_eq!(
        enc.effective_at.as_deref(),
        Some("2024-01-03T09:00:00-05:00")
    );
}

#[test]
fn unknown_oid_is_kept_as_urn_oid_not_dropped() {
    // The encounter's code uses codeSystem 2.16.840.1.113883.6.12 (CPT), which
    // this mapper doesn't have a URI for.
    let enc = events()
        .into_iter()
        .find(|e| e.kind == EventKind::Encounter)
        .unwrap();
    assert_eq!(enc.code.unwrap().system, "urn:oid:2.16.840.1.113883.6.12");
}

#[test]
fn importing_twice_is_deterministic() {
    // Re-import (e.g. the user re-drops the same document) must produce byte-
    // identical drafts, or content ids would drift and dedup would break.
    assert_eq!(events(), events());
}

/// Pinned content ids: if a date/value normalization rule ever changes,
/// exactly the affected ids move, and this test fails loudly instead of the
/// drift going unnoticed. Recomputed from `events()[i]` via `Event::new` with
/// a fixed dummy provenance (ids are provenance-independent).
#[test]
fn pinned_content_ids() {
    let drafts = events();
    let prov = Provenance {
        source: "test".into(),
        source_doc: None,
    };
    let id_of = |d: &svastha_import::EventDraft| {
        Event::new(
            d.kind.clone(),
            d.code.clone(),
            d.effective_at.clone(),
            d.value.clone(),
            prov.clone(),
        )
        .id
        .to_hex()
    };

    assert_eq!(
        id_of(&drafts[0]), // allergy
        "49e8b7a59748c326596cafcc81ff9b93af6100f32ddde9421f31186721117e02"
    );
    assert_eq!(
        id_of(&drafts[1]), // condition
        "9fbecf97fd372774e5f2174cebf750d7f66609aa46cc990b643b2f9cce8652c4"
    );
    assert_eq!(
        id_of(&drafts[3]), // immunization
        "0346caea336f203649dd9c9976371ebea71be8493a9ba285bc56789761179623"
    );
}
