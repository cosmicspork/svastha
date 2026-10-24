//! The dosage a `medication_statement` carries, mapped from the synthetic
//! fixtures `fixtures/ccda/medications-dosage.xml` and
//! `fixtures/fhir/bundle-dosage.json` (one medication per rule; the C-CDA
//! fixture's comments and the code numbers below say which).

use svastha_core::event::{
    Code, DosageFields, Event, EventKind, EventValue, PeriodUnit, Provenance, Quantity, SignedEvent,
};
use svastha_core::keys::Identity;
use svastha_import::{import_ccda, import_fhir_bundle, EventDraft};

const CCDA_DOSAGE: &str = include_str!("../../../fixtures/ccda/medications-dosage.xml");
const FHIR_DOSAGE: &str = include_str!("../../../fixtures/fhir/bundle-dosage.json");
const CCDA_MINIMAL: &str = include_str!("../../../fixtures/ccda/minimal-ccd.xml");
const FHIR_MINIMAL: &str = include_str!("../../../fixtures/fhir/bundle-minimal.json");

const UCUM: &str = "http://unitsofmeasure.org";

fn ccda() -> Vec<EventDraft> {
    import_ccda(CCDA_DOSAGE).unwrap().events
}

fn fhir() -> Vec<EventDraft> {
    import_fhir_bundle(FHIR_DOSAGE).unwrap().events
}

fn med<'a>(events: &'a [EventDraft], code: &str) -> &'a EventDraft {
    events
        .iter()
        .find(|e| e.code.as_ref().is_some_and(|c| c.code == code))
        .unwrap_or_else(|| panic!("no medication {code}"))
}

fn dosage(events: &[EventDraft], code: &str) -> DosageFields {
    let m = med(events, code);
    assert_eq!(m.kind, EventKind::MedicationStatement);
    match &m.value {
        Some(EventValue::Dosage(d)) => d.fields().clone(),
        other => panic!("{code}: expected a dosage, got {other:?}"),
    }
}

fn schedule(frequency: &str, period: &str, unit: PeriodUnit) -> DosageFields {
    DosageFields {
        frequency: Some(frequency.into()),
        period: Some(period.into()),
        period_unit: Some(unit),
        ..Default::default()
    }
}

fn ucum(unit: &str) -> Option<Code> {
    Some(Code {
        system: UCUM.into(),
        code: unit.into(),
        display: None,
    })
}

// --- C-CDA ---

#[test]
fn ccda_every_medication_still_becomes_one_statement() {
    let result = import_ccda(CCDA_DOSAGE).unwrap();
    assert_eq!(result.events.len(), 18);
    assert!(result
        .events
        .iter()
        .all(|e| e.kind == EventKind::MedicationStatement));
}

#[test]
fn ccda_pivl_every_8_hours_with_its_dose() {
    assert_eq!(
        dosage(&ccda(), "900001"),
        DosageFields {
            dose: Some(Quantity {
                value: "500".into(),
                unit: ucum("mg"),
            }),
            ..schedule("1", "8", PeriodUnit::Hour)
        }
    );
}

#[test]
fn ccda_institution_specified_period_dividing_a_day_is_n_per_day() {
    assert_eq!(
        dosage(&ccda(), "900002"),
        schedule("2", "1", PeriodUnit::Day)
    );
    let bedtime = dosage(&ccda(), "900018");
    assert_eq!(
        bedtime,
        DosageFields {
            dose: Some(Quantity {
                value: "0.5".into(),
                unit: ucum("mg"),
            }),
            when: Some("HS".into()),
            ..schedule("1", "1", PeriodUnit::Day)
        }
    );
}

#[test]
fn ccda_institution_specified_period_not_dividing_a_day_stays_per_period() {
    assert_eq!(
        dosage(&ccda(), "900003"),
        schedule("1", "7", PeriodUnit::Hour)
    );
}

#[test]
fn ccda_eivl_event_is_the_when_and_literal_text_is_the_sig() {
    assert_eq!(
        dosage(&ccda(), "900004"),
        DosageFields {
            text: Some("Take with breakfast".into()),
            when: Some("AC".into()),
            ..Default::default()
        }
    );
}

#[test]
fn ccda_precondition_is_as_needed_and_a_unitless_dose_has_no_unit() {
    assert_eq!(
        dosage(&ccda(), "900005"),
        DosageFields {
            dose: Some(Quantity {
                value: "1".into(),
                unit: None,
            }),
            as_needed: Some(true),
            ..schedule("1", "4", PeriodUnit::Hour)
        }
    );
}

#[test]
fn ccda_free_text_sig_is_preferred_over_the_activity_text() {
    assert_eq!(
        dosage(&ccda(), "900006").text.as_deref(),
        Some("Take one tablet by mouth every morning")
    );
}

#[test]
fn ccda_unresolvable_free_text_sig_falls_back_to_the_activity_text() {
    assert_eq!(
        dosage(&ccda(), "900007").text.as_deref(),
        Some("Apply twice daily")
    );
}

#[test]
fn ccda_unresolvable_reference_with_nothing_else_keeps_the_old_quantity() {
    // Never the raw "#missing8" as a sig; with no sig left, the shape is
    // exactly what import wrote before dosages.
    assert_eq!(
        med(&ccda(), "900008").value,
        Some(EventValue::Quantity {
            value: "5".into(),
            unit: ucum("mg"),
        })
    );
}

#[test]
fn ccda_unitless_count_dose() {
    assert_eq!(
        dosage(&ccda(), "900009"),
        DosageFields {
            dose: Some(Quantity {
                value: "2".into(),
                unit: None,
            }),
            ..schedule("1", "1", PeriodUnit::Day)
        }
    );
}

#[test]
fn ccda_dose_range_is_dropped_and_the_schedule_kept() {
    assert_eq!(
        dosage(&ccda(), "900010"),
        schedule("1", "6", PeriodUnit::Hour)
    );
}

#[test]
fn ccda_unsupported_unit_drops_the_period_and_keeps_the_sig() {
    assert_eq!(
        dosage(&ccda(), "900011"),
        DosageFields {
            text: Some("Inhale one puff every 30 minutes as directed".into()),
            ..Default::default()
        }
    );
}

#[test]
fn ccda_only_an_unsupported_unit_keeps_the_old_text_shape() {
    assert_eq!(
        med(&ccda(), "900012").value,
        Some(EventValue::Text("Synthetic Med 12".into()))
    );
}

#[test]
fn ccda_everything_invalid_keeps_the_old_quantity_byte_for_byte() {
    // The old quantity value is not validated, so the unparseable dose rides
    // through as it always did; only the dosage refuses it.
    assert_eq!(
        med(&ccda(), "900013").value,
        Some(EventValue::Quantity {
            value: "1e2".into(),
            unit: ucum("mg"),
        })
    );
}

#[test]
fn ccda_whitespace_only_text_is_dropped() {
    assert_eq!(
        dosage(&ccda(), "900014"),
        schedule("1", "1", PeriodUnit::Day)
    );
}

#[test]
fn ccda_first_usable_pivl_slice_wins() {
    assert_eq!(
        dosage(&ccda(), "900015"),
        schedule("1", "12", PeriodUnit::Hour)
    );
}

#[test]
fn ccda_zero_period_is_dropped_and_the_sig_kept() {
    assert_eq!(
        dosage(&ccda(), "900016"),
        DosageFields {
            text: Some("Use as directed".into()),
            ..Default::default()
        }
    );
}

#[test]
fn ccda_uncoded_medication_never_gets_a_dosage() {
    let uncoded = ccda().into_iter().find(|e| e.code.is_none()).unwrap();
    assert_eq!(
        uncoded.value,
        Some(EventValue::Quantity {
            value: "1".into(),
            unit: ucum("{tbl}"),
        })
    );
}

// --- FHIR ---

#[test]
fn fhir_every_statement_still_becomes_one_event() {
    assert_eq!(fhir().len(), 16);
}

#[test]
fn fhir_text_only() {
    assert_eq!(
        dosage(&fhir(), "910001"),
        DosageFields {
            text: Some("Take one tablet by mouth daily".into()),
            ..Default::default()
        }
    );
}

#[test]
fn fhir_repeat_three_per_day_with_its_dose() {
    assert_eq!(
        dosage(&fhir(), "910002"),
        DosageFields {
            dose: Some(Quantity {
                value: "500".into(),
                unit: Some(Code {
                    system: UCUM.into(),
                    code: "mg".into(),
                    display: Some("mg".into()),
                }),
            }),
            ..schedule("3", "1", PeriodUnit::Day)
        }
    );
}

#[test]
fn fhir_timing_abbreviations() {
    let events = fhir();
    assert_eq!(
        dosage(&events, "910003"),
        schedule("2", "1", PeriodUnit::Day)
    );
    assert_eq!(
        dosage(&events, "910004"),
        schedule("1", "2", PeriodUnit::Day)
    );
    assert_eq!(
        dosage(&events, "910005"),
        schedule("1", "6", PeriodUnit::Hour)
    );
    assert_eq!(
        dosage(&events, "910006"),
        DosageFields {
            when: Some("HS".into()),
            ..schedule("1", "1", PeriodUnit::Day)
        }
    );
}

#[test]
fn fhir_timing_abbreviation_in_another_system_is_not_assumed() {
    assert_eq!(med(&fhir(), "910013").value, None);
}

#[test]
fn fhir_as_needed_reason_and_period_without_frequency() {
    assert_eq!(
        dosage(&fhir(), "910007"),
        DosageFields {
            as_needed: Some(true),
            ..schedule("1", "4", PeriodUnit::Hour)
        }
    );
}

#[test]
fn fhir_exponent_period_is_dropped_and_the_text_kept() {
    assert_eq!(
        dosage(&fhir(), "910008"),
        DosageFields {
            text: Some("Every ten hours".into()),
            ..Default::default()
        }
    );
}

#[test]
fn fhir_everything_invalid_is_the_old_bare_statement() {
    let events = fhir();
    let m = med(&events, "910009");
    assert_eq!(m.value, None);
    assert_eq!(m.effective_at.as_deref(), Some("2024-02-01"));
}

#[test]
fn fhir_unsupported_unit_drops_the_period_and_keeps_the_text() {
    assert_eq!(
        dosage(&fhir(), "910010"),
        DosageFields {
            text: Some("Inhale as directed".into()),
            ..Default::default()
        }
    );
    assert_eq!(med(&fhir(), "910015").value, None, "years alone: bare");
}

#[test]
fn fhir_repeat_when_is_its_first_code_verbatim() {
    assert_eq!(
        dosage(&fhir(), "910011"),
        DosageFields {
            when: Some("MORN".into()),
            ..schedule("1", "1", PeriodUnit::Day)
        }
    );
}

#[test]
fn fhir_only_the_first_dosage_is_read() {
    assert_eq!(dosage(&fhir(), "910012").text.as_deref(), Some("First sig"));
}

#[test]
fn fhir_frequency_without_period_and_signed_dose_are_dropped() {
    assert_eq!(
        dosage(&fhir(), "910014"),
        DosageFields {
            text: Some("Three times".into()),
            ..Default::default()
        }
    );
}

#[test]
fn fhir_scheduled_with_a_decimal_period_and_unitless_dose() {
    assert_eq!(
        dosage(&fhir(), "910016"),
        DosageFields {
            dose: Some(Quantity {
                value: "2".into(),
                unit: None,
            }),
            as_needed: Some(false),
            ..schedule("1", "0.5", PeriodUnit::Day)
        }
    );
}

// --- every import path, through core ---

fn all_fixture_events() -> Vec<EventDraft> {
    [CCDA_DOSAGE, CCDA_MINIMAL]
        .into_iter()
        .flat_map(|x| import_ccda(x).unwrap().events)
        .chain(
            [FHIR_DOSAGE, FHIR_MINIMAL]
                .into_iter()
                .flat_map(|j| import_fhir_bundle(j).unwrap().events),
        )
        .collect()
}

/// No import path can emit an event core refuses: every draft from every
/// fixture crosses the wasm boundary's JSON form, signs, and decodes back to
/// the same signed event with the same id.
#[test]
fn every_imported_event_signs_and_round_trips_through_core() {
    let id = Identity::from_seed(b"dosage import round trip");
    let prov = Provenance {
        source: "test".into(),
        source_doc: None,
    };
    let drafts = all_fixture_events();
    assert!(drafts
        .iter()
        .any(|d| matches!(d.value, Some(EventValue::Dosage(_)))));
    for d in drafts {
        // The web receives the draft as JSON and hands its value back to
        // core to sign; that decode is where an invalid dosage is refused.
        let value_json = serde_json::to_string(&d.value).unwrap();
        let value: Option<EventValue> = serde_json::from_str(&value_json)
            .unwrap_or_else(|e| panic!("core refused {value_json}: {e}"));
        let event = Event::new(
            d.kind.clone(),
            d.code.clone(),
            d.effective_at.clone(),
            value,
            prov.clone(),
        );
        let signed = id.sign_event(event);
        assert!(signed.verify());
        let wire = serde_json::to_string(&signed).unwrap();
        let back: SignedEvent = serde_json::from_str(&wire)
            .unwrap_or_else(|e| panic!("core refused its own signed event {wire}: {e}"));
        assert!(back.verify());
        assert_eq!(back.event.id, signed.event.id);
        assert_eq!(back.event.content_id(), signed.event.id);
    }
}

/// Medications that state no dosage import exactly as they did before
/// dosages existed: these are the ids the pre-dosage mapping produced.
#[test]
fn medications_without_a_dosage_keep_their_pre_dosage_ids() {
    let prov = Provenance {
        source: "test".into(),
        source_doc: None,
    };
    let id_of = |d: &EventDraft| {
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
    let ccda = import_ccda(CCDA_MINIMAL).unwrap().events;
    let fhir = import_fhir_bundle(FHIR_MINIMAL).unwrap().events;
    for (events, code, id) in [
        (
            &ccda,
            "314076",
            "cee26d48613283176d02eda976ac841d5ea30bcfdd24d467bd28960085bd8120",
        ),
        (
            &ccda,
            "312086",
            "50b419f3f503f9f705c33e238397c9d535e128d8dd5fa6f4ac390a95f0743756",
        ),
        (
            &ccda,
            "308191",
            "c06b7b5bd70c6cd5c1976ea98e1222f022b5989b46b430d4bcfa24bf9bf0cac6",
        ),
        (
            &fhir,
            "314076",
            "b3a7c84372ef297621bd038d5442fa89443576c0779860dc600c09c817f28e21",
        ),
    ] {
        assert_eq!(id_of(med(events, code)), id, "{code}");
    }
}
