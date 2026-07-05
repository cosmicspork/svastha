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

use svastha_core::event::{Code, EventKind, EventValue};

use crate::systems::{LOINC, SNOMED, UCUM};
use crate::{EventDraft, ImportError, ImportResult, Skipped};

pub fn import(json: &str) -> Result<ImportResult, ImportError> {
    let bundle: Value = serde_json::from_str(json)?;
    if bundle.get("resourceType").and_then(Value::as_str) != Some("Bundle") {
        return Err(ImportError::NotABundle);
    }

    let mut result = ImportResult::default();
    for entry in bundle
        .get("entry")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        if let Some(resource) = entry.get("resource") {
            import_resource(resource, &mut result);
        }
    }
    Ok(result)
}

fn import_resource(resource: &Value, result: &mut ImportResult) {
    let resource_type = resource
        .get("resourceType")
        .and_then(Value::as_str)
        .unwrap_or("");
    let id = resource.get("id").and_then(Value::as_str).unwrap_or("?");

    match resource_type {
        "Observation" => import_observation(resource, result),
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

fn import_observation(res: &Value, result: &mut ImportResult) {
    let id = res.get("id").and_then(Value::as_str).unwrap_or("?");
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
        value: None,
    });
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
    match q.get("value")? {
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
