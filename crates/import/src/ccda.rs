//! C-CDA (Consolidated CDA) mapping: a `ClinicalDocument`'s
//! `component/structuredBody/component*/section*`, dispatched on each
//! section's LOINC `code` (never on document order or templateId — Epic
//! exports carry many `<templateId>` elements per section and an `<id>`
//! before `<code>`).
//!
//! Matching is namespace-agnostic on local names throughout: C-CDA documents
//! declare `xmlns="urn:hl7-org:v3"` as the default namespace, and walking by
//! local name only is simpler and just as unambiguous here (no other
//! namespace's elements appear in these documents).

use roxmltree::{Document, Node};

use svastha_core::event::{Code, EventKind, EventValue};

use crate::dates::hl7_ts_to_iso;
use crate::systems::{CVX, ICD10CM, LOINC, RXNORM, SNOMED, UCUM};
use crate::{EventDraft, ImportError, ImportResult, Skipped};

pub fn import(xml: &str) -> Result<ImportResult, ImportError> {
    let doc = Document::parse(xml)?;
    let root = doc.root_element(); // ClinicalDocument
    let mut result = ImportResult::default();

    // A document with no structured body (e.g. a scanned-PDF-only C-CDA) has
    // nothing to map — not an error, just nothing to walk.
    let Some(structured_body) =
        find_child(root, "component").and_then(|c| find_child(c, "structuredBody"))
    else {
        return Ok(result);
    };

    for section_wrapper in children_named(structured_body, "component") {
        let Some(section) = find_child(section_wrapper, "section") else {
            continue;
        };
        import_section(section, &mut result);
    }

    Ok(result)
}

// --- section dispatch ---

fn import_section(section: Node, result: &mut ImportResult) {
    let Some(code) = section_code(section) else {
        result.skipped.push(Skipped {
            what: section_title(section),
            why: "section has no <code> — cannot classify".into(),
        });
        return;
    };

    match code.as_str() {
        "48765-2" => import_allergies(section, result),
        "11450-4" | "11348-0" => import_problems(section, result),
        "10160-0" => import_medications(section, result),
        "11369-6" => import_immunizations(section, result),
        "30954-2" => import_results(section, result),
        "8716-3" => import_vitals(section, result),
        "47519-4" => import_procedures(section, result),
        "46240-8" => import_encounters(section, result),
        _ => result.skipped.push(Skipped {
            what: format!("{} ({code})", section_title(section)),
            why: "section not mapped (v1)".into(),
        }),
    }
}

fn section_code(section: Node) -> Option<String> {
    find_child(section, "code")
        .and_then(|c| c.attribute("code"))
        .map(String::from)
}

fn section_title(section: Node) -> String {
    find_child(section, "title")
        .and_then(|t| t.text())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(String::from)
        .unwrap_or_else(|| section_code(section).unwrap_or_else(|| "untitled section".into()))
}

// --- allergies (48765-2) ---

/// The substance is the reaction's `participant/participantRole/playingEntity`
/// code, not the observation's own `code` (that's a fixed assertion type like
/// "Allergy to substance"). No `value` — the fact recorded is "allergic to X",
/// not a measurement.
fn import_allergies(section: Node, result: &mut ImportResult) {
    for entry in children_named(section, "entry") {
        let what = "allergy entry";
        let Some(obs) = find_descendant(entry, "observation") else {
            result.skipped.push(Skipped {
                what: what.into(),
                why: "no observation found".into(),
            });
            continue;
        };
        let Some(playing_entity) = find_descendant(obs, "playingEntity") else {
            result.skipped.push(Skipped {
                what: what.into(),
                why: "no participant substance found".into(),
            });
            continue;
        };
        let Some(code_el) = find_child(playing_entity, "code") else {
            result.skipped.push(Skipped {
                what: what.into(),
                why: "substance has no <code>".into(),
            });
            continue;
        };
        let Some(code) = extract_code(code_el) else {
            result.skipped.push(Skipped {
                what: what.into(),
                why: "substance code unusable (nullFlavor)".into(),
            });
            continue;
        };
        let effective_at = effective_time(obs, what, result);
        result.events.push(EventDraft {
            kind: EventKind::AllergyIntolerance,
            code: Some(code),
            effective_at,
            value: None,
        });
    }
}

// --- problems (11450-4 active, 11348-0 resolved history) ---

/// The Problem Observation's own `code` is a fixed assertion type (e.g.
/// SNOMED "Problem"); the actual diagnosis is the `value` (xsi:type `CD`).
fn import_problems(section: Node, result: &mut ImportResult) {
    for entry in children_named(section, "entry") {
        let what = "problem entry";
        let Some(obs) = find_descendant(entry, "observation") else {
            result.skipped.push(Skipped {
                what: what.into(),
                why: "no observation found".into(),
            });
            continue;
        };
        let Some(value_el) = find_child(obs, "value") else {
            result.skipped.push(Skipped {
                what: what.into(),
                why: "no <value>".into(),
            });
            continue;
        };
        let Some(code) = extract_code(value_el) else {
            result.skipped.push(Skipped {
                what: what.into(),
                why: "value code unusable (nullFlavor)".into(),
            });
            continue;
        };
        let effective_at = effective_time(obs, what, result);
        result.events.push(EventDraft {
            kind: EventKind::Condition,
            code: Some(code),
            effective_at,
            value: None,
        });
    }
}

// --- medications (10160-0) ---

fn import_medications(section: Node, result: &mut ImportResult) {
    for entry in children_named(section, "entry") {
        let what = "medication entry";
        let Some(sa) = find_descendant(entry, "substanceAdministration") else {
            result.skipped.push(Skipped {
                what: what.into(),
                why: "no substanceAdministration found".into(),
            });
            continue;
        };
        let Some(material) = find_descendant(sa, "manufacturedMaterial") else {
            result.skipped.push(Skipped {
                what: what.into(),
                why: "no manufacturedMaterial found".into(),
            });
            continue;
        };
        let med_code = find_child(material, "code").and_then(extract_code);
        let effective_at = effective_time(sa, what, result);

        // Dose, when present as a quantity with a real unit, is the value;
        // otherwise fall back to the medication's own name as text — losing
        // the dose is better than losing the fact of the medication entirely.
        let value = find_child(sa, "doseQuantity")
            .and_then(|dq| {
                let v = dq.attribute("value")?;
                let unit = dq.attribute("unit").filter(|u| !u.is_empty());
                Some(EventValue::Quantity {
                    value: v.to_string(),
                    unit: unit.map(ucum_code),
                })
            })
            .or_else(|| {
                med_code
                    .as_ref()
                    .and_then(|c| c.display.clone())
                    .map(EventValue::Text)
            });

        if med_code.is_none() && value.is_none() {
            result.skipped.push(Skipped {
                what: what.into(),
                why: "no usable medication code or name".into(),
            });
            continue;
        }
        result.events.push(EventDraft {
            kind: EventKind::MedicationStatement,
            code: med_code,
            effective_at,
            value,
        });
    }
}

// --- immunizations (11369-6) ---

fn import_immunizations(section: Node, result: &mut ImportResult) {
    for entry in children_named(section, "entry") {
        let what = "immunization entry";
        let Some(sa) = find_descendant(entry, "substanceAdministration") else {
            result.skipped.push(Skipped {
                what: what.into(),
                why: "no substanceAdministration found".into(),
            });
            continue;
        };
        if sa.attribute("negationInd") == Some("true") {
            result
                .warnings
                .push(format!("{what}: negated (not administered), skipping"));
            continue;
        }
        let Some(material) = find_descendant(sa, "manufacturedMaterial") else {
            result.skipped.push(Skipped {
                what: what.into(),
                why: "no manufacturedMaterial found".into(),
            });
            continue;
        };
        let Some(code_el) = find_child(material, "code") else {
            result.skipped.push(Skipped {
                what: what.into(),
                why: "vaccine has no <code>".into(),
            });
            continue;
        };
        let Some(code) = extract_code(code_el) else {
            result.skipped.push(Skipped {
                what: what.into(),
                why: "vaccine code unusable (nullFlavor)".into(),
            });
            continue;
        };
        let effective_at = effective_time(sa, what, result);
        result.events.push(EventDraft {
            kind: EventKind::Immunization,
            code: Some(code),
            effective_at,
            value: None,
        });
    }
}

// --- results (30954-2) and vitals (8716-3) ---
//
// Both sections shape entries the same way (an organizer wrapping one or more
// component observations, sometimes an observation directly with no
// organizer), so they share `import_observation_entries` and differ only in
// the label used for warnings/skips.

fn import_results(section: Node, result: &mut ImportResult) {
    import_observation_entries(section, "result", result);
}

fn import_vitals(section: Node, result: &mut ImportResult) {
    import_observation_entries(section, "vital", result);
}

fn import_observation_entries(section: Node, label: &str, result: &mut ImportResult) {
    for entry in children_named(section, "entry") {
        let observations: Vec<Node> = descendants_named(entry, "observation").collect();
        if observations.is_empty() {
            result.skipped.push(Skipped {
                what: format!("{label} entry"),
                why: "no observation found".into(),
            });
            continue;
        }
        for obs in observations {
            import_result_observation(obs, label, result);
        }
    }
}

fn import_result_observation(obs: Node, label: &str, result: &mut ImportResult) {
    let what = format!("{label} observation");
    let Some(code_el) = find_child(obs, "code") else {
        result.skipped.push(Skipped {
            what,
            why: "no <code>".into(),
        });
        return;
    };
    let Some(code) = extract_code(code_el) else {
        result.skipped.push(Skipped {
            what,
            why: "code unusable (nullFlavor)".into(),
        });
        return;
    };
    let effective_at = effective_time(obs, &what, result);

    let Some(value_el) = find_child(obs, "value") else {
        result.skipped.push(Skipped {
            what: format!("{what} ({})", code.code),
            why: "no <value>".into(),
        });
        return;
    };

    if let Some(value) = value_to_event_value(value_el, &format!("{what} ({})", code.code), result)
    {
        result.events.push(EventDraft {
            kind: EventKind::Observation,
            code: Some(code),
            effective_at,
            value: Some(value),
        });
    }
}

/// Dispatch on the value's `xsi:type`, per the observed distribution in real
/// Epic exports: CD/CE (coded), PQ/INT/REAL (quantity, value kept verbatim),
/// ST (text), IVL_PQ/IVL_REAL (collapsed to `<low>` with a warning), ED
/// (skipped — free-form embedded data has no structured fact to extract).
fn value_to_event_value(
    value_el: Node,
    what: &str,
    result: &mut ImportResult,
) -> Option<EventValue> {
    let xtype = xsi_type(value_el).unwrap_or_default();
    match xtype {
        "PQ" | "INT" | "REAL" => {
            let Some(v) = value_el.attribute("value") else {
                result.skipped.push(Skipped {
                    what: what.into(),
                    why: format!("{xtype} value missing @value"),
                });
                return None;
            };
            let unit = value_el
                .attribute("unit")
                .filter(|u| !u.is_empty() && *u != "1");
            Some(EventValue::Quantity {
                value: v.to_string(),
                unit: unit.map(ucum_code),
            })
        }
        "CD" | "CE" => match extract_code(value_el) {
            Some(code) => Some(EventValue::Coded(code)),
            None => {
                result.skipped.push(Skipped {
                    what: what.into(),
                    why: format!("{xtype} value is nullFlavor with no usable translation"),
                });
                None
            }
        },
        "ST" => {
            let text = value_el.text().unwrap_or_default().trim();
            if text.is_empty() {
                result.skipped.push(Skipped {
                    what: what.into(),
                    why: "ST value has no text content".into(),
                });
                None
            } else {
                Some(EventValue::Text(text.to_string()))
            }
        }
        "IVL_PQ" | "IVL_REAL" => {
            let Some(low) = find_child(value_el, "low") else {
                result.skipped.push(Skipped {
                    what: what.into(),
                    why: format!("{xtype} value missing <low>"),
                });
                return None;
            };
            let Some(v) = low.attribute("value") else {
                result.skipped.push(Skipped {
                    what: what.into(),
                    why: format!("{xtype} value <low> missing @value"),
                });
                return None;
            };
            result.warnings.push(format!(
                "{what}: {xtype} interval collapsed to its <low> bound"
            ));
            let unit = low
                .attribute("unit")
                .or_else(|| value_el.attribute("unit"))
                .filter(|u| !u.is_empty() && *u != "1");
            Some(EventValue::Quantity {
                value: v.to_string(),
                unit: unit.map(ucum_code),
            })
        }
        "ED" => {
            result.warnings.push(format!(
                "{what}: ED (embedded data) value not supported, skipping"
            ));
            None
        }
        other => {
            result.skipped.push(Skipped {
                what: what.into(),
                why: format!("unhandled value type {other:?}"),
            });
            None
        }
    }
}

// --- procedures (47519-4) ---

fn import_procedures(section: Node, result: &mut ImportResult) {
    for entry in children_named(section, "entry") {
        let what = "procedure entry";
        let Some(procedure) = find_descendant(entry, "procedure") else {
            result.skipped.push(Skipped {
                what: what.into(),
                why: "no procedure element found".into(),
            });
            continue;
        };
        let Some(code_el) = find_child(procedure, "code") else {
            result.skipped.push(Skipped {
                what: what.into(),
                why: "no <code>".into(),
            });
            continue;
        };
        let Some(code) = extract_code(code_el) else {
            result.skipped.push(Skipped {
                what: what.into(),
                why: "code unusable (nullFlavor)".into(),
            });
            continue;
        };
        let effective_at = effective_time(procedure, what, result);
        result.events.push(EventDraft {
            kind: EventKind::Procedure,
            code: Some(code),
            effective_at,
            value: None,
        });
    }
}

// --- encounters (46240-8) ---

fn import_encounters(section: Node, result: &mut ImportResult) {
    for entry in children_named(section, "entry") {
        let what = "encounter entry";
        let Some(encounter) = find_descendant(entry, "encounter") else {
            result.skipped.push(Skipped {
                what: what.into(),
                why: "no encounter element found".into(),
            });
            continue;
        };
        let Some(code_el) = find_child(encounter, "code") else {
            result.skipped.push(Skipped {
                what: what.into(),
                why: "no <code>".into(),
            });
            continue;
        };
        let Some(code) = extract_code(code_el) else {
            result.skipped.push(Skipped {
                what: what.into(),
                why: "code unusable (nullFlavor)".into(),
            });
            continue;
        };
        // effectiveTime may be an interval (admission/discharge); low is the
        // encounter start, handled by `effective_time` like everywhere else.
        let effective_at = effective_time(encounter, what, result);
        result.events.push(EventDraft {
            kind: EventKind::Encounter,
            code: Some(code),
            effective_at,
            value: None,
        });
    }
}

// --- shared helpers ---

/// A code-bearing element's `code`/`codeSystem`/`displayName`, with
/// nullFlavor and translation fallback: if the root is unusable (missing or
/// `nullFlavor`), fall back to the first `<translation>` that has a real
/// code — real Epic exports lean on this heavily (over a thousand
/// translations in one observed document). Returns `None` only when neither
/// the root nor any translation has a usable code.
fn extract_code(el: Node) -> Option<Code> {
    if el.attribute("nullFlavor").is_none() {
        if let (Some(code), Some(code_system)) = (el.attribute("code"), el.attribute("codeSystem"))
        {
            return Some(Code {
                system: oid_to_system(code_system),
                code: code.to_string(),
                display: el.attribute("displayName").map(String::from),
            });
        }
    }
    for translation in children_named(el, "translation") {
        if translation.attribute("nullFlavor").is_some() {
            continue;
        }
        if let (Some(code), Some(code_system)) = (
            translation.attribute("code"),
            translation.attribute("codeSystem"),
        ) {
            return Some(Code {
                system: oid_to_system(code_system),
                code: code.to_string(),
                display: translation.attribute("displayName").map(String::from),
            });
        }
    }
    None
}

/// Map a C-CDA `codeSystem` OID to its URI. Unknown OIDs are kept as
/// `urn:oid:{oid}` rather than dropped — the code is never silently lost even
/// when we don't recognize its terminology.
fn oid_to_system(oid: &str) -> String {
    match oid {
        "2.16.840.1.113883.6.1" => LOINC.to_string(),
        "2.16.840.1.113883.6.96" => SNOMED.to_string(),
        "2.16.840.1.113883.6.88" => RXNORM.to_string(),
        "2.16.840.1.113883.12.292" | "2.16.840.1.113883.6.59" => CVX.to_string(),
        "2.16.840.1.113883.6.90" => ICD10CM.to_string(),
        other => format!("urn:oid:{other}"),
    }
}

fn ucum_code(unit: &str) -> Code {
    Code {
        system: UCUM.to_string(),
        code: unit.to_string(),
        display: None,
    }
}

/// `effectiveTime/@value`, or `effectiveTime/low/@value` for an interval form
/// (warning if only `<high>` is present — a fact with an end but no start
/// gets no date rather than a guessed one). Malformed timestamps also warn
/// and yield no date, rather than failing the whole document.
fn effective_time(node: Node, what: &str, result: &mut ImportResult) -> Option<String> {
    let et = find_child(node, "effectiveTime")?;
    let raw = et
        .attribute("value")
        .or_else(|| find_child(et, "low").and_then(|low| low.attribute("value")));

    match raw {
        Some(v) => match hl7_ts_to_iso(v) {
            Ok(iso) => Some(iso),
            Err(_) => {
                result.warnings.push(format!(
                    "{what}: malformed effectiveTime {v:?}, no date recorded"
                ));
                None
            }
        },
        None => {
            if find_child(et, "high").is_some() {
                result.warnings.push(format!(
                    "{what}: effectiveTime has only <high>, no <low> — no date recorded"
                ));
            }
            None
        }
    }
}

/// The `xsi:type` attribute value, resolved by local name (`type`) with a
/// namespace check so a plain (non-`xsi`) `type` attribute never matches.
fn xsi_type<'a>(node: Node<'a, 'a>) -> Option<&'a str> {
    node.attributes()
        .find(|a| {
            a.name() == "type"
                && a.namespace()
                    .is_some_and(|ns| ns.contains("XMLSchema-instance"))
        })
        .map(|a| a.value())
}

fn children_named<'a, 'input: 'a>(
    node: Node<'a, 'input>,
    name: &'a str,
) -> impl Iterator<Item = Node<'a, 'input>> {
    node.children()
        .filter(move |n| n.is_element() && n.tag_name().name() == name)
}

fn find_child<'a, 'input>(node: Node<'a, 'input>, name: &str) -> Option<Node<'a, 'input>> {
    node.children()
        .find(|n| n.is_element() && n.tag_name().name() == name)
}

fn descendants_named<'a, 'input: 'a>(
    node: Node<'a, 'input>,
    name: &'a str,
) -> impl Iterator<Item = Node<'a, 'input>> {
    node.descendants()
        .filter(move |n| n.is_element() && n.tag_name().name() == name)
}

fn find_descendant<'a, 'input>(node: Node<'a, 'input>, name: &str) -> Option<Node<'a, 'input>> {
    node.descendants()
        .find(|n| n.is_element() && n.tag_name().name() == name)
}
