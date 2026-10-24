//! Occupation, industry and occupational-hazard import, against the synthetic
//! `fixtures/ccda/occupation-ccd.xml` and `fixtures/fhir/occupation-bundle.json`
//! (see `fixtures/README.md`).

use svastha_core::event::{Code, Event, EventKind, EventValue, Provenance};
use svastha_import::{import_ccda, import_fhir_bundle, EventDraft, ImportResult};

const CCDA: &str = include_str!("../../../fixtures/ccda/occupation-ccd.xml");
const FHIR: &str = include_str!("../../../fixtures/fhir/occupation-bundle.json");

const LOINC: &str = "http://loinc.org";

fn with_code<'a>(r: &'a ImportResult, code: &str) -> Vec<&'a EventDraft> {
    r.events
        .iter()
        .filter(|e| {
            e.code
                .as_ref()
                .is_some_and(|c| c.system == LOINC && c.code == code)
        })
        .collect()
}

fn text(s: &str) -> Option<EventValue> {
    Some(EventValue::Text(s.into()))
}

fn coded(system: &str, code: &str, display: &str) -> Option<EventValue> {
    Some(EventValue::Coded(Code {
        system: system.into(),
        code: code.into(),
        display: Some(display.into()),
    }))
}

/// The events sharing one start date, as the web summary groups them.
fn group<'a>(r: &'a ImportResult, start: Option<&str>) -> Vec<(&'a str, Option<EventValue>)> {
    r.events
        .iter()
        .filter(|e| e.effective_at.as_deref() == start)
        .map(|e| (e.code.as_ref().unwrap().code.as_str(), e.value.clone()))
        .collect()
}

fn id_of(d: &EventDraft) -> String {
    Event::new(
        d.kind.clone(),
        d.code.clone(),
        d.effective_at.clone(),
        d.value.clone(),
        Provenance {
            source: "test".into(),
            source_doc: None,
        },
    )
    .id
    .to_hex()
}

// --- C-CDA ---

#[test]
fn ccda_imports_every_job_with_its_industry_and_hazards() {
    let r = import_ccda(CCDA).unwrap();
    assert!(r.events.iter().all(|e| e.kind == EventKind::Observation));
    assert_eq!(r.events.len(), 10, "{:?}", r.events);
    assert_eq!(with_code(&r, "11341-5").len(), 4);
    assert_eq!(with_code(&r, "86188-0").len(), 3);
    assert_eq!(with_code(&r, "87729-0").len(), 3);
}

#[test]
fn ccda_basic_occupation_is_coded_with_its_nested_industry_on_the_same_date() {
    let r = import_ccda(CCDA).unwrap();
    assert_eq!(
        group(&r, Some("2019-03-04")),
        vec![
            (
                "11341-5",
                coded(
                    "urn:oid:2.16.840.1.113883.6.243",
                    "29-1141.00",
                    "Registered Nurses"
                )
            ),
            (
                "86188-0",
                coded(
                    "urn:oid:2.16.840.1.113883.6.85",
                    "622110",
                    "General Medical and Surgical Hospitals"
                )
            ),
        ]
    );
}

#[test]
fn ccda_uncoded_job_takes_its_original_text_and_a_sibling_industry_attaches_by_start_date() {
    let r = import_ccda(CCDA).unwrap();
    assert_eq!(
        group(&r, Some("2022-08-15")),
        vec![
            ("11341-5", text("Phlebotomist")),
            ("86188-0", text("Outpatient care centers")),
        ]
    );
}

#[test]
fn ccda_older_odh_job_carries_industry_and_trimmed_hazards() {
    let r = import_ccda(CCDA).unwrap();
    assert_eq!(
        group(&r, Some("2010-01-01")),
        vec![
            ("11341-5", text("Welder")),
            ("86188-0", text("Shipbuilding")),
            ("87729-0", text("Welding fumes")),
            ("87729-0", text("Noise")),
        ]
    );
}

#[test]
fn ccda_undated_job_keeps_no_date_and_warns_that_its_hazards_cannot_attach() {
    let r = import_ccda(CCDA).unwrap();
    assert_eq!(
        group(&r, None),
        vec![
            ("11341-5", text("Volunteer firefighter")),
            ("87729-0", text("Smoke")),
        ]
    );
    assert!(r
        .warnings
        .iter()
        .any(|w| w.contains("without a start date")));
}

#[test]
fn ccda_skips_what_it_cannot_use_and_reports_it() {
    let r = import_ccda(CCDA).unwrap();
    let skipped = |needle: &str| {
        r.skipped
            .iter()
            .any(|s| s.what.contains(needle) || s.why.contains(needle))
    };
    assert!(skipped("no usable value"), "empty job: {:?}", r.skipped);
    assert!(
        skipped("hazard has no text"),
        "blank hazard: {:?}",
        r.skipped
    );
    assert!(skipped("74165-2"), "employment status: {:?}", r.skipped);
    assert!(skipped("21843-8"), "usual work: {:?}", r.skipped);
    assert!(skipped("72166-2"), "tobacco: {:?}", r.skipped);
    assert!(
        !r.events
            .iter()
            .any(|e| e.value == text("") || e.value == text("   ")),
        "blank text must never become an event"
    );
}

#[test]
fn ccda_is_matched_by_code_not_template_id() {
    let xml = CCDA.replace("2.16.840.1.113883.10.20.22.4.503", "9.9.9.9");
    let a = import_ccda(&xml).unwrap();
    let b = import_ccda(CCDA).unwrap();
    assert_eq!(a.events, b.events);
}

#[test]
fn ccda_sibling_industry_with_no_matching_job_is_skipped_not_guessed() {
    let xml = CCDA.replace(
        r#"<code code="86188-0" codeSystem="2.16.840.1.113883.6.1"/>
              <effectiveTime><low value="20220815"/></effectiveTime>"#,
        r#"<code code="86188-0" codeSystem="2.16.840.1.113883.6.1"/>
              <effectiveTime><low value="19990101"/></effectiveTime>"#,
    );
    assert_ne!(xml, CCDA, "fixture edit must apply");
    let r = import_ccda(&xml).unwrap();
    assert_eq!(
        group(&r, Some("2022-08-15")),
        vec![("11341-5", text("Phlebotomist"))]
    );
    assert!(r
        .skipped
        .iter()
        .any(|s| s.why.contains("cannot tell which occupation")));
}

#[test]
fn ccda_undated_sibling_industry_with_two_jobs_is_skipped_not_guessed() {
    let xml = CCDA.replace(
        r#"<effectiveTime><low value="20220815"/></effectiveTime>
              <value xsi:type="ST">Outpatient"#,
        r#"<value xsi:type="ST">Outpatient"#,
    );
    assert_ne!(xml, CCDA, "fixture edit must apply");
    let r = import_ccda(&xml).unwrap();
    assert_eq!(
        with_code(&r, "86188-0").len(),
        2,
        "only the two nested industries"
    );
    assert!(r
        .skipped
        .iter()
        .any(|s| s.why.contains("cannot tell which occupation")));
}

#[test]
fn ccda_two_jobs_with_one_start_date_are_reported() {
    let xml = CCDA.replace(r#"<low value="20220815"/>"#, r#"<low value="20190304"/>"#);
    let r = import_ccda(&xml).unwrap();
    assert!(
        r.warnings
            .iter()
            .any(|w| w.contains("2019-03-04") && w.contains("cannot be told apart")),
        "{:?}",
        r.warnings
    );
    // Reported, not repaired: the signed history keeps the source's dates.
    assert_eq!(
        r.events
            .iter()
            .filter(|e| e.effective_at.as_deref() == Some("2019-03-04")
                && e.code.as_ref().unwrap().code == "11341-5")
            .count(),
        2
    );
}

// --- FHIR ---

#[test]
fn fhir_imports_every_job_with_its_industry_and_hazards() {
    let r = import_fhir_bundle(FHIR).unwrap();
    assert!(r.events.iter().all(|e| e.kind == EventKind::Observation));
    assert_eq!(r.events.len(), 8, "{:?}", r.events);
    assert_eq!(
        with_code(&r, "11341-5").len(),
        3,
        "the dataAbsentReason job is skipped"
    );
}

#[test]
fn fhir_us_core_occupation_is_coded_with_its_industry_component() {
    let r = import_fhir_bundle(FHIR).unwrap();
    assert_eq!(
        group(&r, Some("2019-03-04")),
        vec![
            (
                "11341-5",
                coded(
                    "urn:oid:2.16.840.1.113883.6.243",
                    "29-1141.00",
                    "Registered Nurses"
                )
            ),
            (
                "86188-0",
                coded(
                    "urn:oid:2.16.840.1.113883.6.85",
                    "622110",
                    "General Medical and Surgical Hospitals"
                )
            ),
        ]
    );
}

#[test]
fn fhir_odh_job_takes_text_and_hazard_components_and_drops_blank_ones() {
    let r = import_fhir_bundle(FHIR).unwrap();
    assert_eq!(
        group(&r, Some("2010-01-01")),
        vec![
            ("11341-5", text("Welder")),
            ("86188-0", text("Shipbuilding")),
            ("87729-0", text("Welding fumes")),
            ("87729-0", text("Noise")),
        ]
    );
    assert!(r
        .skipped
        .iter()
        .any(|s| s.why.contains("hazard has no text")));
    assert!(r.skipped.iter().any(|s| s.why.contains("not mapped")));
}

#[test]
fn fhir_undated_job_warns_and_data_absent_job_is_skipped() {
    let r = import_fhir_bundle(FHIR).unwrap();
    assert_eq!(
        group(&r, None),
        vec![
            ("11341-5", text("Volunteer firefighter")),
            ("87729-0", text("Smoke")),
        ]
    );
    assert!(r
        .warnings
        .iter()
        .any(|w| w.contains("without a start date")));
    assert!(r
        .skipped
        .iter()
        .any(|s| s.what.contains("absent-job") && s.why.contains("dataAbsentReason")));
}

#[test]
fn fhir_components_are_not_also_imported_by_the_generic_observation_path() {
    let r = import_fhir_bundle(FHIR).unwrap();
    // The generic path would emit a component under the job's own code.
    assert!(r
        .events
        .iter()
        .filter(|e| e.code.as_ref().unwrap().code == "11341-5")
        .all(|e| !matches!(e.value, Some(EventValue::Text(ref t)) if t == "Shipbuilding" || t == "Smoke")));
}

#[test]
fn fhir_two_jobs_with_one_start_date_are_reported() {
    let json = FHIR.replace("2010-01-01", "2019-03-04");
    let r = import_fhir_bundle(&json).unwrap();
    assert!(
        r.warnings
            .iter()
            .any(|w| w.contains("cannot be told apart")),
        "{:?}",
        r.warnings
    );
}

// --- both formats ---

/// The employer is the one thing in an ODH record that identifies a place of
/// work. Both fixtures carry employer names and addresses in the places the
/// profiles put them; none may reach any output.
#[test]
fn employer_names_and_addresses_appear_in_no_output() {
    for r in [
        import_ccda(CCDA).unwrap(),
        import_fhir_bundle(FHIR).unwrap(),
    ] {
        let all = format!(
            "{} {:?} {:?}",
            serde_json::to_string(&r.events).unwrap(),
            r.warnings,
            r.skipped
        );
        for secret in [
            "Example Memorial Hospital",
            "100 Fictional Way",
            "Exampleville",
            "Acme Shipyards",
            "Placeholder Road",
        ] {
            assert!(!all.contains(secret), "{secret} leaked: {all}");
        }
    }
    // The fixtures really do carry them, or the assertion above proves nothing.
    assert!(CCDA.contains("Acme Shipyards") && CCDA.contains("Example Memorial Hospital"));
    assert!(FHIR.contains("Acme Shipyards"));
}

#[test]
fn the_same_job_from_ccda_and_fhir_collapses_to_one_event_id() {
    let c = import_ccda(CCDA).unwrap();
    let f = import_fhir_bundle(FHIR).unwrap();
    let ids = |r: &ImportResult, start: &str| -> Vec<String> {
        r.events
            .iter()
            .filter(|e| e.effective_at.as_deref() == Some(start))
            .map(id_of)
            .collect()
    };
    // Same code, display and date in both fixtures: content-addressing dedups
    // the pair (nurse + hospital industry) on a second import from either.
    let nurse = ids(&c, "2019-03-04");
    assert_eq!(nurse.len(), 2);
    assert_eq!(nurse, ids(&f, "2019-03-04"));
    let welder = ids(&c, "2010-01-01");
    assert_eq!(welder, ids(&f, "2010-01-01"));
}

#[test]
fn imports_are_deterministic() {
    assert_eq!(
        import_ccda(CCDA).unwrap().events,
        import_ccda(CCDA).unwrap().events
    );
    assert_eq!(
        import_fhir_bundle(FHIR).unwrap().events,
        import_fhir_bundle(FHIR).unwrap().events
    );
}

#[test]
fn existing_fixtures_gain_no_work_events() {
    let c = import_ccda(include_str!("../../../fixtures/ccda/minimal-ccd.xml")).unwrap();
    let f = import_fhir_bundle(include_str!("../../../fixtures/fhir/bundle-minimal.json")).unwrap();
    assert_eq!(c.events.len(), 16);
    assert_eq!(f.events.len(), 9);
    for r in [c, f] {
        for code in ["11341-5", "86188-0", "87729-0"] {
            assert!(with_code(&r, code).is_empty());
        }
    }
}
