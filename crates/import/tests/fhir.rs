//! Fixture-driven tests against `fixtures/fhir/bundle-minimal.json` (see
//! `fixtures/README.md`).

use svastha_core::event::{Code, Event, EventKind, EventValue, Provenance};
use svastha_import::import_fhir_bundle;

const FIXTURE: &str = include_str!("../../../fixtures/fhir/bundle-minimal.json");

fn events() -> Vec<svastha_import::EventDraft> {
    import_fhir_bundle(FIXTURE).unwrap().events
}

#[test]
fn maps_every_resource_type_to_its_expected_event_count() {
    let result = import_fhir_bundle(FIXTURE).unwrap();

    let count = |kind: EventKind| result.events.iter().filter(|e| e.kind == kind).count();
    assert_eq!(
        count(EventKind::Observation),
        3,
        "temperature + BP pair (2 components)"
    );
    assert_eq!(count(EventKind::Condition), 1);
    assert_eq!(count(EventKind::AllergyIntolerance), 1);
    assert_eq!(
        count(EventKind::Immunization),
        1,
        "the not-done immunization must not become an event"
    );
    assert_eq!(count(EventKind::MedicationStatement), 1);
    assert_eq!(count(EventKind::Encounter), 1);
    assert_eq!(count(EventKind::Procedure), 1);
    assert_eq!(result.events.len(), 9);
}

#[test]
fn valuequantity_decimal_is_preserved_exactly() {
    // 98.60, not 98.6 and not a float artifact — the whole point of parsing
    // FHIR JSON with serde_json's arbitrary_precision feature.
    let temp = events()
        .into_iter()
        .find(|e| e.code.as_ref().is_some_and(|c| c.code == "8310-5"))
        .unwrap();
    assert_eq!(
        temp.value,
        Some(EventValue::Quantity {
            value: "98.60".into(),
            unit: Some(Code {
                system: "http://unitsofmeasure.org".into(),
                code: "[degF]".into(),
                display: Some("degF".into())
            })
        })
    );
}

#[test]
fn allergy_intolerance_code_becomes_the_coded_value_not_the_event_code() {
    let allergy = events()
        .into_iter()
        .find(|e| e.kind == EventKind::AllergyIntolerance)
        .unwrap();
    assert_eq!(allergy.code, None);
    assert_eq!(
        allergy.value,
        Some(EventValue::Coded(Code {
            system: "http://snomed.info/sct".into(),
            code: "256349002".into(),
            display: Some("Peanut".into())
        }))
    );
}

#[test]
fn not_done_immunization_is_skipped_with_a_warning_not_an_event() {
    let result = import_fhir_bundle(FIXTURE).unwrap();
    assert_eq!(
        result
            .events
            .iter()
            .filter(|e| e.kind == EventKind::Immunization)
            .count(),
        1
    );
    assert!(
        result.warnings.iter().any(|w| w.contains("not-done")),
        "warnings: {:?}",
        result.warnings
    );
}

#[test]
fn unmapped_resource_types_are_recorded_as_skipped() {
    let result = import_fhir_bundle(FIXTURE).unwrap();
    assert!(
        result
            .skipped
            .iter()
            .any(|s| s.what.starts_with("Patient/")),
        "skipped: {:?}",
        result.skipped
    );
    assert!(
        result
            .skipped
            .iter()
            .any(|s| s.what.starts_with("Appointment/")),
        "skipped: {:?}",
        result.skipped
    );
    assert_eq!(result.skipped.len(), 2);
}

#[test]
fn bp_panel_components_each_become_their_own_observation() {
    let drafts = events();
    let systolic = drafts
        .iter()
        .find(|e| e.code.as_ref().is_some_and(|c| c.code == "8480-6"))
        .unwrap();
    let diastolic = drafts
        .iter()
        .find(|e| e.code.as_ref().is_some_and(|c| c.code == "8462-4"))
        .unwrap();
    assert_eq!(
        systolic.value,
        Some(EventValue::Quantity {
            value: "122".into(),
            unit: systolic_unit()
        })
    );
    assert_eq!(
        diastolic.value,
        Some(EventValue::Quantity {
            value: "78".into(),
            unit: systolic_unit()
        })
    );

    fn systolic_unit() -> Option<Code> {
        Some(Code {
            system: "http://unitsofmeasure.org".into(),
            code: "mm[Hg]".into(),
            display: Some("mmHg".into()),
        })
    }
}

#[test]
fn rejects_a_non_bundle_resource() {
    let err = import_fhir_bundle(r#"{"resourceType": "Patient"}"#).unwrap_err();
    assert!(matches!(err, svastha_import::ImportError::NotABundle));
}

#[test]
fn importing_twice_is_deterministic() {
    assert_eq!(events(), events());
}

/// Pinned content ids — see `tests/ccda.rs`'s doc comment on the same pattern.
/// The Condition, Immunization, and Procedure ids here are deliberately
/// identical to their C-CDA fixture counterparts (same code/date), which is
/// exactly the cross-format dedup the content-id scheme exists for.
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
        id_of(&drafts[1]), // condition
        "9fbecf97fd372774e5f2174cebf750d7f66609aa46cc990b643b2f9cce8652c4"
    );
    assert_eq!(
        id_of(&drafts[3]), // immunization
        "0346caea336f203649dd9c9976371ebea71be8493a9ba285bc56789761179623"
    );
    assert_eq!(
        id_of(&drafts[6]), // procedure
        "74a68ce0ccd03141af0e4742e09b6928c45fee9b63708948b26872bb40fc66d7"
    );
}
