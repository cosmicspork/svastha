//! FHIR R4 `Bundle` mapping: walk `Bundle.entry[].resource` and dispatch on
//! `resourceType`.
//!
//! JSON numbers are parsed with `serde_json`'s `arbitrary_precision` feature
//! (see `Cargo.toml`), which keeps a number's original literal text instead of
//! round-tripping it through `f64`. That matters here specifically for
//! `valueQuantity.value`: `98.60` must stay `"98.60"`, not become `"98.6"` or
//! `98.59999999999999`, or re-importing the same document would mint a
//! different event id (see `crates/core/src/event.rs`'s content-id doc
//! comment on why quantities are decimal strings in the first place).

use serde_json::Value;

use svastha_core::event::{Code, Dosage, EventKind, EventValue, PeriodUnit, Quantity};

use crate::dosage;
use crate::systems::{LOINC, SNOMED, UCUM};
use crate::work::{self, Job};
use crate::{EventDraft, ImportError, ImportResult, Skipped};

pub fn import(json: &str) -> Result<ImportResult, ImportError> {
    let bundle: Value = serde_json::from_str(json)?;
    if bundle.get("resourceType").and_then(Value::as_str) != Some("Bundle") {
        return Err(ImportError::NotABundle);
    }

    let mut result = ImportResult::default();
    let mut jobs: Vec<Job> = Vec::new();
    for entry in bundle
        .get("entry")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        if let Some(resource) = entry.get("resource") {
            import_resource(resource, &mut result, &mut jobs);
        }
    }
    work::flush(jobs, &mut result);
    Ok(result)
}

fn import_resource(resource: &Value, result: &mut ImportResult, jobs: &mut Vec<Job>) {
    let resource_type = resource
        .get("resourceType")
        .and_then(Value::as_str)
        .unwrap_or("");
    let id = resource.get("id").and_then(Value::as_str).unwrap_or("?");

    match resource_type {
        "Observation" => import_observation(resource, result, jobs),
        "Condition" => import_condition(resource, result),
        "AllergyIntolerance" => import_allergy(resource, result),
        "Immunization" => import_immunization(resource, result),
        "MedicationStatement" => import_medication_statement(resource, result),
        "Encounter" => import_encounter(resource, result),
        "Procedure" => import_procedure(resource, result),
        "" => result.skipped.push(Skipped {
            what: "entry with no resourceType".into(),
            why: "cannot classify".into(),
        }),
        other => result.skipped.push(Skipped {
            what: format!("{other}/{id}"),
            why: "resource type not mapped (v1)".into(),
        }),
    }
}

// --- Observation ---

fn import_observation(res: &Value, result: &mut ImportResult, jobs: &mut Vec<Job>) {
    let id = res.get("id").and_then(Value::as_str).unwrap_or("?");
    // A job is routed here and only here: falling through to the generic panel
    // path below would import its components a second time.
    if has_loinc(res.get("code"), work::OCCUPATION) {
        import_job(res, id, result, jobs);
        return;
    }
    let code = res.get("code").and_then(best_coding);
    let effective_at = effective_datetime(res);

    // A panel (e.g. blood pressure) carries its readings as `component`, one
    // draft per component, each keeping the panel's own code as a fallback if
    // a component omits its own.
    if let Some(components) = res.get("component").and_then(Value::as_array) {
        for (i, comp) in components.iter().enumerate() {
            let comp_code = comp
                .get("code")
                .and_then(best_coding)
                .or_else(|| code.clone());
            match observation_value(comp) {
                Some(value) => result.events.push(EventDraft {
                    kind: EventKind::Observation,
                    code: comp_code,
                    effective_at: effective_at.clone(),
                    value: Some(value),
                }),
                None => result.skipped.push(Skipped {
                    what: format!("Observation/{id} component {i}"),
                    why: "no supported value[x]".into(),
                }),
            }
        }
        return;
    }

    match observation_value(res) {
        Some(value) => result.events.push(EventDraft {
            kind: EventKind::Observation,
            code,
            effective_at,
            value: Some(value),
        }),
        None => result.skipped.push(Skipped {
            what: format!("Observation/{id}"),
            why: "no supported value[x]".into(),
        }),
    }
}

fn observation_value(res: &Value) -> Option<EventValue> {
    if let Some(q) = res.get("valueQuantity") {
        let value = quantity_value_str(q)?;
        return Some(EventValue::Quantity {
            value,
            unit: quantity_unit(q),
        });
    }
    if let Some(cc) = res.get("valueCodeableConcept") {
        return best_coding(cc).map(EventValue::Coded);
    }
    if let Some(s) = res.get("valueString").and_then(Value::as_str) {
        return Some(EventValue::Text(s.to_string()));
    }
    None
}

// --- occupation (US Core Occupation / ODH PastOrPresentJob) ---
//
// Only `value[x]`, `effective[x]` and the industry/hazard components are read.
// The employer lives in `extension`s and is never looked at (see `work.rs`).

fn has_loinc(cc: Option<&Value>, wanted: &str) -> bool {
    cc.and_then(|cc| cc.get("coding"))
        .and_then(Value::as_array)
        .is_some_and(|codings| {
            codings.iter().any(|c| {
                c.get("system").and_then(Value::as_str) == Some(LOINC)
                    && c.get("code").and_then(Value::as_str) == Some(wanted)
            })
        })
}

fn clean(s: &str) -> Option<String> {
    let s = s.split_whitespace().collect::<Vec<_>>().join(" ");
    (!s.is_empty()).then_some(s)
}

/// Coded when the source codes it, else the text it wrote.
fn work_value(v: &Value) -> Option<EventValue> {
    if let Some(cc) = v.get("valueCodeableConcept") {
        if let Some(code) = best_coding(cc) {
            return Some(EventValue::Coded(code));
        }
        let text = cc.get("text").and_then(Value::as_str).and_then(clean);
        if let Some(text) = text {
            return Some(EventValue::Text(text));
        }
    }
    v.get("valueString")
        .and_then(Value::as_str)
        .and_then(clean)
        .map(EventValue::Text)
}

fn hazard_text(v: &Value) -> Option<String> {
    match work_value(v)? {
        EventValue::Text(t) => Some(t),
        EventValue::Coded(c) => c.display.as_deref().and_then(clean),
        _ => None,
    }
}

fn import_job(res: &Value, id: &str, result: &mut ImportResult, jobs: &mut Vec<Job>) {
    let what = format!("Observation/{id}");
    if res.get("dataAbsentReason").is_some() {
        result.skipped.push(Skipped {
            what,
            why: "occupation has dataAbsentReason".into(),
        });
        return;
    }
    let Some(value) = work_value(res) else {
        result.skipped.push(Skipped {
            what,
            why: "occupation has no usable value[x]".into(),
        });
        return;
    };
    let mut job = Job {
        value,
        start: effective_datetime(res),
        industry: None,
        hazards: Vec::new(),
    };
    for (i, comp) in res
        .get("component")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .enumerate()
    {
        let what = format!("Observation/{id} component {i}");
        if has_loinc(comp.get("code"), work::INDUSTRY) {
            match (work_value(comp), &job.industry) {
                (Some(v), None) => job.industry = Some(v),
                _ => result.skipped.push(Skipped {
                    what,
                    why: "industry has no usable value or is a second industry".into(),
                }),
            }
        } else if has_loinc(comp.get("code"), work::HAZARD) {
            match hazard_text(comp) {
                Some(t) => job.hazards.push(t),
                None => result.skipped.push(Skipped {
                    what,
                    why: "occupational hazard has no text".into(),
                }),
            }
        } else {
            result.skipped.push(Skipped {
                what,
                why: "occupational data component not mapped (v1)".into(),
            });
        }
    }
    jobs.push(job);
}

// --- Condition ---

fn import_condition(res: &Value, result: &mut ImportResult) {
    let id = res.get("id").and_then(Value::as_str).unwrap_or("?");
    let Some(code) = res.get("code").and_then(best_coding) else {
        result.skipped.push(Skipped {
            what: format!("Condition/{id}"),
            why: "no code".into(),
        });
        return;
    };
    let effective_at = effective_datetime(res);
    result.events.push(EventDraft {
        kind: EventKind::Condition,
        code: Some(code),
        effective_at,
        value: None,
    });
}

// --- AllergyIntolerance ---
//
// Unlike the other resources, the substance code is the event's *value*
// (`Coded`), not its `code`: an AllergyIntolerance's own `code` field IS the
// substance, so there's no separate "kind of fact" code to put there — the
// coded value fully describes the fact ("allergic to X").
fn import_allergy(res: &Value, result: &mut ImportResult) {
    let id = res.get("id").and_then(Value::as_str).unwrap_or("?");
    let Some(code) = res.get("code").and_then(best_coding) else {
        result.skipped.push(Skipped {
            what: format!("AllergyIntolerance/{id}"),
            why: "no code".into(),
        });
        return;
    };
    let effective_at = effective_datetime(res);
    result.events.push(EventDraft {
        kind: EventKind::AllergyIntolerance,
        code: None,
        effective_at,
        value: Some(EventValue::Coded(code)),
    });
}

// --- Immunization ---

fn import_immunization(res: &Value, result: &mut ImportResult) {
    let id = res.get("id").and_then(Value::as_str).unwrap_or("?");
    if res.get("status").and_then(Value::as_str) == Some("not-done") {
        result
            .warnings
            .push(format!("Immunization/{id}: status not-done, skipping"));
        return;
    }
    let Some(code) = res.get("vaccineCode").and_then(best_coding) else {
        result.skipped.push(Skipped {
            what: format!("Immunization/{id}"),
            why: "no vaccineCode".into(),
        });
        return;
    };
    let effective_at = effective_datetime(res);
    result.events.push(EventDraft {
        kind: EventKind::Immunization,
        code: Some(code),
        effective_at,
        value: None,
    });
}

// --- MedicationStatement ---

fn import_medication_statement(res: &Value, result: &mut ImportResult) {
    let id = res.get("id").and_then(Value::as_str).unwrap_or("?");
    let Some(code) = res.get("medicationCodeableConcept").and_then(best_coding) else {
        result.skipped.push(Skipped {
            what: format!("MedicationStatement/{id}"),
            why: "no medicationCodeableConcept (medicationReference not supported)".into(),
        });
        return;
    };
    let effective_at = effective_datetime(res);
    result.events.push(EventDraft {
        kind: EventKind::MedicationStatement,
        code: Some(code),
        effective_at,
        value: medication_dosage(res).map(EventValue::Dosage),
    });
}

/// `dosage[0]` as a core dosage. Further `dosage` entries (a split or tapering
/// schedule) are ignored for now: core's dosage is one sig.
///
/// | FHIR | Dosage |
/// |---|---|
/// | `text` | `text` |
/// | `timing.repeat.frequency` / `period` / `periodUnit` | the same; no `frequency` → 1 |
/// | `timing.repeat.when[0]` | `when`, if in R4's EventTiming value set |
/// | `timing.code` (only when `repeat` is absent) | see [`timing_abbreviation`] |
/// | `asNeededBoolean` | `as_needed` |
/// | `asNeededCodeableConcept` (any) | `as_needed` true |
/// | `doseAndRate[0].doseQuantity` | `dose`; a `doseRange` is dropped |
///
/// Only the units `h`, `d`, `wk`, `mo` are kept (`s`, `min`, `a` drop the
/// schedule). A `frequency` with no usable period is dropped with it: "3
/// times" per nothing is not a schedule.
fn medication_dosage(res: &Value) -> Option<Dosage> {
    let d = res.get("dosage")?.as_array()?.first()?;
    let timing = d.get("timing");
    let (repeat, when) = match timing.and_then(|t| t.get("repeat")) {
        Some(r) => (
            timing_repeat(r),
            r.get("when")
                .and_then(Value::as_array)
                .and_then(|w| w.first())
                .and_then(Value::as_str)
                .and_then(dosage::fhir_when),
        ),
        None => timing
            .and_then(|t| t.get("code"))
            .and_then(timing_abbreviation)
            .unwrap_or_default(),
    };
    let as_needed = match d.get("asNeededBoolean") {
        Some(Value::Bool(b)) => Some(*b),
        _ => d.get("asNeededCodeableConcept").map(|_| true),
    };
    let dose = d
        .get("doseAndRate")
        .and_then(Value::as_array)
        .and_then(|r| r.first())
        .and_then(|r| r.get("doseQuantity"))
        .and_then(|q| {
            dosage::dose(Quantity {
                value: quantity_value_str(q)?,
                unit: quantity_unit(q),
            })
        });
    dosage::finish(dosage::Parts {
        dose,
        text: d
            .get("text")
            .and_then(Value::as_str)
            .and_then(dosage::sig_text),
        repeat,
        when,
        as_needed,
    })
}

fn timing_repeat(r: &Value) -> Option<dosage::Repeat> {
    let period = json_decimal(r.get("period")?)?;
    let unit = dosage::period_unit(r.get("periodUnit")?.as_str()?)?;
    let frequency = match r.get("frequency") {
        Some(f) => json_decimal(f)?,
        None => "1".to_string(),
    };
    dosage::repeat(&frequency, &period, unit)
}

const GTS_ABBREVIATION: &str = "http://terminology.hl7.org/CodeSystem/v3-GTSAbbreviation";

/// A `timing.code` from FHIR's timing-abbreviation value set, as the schedule
/// it names. Matched in the GTS code system, or a coding with no system;
/// a same-spelled code in another system is not assumed to mean the same.
///
/// | Code | Frequency / period | `when` |
/// |---|---|---|
/// | `QD` | 1 / 1 d | |
/// | `BID` | 2 / 1 d | |
/// | `TID` | 3 / 1 d | |
/// | `QID` | 4 / 1 d | |
/// | `QOD` | 1 / 2 d | |
/// | `Q1H` `Q2H` `Q3H` `Q4H` `Q6H` `Q8H` | 1 / N h | |
/// | `WK` | 1 / 1 wk | |
/// | `MO` | 1 / 1 mo | |
/// | `AM` | 1 / 1 d | `MORN` |
/// | `PM` | 1 / 1 d | `AFT` |
/// | `BED` | 1 / 1 d | `HS` |
///
/// `PM` is `AFT`, not `EVE`: the code system defines it as "every afternoon".
fn timing_abbreviation(cc: &Value) -> Option<(Option<dosage::Repeat>, Option<String>)> {
    use PeriodUnit::{Day, Hour, Month, Week};
    let (f, p, unit, when) = cc
        .get("coding")?
        .as_array()?
        .iter()
        .filter(|c| {
            c.get("system")
                .and_then(Value::as_str)
                .is_none_or(|s| s == GTS_ABBREVIATION)
        })
        .find_map(|c| {
            Some(match c.get("code")?.as_str()? {
                "QD" => ("1", "1", Day, None),
                "BID" => ("2", "1", Day, None),
                "TID" => ("3", "1", Day, None),
                "QID" => ("4", "1", Day, None),
                "QOD" => ("1", "2", Day, None),
                "Q1H" => ("1", "1", Hour, None),
                "Q2H" => ("1", "2", Hour, None),
                "Q3H" => ("1", "3", Hour, None),
                "Q4H" => ("1", "4", Hour, None),
                "Q6H" => ("1", "6", Hour, None),
                "Q8H" => ("1", "8", Hour, None),
                "WK" => ("1", "1", Week, None),
                "MO" => ("1", "1", Month, None),
                "AM" => ("1", "1", Day, Some("MORN")),
                "PM" => ("1", "1", Day, Some("AFT")),
                "BED" => ("1", "1", Day, Some("HS")),
                _ => return None,
            })
        })?;
    Some((dosage::repeat(f, p, unit), when.and_then(dosage::fhir_when)))
}

// --- Encounter ---

fn import_encounter(res: &Value, result: &mut ImportResult) {
    let id = res.get("id").and_then(Value::as_str).unwrap_or("?");
    // `type` is a CodeableConcept array (take the first); `class` is a bare
    // Coding, not wrapped in a CodeableConcept — FHIR R4 quirk, so it needs
    // its own extraction rather than `best_coding`.
    let code = res
        .get("type")
        .and_then(Value::as_array)
        .and_then(|types| types.first())
        .and_then(best_coding)
        .or_else(|| res.get("class").and_then(coding_direct));
    let Some(code) = code else {
        result.skipped.push(Skipped {
            what: format!("Encounter/{id}"),
            why: "no type or class coding".into(),
        });
        return;
    };
    let effective_at = effective_datetime(res);
    result.events.push(EventDraft {
        kind: EventKind::Encounter,
        code: Some(code),
        effective_at,
        value: None,
    });
}

// --- Procedure ---

fn import_procedure(res: &Value, result: &mut ImportResult) {
    let id = res.get("id").and_then(Value::as_str).unwrap_or("?");
    let Some(code) = res.get("code").and_then(best_coding) else {
        result.skipped.push(Skipped {
            what: format!("Procedure/{id}"),
            why: "no code".into(),
        });
        return;
    };
    let effective_at = effective_datetime(res);
    result.events.push(EventDraft {
        kind: EventKind::Procedure,
        code: Some(code),
        effective_at,
        value: None,
    });
}

// --- shared helpers ---

/// Pick the best `Coding` out of a `CodeableConcept`: prefer LOINC, then
/// SNOMED, then whatever is first. `display` falls back to the
/// CodeableConcept's own `.text` if the chosen coding has none.
fn best_coding(cc: &Value) -> Option<Code> {
    let codings = cc.get("coding").and_then(Value::as_array)?;
    let pick = codings
        .iter()
        .find(|c| c.get("system").and_then(Value::as_str) == Some(LOINC))
        .or_else(|| {
            codings
                .iter()
                .find(|c| c.get("system").and_then(Value::as_str) == Some(SNOMED))
        })
        .or_else(|| codings.first())?;

    let system = pick.get("system").and_then(Value::as_str)?.to_string();
    let code = pick.get("code").and_then(Value::as_str)?.to_string();
    let display = pick
        .get("display")
        .and_then(Value::as_str)
        .or_else(|| cc.get("text").and_then(Value::as_str))
        .map(String::from);
    Some(Code {
        system,
        code,
        display,
    })
}

/// A bare FHIR `Coding` (not wrapped in a `CodeableConcept.coding` array) —
/// `Encounter.class`'s shape.
fn coding_direct(c: &Value) -> Option<Code> {
    let system = c.get("system").and_then(Value::as_str)?.to_string();
    let code = c.get("code").and_then(Value::as_str)?.to_string();
    let display = c.get("display").and_then(Value::as_str).map(String::from);
    Some(Code {
        system,
        code,
        display,
    })
}

/// A `Quantity.value` as its exact source literal — see the module doc
/// comment on why this must not go through `f64`.
fn quantity_value_str(q: &Value) -> Option<String> {
    json_decimal(q.get("value")?)
}

/// A JSON number as its source literal (so `1e1` stays `1e1`, for core to
/// refuse, rather than becoming `10`), or a string as given.
fn json_decimal(v: &Value) -> Option<String> {
    match v {
        Value::Number(n) => Some(n.to_string()),
        Value::String(s) => Some(s.clone()),
        _ => None,
    }
}

fn quantity_unit(q: &Value) -> Option<Code> {
    let code = q.get("code").and_then(Value::as_str);
    let system = q.get("system").and_then(Value::as_str);
    let unit = q.get("unit").and_then(Value::as_str);
    match (code, system) {
        (Some(code), Some(system)) => Some(Code {
            system: system.to_string(),
            code: code.to_string(),
            display: unit.map(String::from),
        }),
        _ => unit.map(|u| Code {
            system: UCUM.to_string(),
            code: u.to_string(),
            display: None,
        }),
    }
}

/// The first present of the several date/period fields FHIR spreads across
/// resource types, passed through verbatim — FHIR `dateTime`/`instant` values
/// are already ISO-8601.
fn effective_datetime(res: &Value) -> Option<String> {
    let str_field = |name: &str| res.get(name).and_then(Value::as_str).map(String::from);
    let period_start = |name: &str| {
        res.get(name)
            .and_then(|p| p.get("start"))
            .and_then(Value::as_str)
            .map(String::from)
    };

    str_field("effectiveDateTime")
        .or_else(|| period_start("effectivePeriod"))
        .or_else(|| str_field("onsetDateTime"))
        .or_else(|| str_field("occurrenceDateTime"))
        .or_else(|| str_field("performedDateTime"))
        .or_else(|| period_start("performedPeriod"))
        .or_else(|| str_field("recordedDate"))
        .or_else(|| str_field("date"))
        .or_else(|| period_start("period"))
}
