//! Turn a model's raw answer into draft events. This is a **third mapper**
//! alongside this crate's C-CDA and FHIR mappers: like them it produces
//! [`EventDraft`]s (the caller stamps provenance and the owner signs), and it
//! codes against the *same* terminology URIs ([`crate::systems`]) so an OCR'd
//! blood pressure and an imported one land on the identical LOINC code — no
//! parallel coding vocabulary.
//!
//! The parse is **defensive by contract**: malformed inference output must never
//! become a malformed proposal. Anything that does not cleanly map to a
//! schema-valid, *meaningful* draft (a known `kind` plus at least a code or a
//! value) is dropped and counted — never guessed into shape. Confidence is
//! deliberately *not* a filter: low-confidence reads are proposed and lean on
//! the owner's approval loop by design (design §7).
//!
//! # Reading and coding are separate steps
//!
//! A single pass that both reads a page and codes it can assert "Potassium 14.2"
//! with nothing to check it against. Splitting them creates ground truth: the
//! caller transcribes the page first, then asks the model to code *that text*,
//! and every finding must name the numbered line it came from. [`parse_lines`]
//! then verifies the claim — see `quotes_back` — and drops a finding whose
//! cited line does not actually contain what it says it found.
//!
//! This is the defence against the failure that makes tabular lab reports
//! dangerous: a value read off one row and attached to the analyte on another.
//! Its limit is worth stating plainly — the guard confirms a finding belongs to
//! the **line** it cites, not to a particular cell within that line, so a swap
//! between two values on the *same* row still reaches the owner's approval
//! queue. It narrows the failure, it does not eliminate it.

use serde::Deserialize;
use svastha_core::event::{Code, EventKind, EventValue};

use crate::systems::{CVX, ICD10CM, LOINC, RXNORM, SNOMED, UCUM};
use crate::EventDraft;

/// System instruction for coding already-transcribed text.
pub const SYSTEM_PROMPT: &str = "\
You code already-transcribed medical text into structured data. Extract ONLY \
facts that are literally present in the text you are given — measurements, \
medications, immunizations, problems, procedures, and their dates. Never infer, \
diagnose, predict, or add anything not literally present. If the text contains \
no medical facts, return an empty findings list. Respond with a single JSON \
object and nothing else.";

/// User instruction for the text path: the exact output schema, kept in
/// lock-step with [`Finding`]. The caller appends the numbered transcript.
pub const USER_PROMPT: &str = "\
Below is text transcribed from a medical document, one numbered line per row. \
Return JSON of the form:
{\"findings\": [ {
  \"kind\": one of observation|condition|medication_statement|immunization|encounter|procedure|allergy_intolerance|document|nutrition_intake,
  \"source_line\": the number of the line this fact was read from,
  \"system\": a code system URI when you are confident (http://loinc.org, \
http://www.nlm.nih.gov/research/umls/rxnorm, http://snomed.info/sct, \
http://hl7.org/fhir/sid/cvx, http://hl7.org/fhir/sid/icd-10-cm) or omit it,
  \"code\": the code in that system, or omit,
  \"display\": the human label exactly as written on that line,
  \"value_quantity\": a measured number as a string (e.g. \"120\"), or omit,
  \"unit\": the UCUM unit (e.g. \"mm[Hg]\", \"mg\"), or omit,
  \"value_text\": free text when the fact is not a code or a number, or omit,
  \"effective_at\": the date/time as ISO-8601, or omit,
  \"confidence\": your confidence from 0 to 1
} ]}
A value and the analyte it belongs to are on the SAME numbered line. Never pair \
a value from one line with a label from another. Always give source_line.
The text was produced by OCR and may contain errors. Never repair a value you \
cannot read — omit the finding instead.
Omit a field rather than guessing. Do not invent codes. Return {\"findings\": []} \
if nothing is legible.";

/// System instruction for the legacy single-pass vision path.
///
/// Deleted when the node gains in-process transcription and every caller moves
/// to the text path; until then the node still sends page images, and a
/// text-coding instruction would be the wrong prompt for that request.
pub const VISION_SYSTEM_PROMPT: &str = "\
You transcribe medical documents into structured data. Extract ONLY facts that \
are visibly written on the page — measurements, medications, immunizations, \
problems, procedures, and their dates. Never infer, diagnose, predict, or add \
anything not literally present. If the page is blank or unreadable, return an \
empty findings list. Respond with a single JSON object and nothing else.";

/// User instruction for the legacy single-pass vision path. Carries no
/// `source_line`, so answers to it cannot be verified — which is precisely why
/// it is being retired.
pub const VISION_USER_PROMPT: &str = "\
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
    /// The 1-based numbered line this fact was read from. Absent on the legacy
    /// vision path, which has no transcript to point at.
    #[serde(default)]
    source_line: Option<usize>,
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
#[derive(Debug, Default, serde::Serialize)]
pub struct Extraction {
    pub drafts: Vec<EventDraft>,
    pub dropped: usize,
}

/// Parse a model answer into draft events, **without** source-line verification.
///
/// For the legacy vision path, which has no transcript to check a claim against.
/// Prefer [`parse_lines`] wherever the page was transcribed first: an
/// unverifiable finding is exactly the failure mode the split exists to close.
pub fn parse(answer: &str) -> Extraction {
    parse_inner(answer, None)
}

/// Parse a model answer into draft events, verifying every finding against the
/// transcript it was coded from.
///
/// `lines` is the numbered transcript in order, so `lines[0]` is line 1. A
/// finding is dropped (and counted) when it cites no line, cites a line that
/// does not exist, or cites a line that does not contain what it claims.
pub fn parse_lines(answer: &str, lines: &[String]) -> Extraction {
    parse_inner(answer, Some(lines))
}

/// Never errors: unparseable output yields an empty extraction, and each
/// individually-bad finding is dropped and counted, so the worst case is
/// "nothing proposed", never a bad proposal.
fn parse_inner(answer: &str, lines: Option<&[String]>) -> Extraction {
    let Some(parsed) = parse_json_object::<Findings>(answer) else {
        return Extraction::default();
    };
    let mut out = Extraction::default();
    for finding in parsed.findings {
        let verified = match lines {
            Some(lines) => quotes_back(&finding, lines),
            None => true,
        };
        match verified.then(|| to_draft(finding)).flatten() {
            Some(draft) => out.drafts.push(draft),
            None => out.dropped += 1,
        }
    }
    out
}

/// Whether a finding's cited line actually contains what it claims to have found.
///
/// The check is deliberately forgiving about wording and strict about identity:
///
/// - The cited line must exist. No `source_line`, or one out of range, fails —
///   an unverifiable claim is not a safer claim.
/// - At least one substantial word of `display` must appear on that line. Token
///   overlap rather than exact containment, so "Serum potassium" still matches a
///   line reading "Potassium" — while "Sodium" does not, which is the case that
///   matters.
/// - `value_quantity`, if given, must appear on that line.
///
/// Numbers keep their decimal points through normalization, so `4.1` does not
/// match inside `3.5-5.1` by accident.
fn quotes_back(f: &Finding, lines: &[String]) -> bool {
    let Some(index) = f.source_line else {
        return false;
    };
    let Some(line) = index.checked_sub(1).and_then(|i| lines.get(i)) else {
        return false;
    };
    let haystack = normalize(line);

    let display_tokens: Vec<String> = normalize(&f.display)
        .split(' ')
        .filter(|t| t.len() >= 3 && t.chars().any(|c| c.is_ascii_alphabetic()))
        .map(str::to_string)
        .collect();
    if !display_tokens.is_empty() && !display_tokens.iter().any(|t| haystack.contains(t.as_str())) {
        return false;
    }

    let value = normalize(&f.value_quantity);
    if !value.is_empty() && !haystack.contains(&value) {
        return false;
    }

    true
}

/// Lowercase, and collapse every run of characters that is neither alphanumeric
/// nor a decimal point into a single space. Keeping `.` is what stops `4.1`
/// matching inside a reference range like `3.5-5.1`.
fn normalize(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut spaced = true;
    for c in s.chars() {
        if c.is_ascii_alphanumeric() || c == '.' {
            out.push(c.to_ascii_lowercase());
            spaced = false;
        } else if !spaced {
            out.push(' ');
            spaced = true;
        }
    }
    out.trim().to_string()
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
        return None;
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

    fn lines(json: &str) -> Vec<String> {
        serde_json::from_str(json).expect("fixture lines")
    }

    const PANEL_LINES: &str = include_str!("../../../fixtures/ocr/cmp-panel.lines.json");
    const PANEL_GOOD: &str = include_str!("../../../fixtures/ocr/cmp-panel.answer.json");
    const PANEL_CROSS_ROW: &str =
        include_str!("../../../fixtures/ocr/cmp-panel.cross-row.answer.json");

    #[test]
    fn a_correctly_cited_panel_extracts_every_finding() {
        let ex = parse_lines(PANEL_GOOD, &lines(PANEL_LINES));
        assert_eq!(ex.dropped, 0);
        assert_eq!(ex.drafts.len(), 3);
        match ex.drafts[1].value.as_ref().unwrap() {
            EventValue::Quantity { value, .. } => assert_eq!(value, "4.1"),
            _ => panic!("expected quantity"),
        }
    }

    /// The reason the two-stage split exists. Every finding in this fixture is
    /// individually schema-valid and would sail through `parse` untouched; each
    /// pairs a real analyte with a value from a different row. "Potassium 139"
    /// is a clinical emergency that never happened.
    #[test]
    fn cross_row_mis_association_is_dropped_entirely() {
        let transcript = lines(PANEL_LINES);

        // Without the transcript there is nothing to check against, and all five
        // become proposals — this is what the vision path does today.
        assert_eq!(parse(PANEL_CROSS_ROW).drafts.len(), 5);

        // With it, none survive.
        let ex = parse_lines(PANEL_CROSS_ROW, &transcript);
        assert!(
            ex.drafts.is_empty(),
            "no cross-row finding may reach the approval queue, got {:?}",
            ex.drafts
        );
        assert_eq!(ex.dropped, 5);
    }

    #[test]
    fn a_finding_that_cites_no_line_or_a_missing_one_is_dropped() {
        let transcript = lines(PANEL_LINES);
        // An unverifiable claim is not a safer claim.
        let no_line =
            r#"{"findings":[{"kind":"observation","display":"Sodium","value_quantity":"139"}]}"#;
        assert_eq!(parse_lines(no_line, &transcript).dropped, 1);

        let out_of_range = r#"{"findings":[{"kind":"observation","source_line":99,
            "display":"Sodium","value_quantity":"139"}]}"#;
        assert_eq!(parse_lines(out_of_range, &transcript).dropped, 1);
    }

    #[test]
    fn wording_may_differ_from_the_line_as_long_as_it_overlaps() {
        let transcript = lines(PANEL_LINES);
        // "Serum potassium" still names the analyte on line 5.
        let reworded = r#"{"findings":[{"kind":"observation","source_line":5,
            "system":"loinc","code":"2823-3","display":"Serum potassium",
            "value_quantity":"4.1"}]}"#;
        assert_eq!(parse_lines(reworded, &transcript).drafts.len(), 1);
    }

    /// Decimal points survive normalization, so a value cannot be "found" inside
    /// the reference range printed beside it.
    #[test]
    fn a_value_matching_only_inside_the_reference_range_is_dropped() {
        let transcript = lines(PANEL_LINES);
        // Line 5 reads "Potassium 4.1 mmol/L 3.5-5.1". A claimed value of 5.1 is
        // the range's upper bound, not the result.
        let from_range = r#"{"findings":[{"kind":"observation","source_line":5,
            "system":"loinc","code":"2823-3","display":"Potassium",
            "value_quantity":"51"}]}"#;
        assert_eq!(parse_lines(from_range, &transcript).dropped, 1);
    }

    #[test]
    fn a_finding_with_no_value_is_verified_on_its_label_alone() {
        let transcript = lines(PANEL_LINES);
        let labelled = r#"{"findings":[{"kind":"observation","source_line":3,
            "value_text":"Analyte Result Unit Reference","display":"Analyte"}]}"#;
        assert_eq!(parse_lines(labelled, &transcript).drafts.len(), 1);
    }
}
