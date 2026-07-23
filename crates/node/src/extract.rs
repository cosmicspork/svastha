//! Turn a vision model's raw answer into draft events. This is a **third mapper**
//! alongside `crates/import`'s C-CDA and FHIR mappers: like them it produces
//! [`EventDraft`]s (the caller stamps provenance and the owner signs), and it
//! codes against the *same* terminology URIs (`svastha_import::systems`) so an
//! OCR'd blood pressure and an imported one land on the identical LOINC code — no
//! parallel coding vocabulary.
//!
//! The parse is **defensive by contract**: malformed inference output must never
//! become a malformed proposal. Anything that does not cleanly map to a
//! schema-valid, *meaningful* draft (a known `kind` plus at least a code or a
//! value) is dropped and counted — never guessed into shape. Confidence is
//! deliberately *not* a filter: low-confidence and handwritten reads are proposed
//! and lean on the owner's approval loop by design (design §7).

use serde::Deserialize;
use svastha_core::event::{Code, EventKind, EventValue};
use svastha_import::systems::{CVX, ICD10CM, LOINC, RXNORM, SNOMED, UCUM};
use svastha_import::EventDraft;

/// System instruction: a careful transcriber, not a diagnostician.
pub const SYSTEM_PROMPT: &str = "\
You transcribe medical documents into structured data. Extract ONLY facts that \
are visibly written on the page — measurements, medications, immunizations, \
problems, procedures, and their dates. Never infer, diagnose, predict, or add \
anything not literally present. If the page is blank or unreadable, return an \
empty findings list. Respond with a single JSON object and nothing else.";

/// User instruction: the exact output schema. Kept in lock-step with
/// [`Finding`] below.
pub const USER_PROMPT: &str = "\
Read this medical document image and return JSON of the form:
{\"findings\": [ {
  \"kind\": one of observation|condition|medication_statement|immunization|encounter|procedure|allergy_intolerance|document|nutrition_intake,
  \"system\": a code system URI when you are confident (http://loinc.org, \
http://www.nlm.nih.gov/research/umls/rxnorm, http://snomed.info/sct, \
http://hl7.org/fhir/sid/cvx, http://hl7.org/fhir/sid/icd-10-cm) or omit it,
  \"code\": the code in that system, or omit,
  \"display\": the human label as written,
  \"value_quantity\": a measured number as a string (e.g. \"120\"), or omit,
  \"unit\": the UCUM unit (e.g. \"mm[Hg]\", \"mg\"), or omit,
  \"value_text\": free text when the fact is not a code or a number, or omit,
  \"effective_at\": the date/time on the page as ISO-8601, or omit,
  \"confidence\": your confidence from 0 to 1
} ]}
Omit a field rather than guessing. Do not invent codes. Return {\"findings\": []} \
if nothing is legible.";

/// One finding as the model emits it (all fields optional and tolerant — an
/// unknown extra key is ignored, a missing key defaults). This is the *only*
/// place untrusted model JSON is shaped; every field is validated before it
/// becomes an [`EventDraft`].
#[derive(Debug, Default, Deserialize)]
struct Finding {
    #[serde(default)]
    kind: String,
    #[serde(default)]
    system: String,
    #[serde(default)]
    code: String,
    #[serde(default)]
    display: String,
    #[serde(default)]
    value_quantity: String,
    #[serde(default)]
    unit: String,
    #[serde(default)]
    value_text: String,
    #[serde(default)]
    effective_at: String,
    // `confidence` is accepted (unknown fields are ignored) but intentionally
    // unused: low confidence is the approval loop's job, not a drop reason.
}

#[derive(Debug, Default, Deserialize)]
struct Findings {
    #[serde(default)]
    findings: Vec<Finding>,
}

/// The result of parsing one model answer: the valid drafts, and how many
/// findings were dropped as unmappable (a count for logging — never the content).
#[derive(Debug, Default)]
pub struct Extraction {
    pub drafts: Vec<EventDraft>,
    pub dropped: usize,
}

/// Parse a model answer into draft events. Never errors: unparseable output
/// yields an empty extraction, and each individually-bad finding is dropped and
/// counted, so the worst case is "nothing proposed", never a bad proposal.
pub fn parse(answer: &str) -> Extraction {
    let Some(parsed) = parse_json_object::<Findings>(answer) else {
        // The whole answer was not JSON we could read — treat as "nothing found".
        return Extraction::default();
    };
    let mut out = Extraction::default();
    for finding in parsed.findings {
        match to_draft(finding) {
            Some(draft) => out.drafts.push(draft),
            None => out.dropped += 1,
        }
    }
    out
}

/// Validate one finding into a schema-valid, meaningful [`EventDraft`], or `None`
/// to drop it. "Meaningful" = a known `kind` plus at least a code or a value; an
/// empty shell is never proposed.
fn to_draft(f: Finding) -> Option<EventDraft> {
    let kind = parse_kind(&f.kind)?;
    let code = parse_code(&f.system, &f.code, &f.display);
    let value = parse_value(&f);

    // AllergyIntolerance carries its substance as the *value* (Coded), not the
    // event code — mirroring `crates/import`'s allergy convention exactly.
    let (code, value) = if kind == EventKind::AllergyIntolerance {
        let v = value
            .clone()
            .or_else(|| code.clone().map(EventValue::Coded))?;
        (None, Some(v))
    } else {
        (code, value)
    };

    if code.is_none() && value.is_none() {
        return None; // an empty shell — nothing to propose
    }

    Some(EventDraft {
        kind,
        code,
        effective_at: non_empty(&f.effective_at),
        value,
    })
}

/// A `kind` string to an [`EventKind`], via the same serde `snake_case` names the
/// contract pins. An unknown kind drops the finding.
fn parse_kind(kind: &str) -> Option<EventKind> {
    serde_json::from_value(serde_json::Value::String(kind.trim().to_string())).ok()
}

/// A `Code` from a finding's `system`/`code`/`display`, or `None` when either the
/// system or the code is missing (a half-coded finding is not coded).
fn parse_code(system: &str, code: &str, display: &str) -> Option<Code> {
    let code = code.trim();
    let system = system.trim();
    if code.is_empty() || system.is_empty() {
        return None;
    }
    Some(Code {
        system: normalize_system(system),
        code: code.to_string(),
        display: non_empty(display),
    })
}

/// A finding's value: a measured quantity, else free text. (The allergy special
/// case is handled by the caller.)
fn parse_value(f: &Finding) -> Option<EventValue> {
    let qty = f.value_quantity.trim();
    if !qty.is_empty() {
        return Some(EventValue::Quantity {
            value: qty.to_string(),
            unit: non_empty(&f.unit).map(|u| Code {
                system: UCUM.to_string(),
                code: u,
                display: None,
            }),
        });
    }
    non_empty(&f.value_text).map(EventValue::Text)
}

/// Map a friendly system token to the canonical URI `crates/import` uses; pass a
/// value that is already a URI (or an unrecognized system) through unchanged, so
/// a full URI from the model is honoured and an odd one still reaches the owner
/// to correct rather than being silently dropped.
fn normalize_system(system: &str) -> String {
    match system.to_ascii_lowercase().as_str() {
        "loinc" => LOINC.to_string(),
        "rxnorm" | "rx norm" => RXNORM.to_string(),
        "snomed" | "snomed ct" | "snomed-ct" | "snomedct" => SNOMED.to_string(),
        "ucum" => UCUM.to_string(),
        "cvx" => CVX.to_string(),
        "icd-10-cm" | "icd10cm" | "icd-10" | "icd10" => ICD10CM.to_string(),
        _ => system.to_string(),
    }
}

/// `Some(trimmed)` when non-empty, else `None`.
fn non_empty(s: &str) -> Option<String> {
    let t = s.trim();
    if t.is_empty() {
        None
    } else {
        Some(t.to_string())
    }
}

/// Parse a JSON object out of a model answer, tolerating the common ways a chat
/// model wraps it: leading prose, ```json fences, or trailing commentary. Tries a
/// clean parse first, then the substring from the first `{` to the last `}`.
fn parse_json_object<T: for<'de> Deserialize<'de>>(answer: &str) -> Option<T> {
    if let Ok(v) = serde_json::from_str::<T>(answer.trim()) {
        return Some(v);
    }
    let start = answer.find('{')?;
    let end = answer.rfind('}')?;
    if end <= start {
        return None;
    }
    serde_json::from_str::<T>(&answer[start..=end]).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_a_coded_quantity() {
        let answer = r#"{"findings":[
            {"kind":"observation","system":"loinc","code":"8480-6",
             "display":"Systolic blood pressure","value_quantity":"120",
             "unit":"mm[Hg]","effective_at":"2026-01-02","confidence":0.95}
        ]}"#;
        let ex = parse(answer);
        assert_eq!(ex.dropped, 0);
        assert_eq!(ex.drafts.len(), 1);
        let d = &ex.drafts[0];
        assert_eq!(d.kind, EventKind::Observation);
        // Friendly "loinc" normalized to the canonical URI import uses.
        assert_eq!(d.code.as_ref().unwrap().system, LOINC);
        assert_eq!(d.code.as_ref().unwrap().code, "8480-6");
        assert_eq!(d.effective_at.as_deref(), Some("2026-01-02"));
        match d.value.as_ref().unwrap() {
            EventValue::Quantity { value, unit } => {
                assert_eq!(value, "120");
                assert_eq!(unit.as_ref().unwrap().system, UCUM);
                assert_eq!(unit.as_ref().unwrap().code, "mm[Hg]");
            }
            _ => panic!("expected quantity"),
        }
    }

    #[test]
    fn medication_full_uri_passes_through() {
        let answer = r#"{"findings":[{"kind":"medication_statement",
            "system":"http://www.nlm.nih.gov/research/umls/rxnorm","code":"197361",
            "display":"Lisinopril 10 MG"}]}"#;
        let ex = parse(answer);
        assert_eq!(ex.drafts.len(), 1);
        assert_eq!(ex.drafts[0].code.as_ref().unwrap().system, RXNORM);
    }

    #[test]
    fn allergy_puts_substance_in_value() {
        // Mirrors crates/import: the allergy's code IS the substance, so it rides
        // as the value (Coded), and the event code is None.
        let answer = r#"{"findings":[{"kind":"allergy_intolerance",
            "system":"snomed","code":"7980","display":"Penicillin"}]}"#;
        let ex = parse(answer);
        assert_eq!(ex.drafts.len(), 1);
        let d = &ex.drafts[0];
        assert!(d.code.is_none());
        match d.value.as_ref().unwrap() {
            EventValue::Coded(c) => {
                assert_eq!(c.system, SNOMED);
                assert_eq!(c.code, "7980");
            }
            _ => panic!("expected coded value"),
        }
    }

    #[test]
    fn document_text_only_is_valid() {
        let answer = r#"{"findings":[{"kind":"document","value_text":"Reason for visit: cough"}]}"#;
        let ex = parse(answer);
        assert_eq!(ex.drafts.len(), 1);
        assert!(matches!(ex.drafts[0].value, Some(EventValue::Text(_))));
    }

    #[test]
    fn drops_unknown_kind_and_empty_shells() {
        let answer = r#"{"findings":[
            {"kind":"telepathy","value_text":"x"},
            {"kind":"observation"},
            {"kind":"observation","system":"loinc","code":"8480-6","value_quantity":"120"}
        ]}"#;
        let ex = parse(answer);
        assert_eq!(ex.drafts.len(), 1, "only the third is meaningful");
        assert_eq!(ex.dropped, 2);
    }

    #[test]
    fn malformed_answer_yields_nothing() {
        assert_eq!(parse("I could not read the image.").drafts.len(), 0);
        assert_eq!(parse("").drafts.len(), 0);
        assert_eq!(parse("{ not json").drafts.len(), 0);
    }

    #[test]
    fn tolerates_prose_and_fences_around_json() {
        let answer = "Here is what I found:\n```json\n{\"findings\":[{\"kind\":\"observation\",\"value_text\":\"note\"}]}\n```\nHope that helps!";
        let ex = parse(answer);
        assert_eq!(ex.drafts.len(), 1);
    }

    #[test]
    fn half_coded_finding_has_no_code_but_keeps_value() {
        // system without code → no code; but a value keeps the draft meaningful.
        let answer = r#"{"findings":[{"kind":"observation","system":"loinc",
            "value_quantity":"98.6","unit":"[degF]"}]}"#;
        let ex = parse(answer);
        assert_eq!(ex.drafts.len(), 1);
        assert!(ex.drafts[0].code.is_none());
    }
}
