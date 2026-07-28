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
//! dangerous: a value read off one row and attached to the analyte on another,
//! or read out of the reference-range column of its own row.
//!
//! Its limit is worth stating plainly. The guard works at line and token level:
//! a claimed value must be a whole token of the line it cites and not a bound of
//! a range printed there. It does not know which *cell* a token came from, so a
//! swap between two results on the same row still reaches the owner's approval
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

/// One finding as the model emits it (all fields optional and tolerant — an
/// unknown extra key is ignored, a missing key defaults). This is the *only*
/// place untrusted model JSON is shaped; every field is validated before it
/// becomes an [`EventDraft`].
#[derive(Debug, Default, Deserialize)]
struct Finding {
    #[serde(default)]
    kind: String,
    /// The 1-based numbered line this fact was read from. Absent on the legacy
    /// single-pass path, which has no transcript to point at.
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
/// Retained for a caller that has no transcript to check a claim against —
/// none ship in this repo. Prefer [`parse_lines`] everywhere: an unverifiable
/// finding is exactly the failure mode the split exists to close, and this is
/// what the comparison in the tests below measures.
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
/// Every claim the finding makes is checked against the tokens of that one line,
/// and a finding that makes no checkable claim at all is dropped:
///
/// - The cited line must exist. No `source_line`, or one out of range, fails —
///   an unverifiable claim is not a safer claim.
/// - `display`, when it has a word in it, must share a whole token with the
///   line. Overlap rather than equality, so "Serum potassium" still matches a
///   line reading "Potassium" — while "Sodium" does not, which is the case that
///   matters. One- and two-letter labels (`K`, `Na`) are checked the same way
///   rather than dismissed as too short to be worth checking.
/// - `value_quantity`, when given, must equal a whole token — or a run of
///   them — that is not a bound of a printed reference range. `13` is therefore
///   not "found" inside `139`, and `5.1` is not found in `3.5-5.1`.
/// - `value_text`, when given, must share more than half its tokens with the
///   line, so free text is bound to its citation the way a value is.
///
/// Beyond the cell-level limit the module doc states: a range is recognized by
/// the dash joining its bounds (`3.5-5.1`, `135 - 145`, en and em dashes too),
/// so one spelled another way — "3.5 to 5.1" — reads as two ordinary numbers and
/// its bounds stay quotable.
fn quotes_back(f: &Finding, lines: &[String]) -> bool {
    let Some(index) = f.source_line else {
        return false;
    };
    let Some(line) = index.checked_sub(1).and_then(|i| lines.get(i)) else {
        return false;
    };
    let tokens = tokenize(line);
    let mut checked_something = false;

    let display: Vec<String> = tokenize(&f.display)
        .into_iter()
        .filter(|t| t.text.chars().any(|c| c.is_ascii_alphabetic()))
        .map(|t| t.text)
        .collect();
    if !display.is_empty() {
        if !display.iter().any(|d| tokens.iter().any(|t| &t.text == d)) {
            return false;
        }
        checked_something = true;
    }

    let value: Vec<String> = tokenize(&f.value_quantity)
        .into_iter()
        .map(|t| t.text)
        .collect();
    if !value.is_empty() {
        if !contains_run(&tokens, &value) {
            return false;
        }
        checked_something = true;
    }

    if !f.value_text.trim().is_empty() {
        let text: Vec<String> = tokenize(&f.value_text)
            .into_iter()
            .map(|t| t.text)
            .collect();
        let quoted = text
            .iter()
            .filter(|w| tokens.iter().any(|t| &&t.text == w))
            .count();
        // A strict majority, which for one or two tokens means all of them.
        if quoted * 2 <= text.len() {
            return false;
        }
        checked_something = true;
    }

    checked_something
}

/// One token of a line: alphanumerics and decimal points, lowercased.
struct Token {
    text: String,
    /// This token is one end of a printed reference range. A bound is a number
    /// on the line like any other, so without this the guard cannot tell a
    /// result from the interval printed beside it.
    in_range: bool,
}

/// Split into tokens, marking the bounds of any `low-high` range.
fn tokenize(s: &str) -> Vec<Token> {
    let mut out: Vec<Token> = Vec::new();
    // The raw characters between the previous token and the next one, which is
    // where the dash that makes a range lives.
    let mut gaps: Vec<String> = Vec::new();
    let mut gap = String::new();
    let mut current = String::new();

    for c in s.chars() {
        if c.is_ascii_alphanumeric() || c == '.' {
            current.push(c.to_ascii_lowercase());
        } else {
            if !current.is_empty() {
                gaps.push(std::mem::take(&mut gap));
                out.push(Token {
                    text: std::mem::take(&mut current),
                    in_range: false,
                });
            }
            gap.push(c);
        }
    }
    if !current.is_empty() {
        gaps.push(gap);
        out.push(Token {
            text: current,
            in_range: false,
        });
    }

    for i in 1..out.len() {
        if is_number(&out[i - 1].text) && is_number(&out[i].text) && is_range_dash(&gaps[i]) {
            out[i - 1].in_range = true;
            out[i].in_range = true;
        }
    }
    out
}

fn is_number(t: &str) -> bool {
    t.chars().any(|c| c.is_ascii_digit()) && t.chars().all(|c| c.is_ascii_digit() || c == '.')
}

/// Whether the text between two numbers joins them into a range. Hyphen, en
/// dash and em dash all show up in OCR of the same printed dash.
fn is_range_dash(gap: &str) -> bool {
    let g = gap.trim();
    !g.is_empty()
        && g.chars()
            .all(|c| matches!(c, '-' | '\u{2010}' | '\u{2013}' | '\u{2014}'))
}

/// Whether `needle` appears as a contiguous run of whole tokens, none of them a
/// range bound. Whole tokens are the point: a substring match accepts `13` from
/// `139` and `45` from `145`.
fn contains_run(tokens: &[Token], needle: &[String]) -> bool {
    if needle.is_empty() {
        return false;
    }
    tokens.windows(needle.len()).any(|w| {
        w.iter()
            .zip(needle)
            .all(|(t, n)| &t.text == n && !t.in_range)
    })
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
    /// cites a real line and pairs it with a value from a different row.
    /// "Potassium 139" is a clinical emergency that never happened. Findings
    /// that cite nothing, or a line that does not exist, are a different failure
    /// with its own test — keeping them out of here is what makes the count below
    /// a measure of cross-row coverage.
    #[test]
    fn cross_row_mis_association_is_dropped_entirely() {
        let transcript = lines(PANEL_LINES);

        // A finding that cited nothing would be dropped for the wrong reason and
        // quietly turn the count below into a weaker claim than it reads as.
        let parsed: Findings = parse_json_object(PANEL_CROSS_ROW).expect("fixture parses");
        assert!(
            parsed.findings.iter().all(|f| f
                .source_line
                .is_some_and(|n| (1..=transcript.len()).contains(&n))),
            "every finding in the cross-row fixture must cite a real line"
        );

        // Without the transcript there is nothing to check against, and all five
        // become proposals — this is what an unverified pass would do.
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

        // ...and so does a label that names only part of the printed one.
        let narrower = vec!["Potassium, serum    4.1   mmol/L   3.5-5.1".to_string()];
        assert_eq!(
            parse_lines(&observation(1, "Potassium", "4.1"), &narrower)
                .drafts
                .len(),
            1
        );
    }

    /// One observation finding as the model would emit it.
    fn observation(source_line: usize, display: &str, value: &str) -> String {
        format!(
            r#"{{"findings":[{{"kind":"observation","source_line":{source_line},
               "system":"loinc","code":"2823-3","display":"{display}",
               "value_quantity":"{value}"}}]}}"#
        )
    }

    /// Reading the reference-range column instead of the result column is the
    /// commonest tabular mis-read after the cross-row swap, and a bound is a
    /// whole token on the line like any other number.
    #[test]
    fn a_value_taken_from_the_printed_reference_range_is_dropped() {
        let t = lines(PANEL_LINES);
        // Line 5: "Potassium 4.1 mmol/L 3.5-5.1" — 3.5 and 5.1 are the range.
        assert_eq!(
            parse_lines(&observation(5, "Potassium", "5.1"), &t).dropped,
            1
        );
        assert_eq!(
            parse_lines(&observation(5, "Potassium", "3.5"), &t).dropped,
            1
        );
        // Line 7: "Glucose 105 mg/dL 70-99".
        assert_eq!(parse_lines(&observation(7, "Glucose", "99"), &t).dropped, 1);
        // OCR renders the same printed dash as a hyphen, en dash or em dash.
        let dashes = vec!["Sodium   139   mmol/L   135\u{2013}145".to_string()];
        assert_eq!(
            parse_lines(&observation(1, "Sodium", "145"), &dashes).dropped,
            1
        );
        // The result on that same line still verifies.
        assert_eq!(
            parse_lines(&observation(5, "Potassium", "4.1"), &t)
                .drafts
                .len(),
            1
        );
    }

    #[test]
    fn a_value_that_is_only_part_of_a_number_on_the_line_is_dropped() {
        let t = lines(PANEL_LINES);
        // Line 4: "Sodium 139 mmol/L 135-145". Neither 13 nor 45 is on it.
        assert_eq!(parse_lines(&observation(4, "Sodium", "13"), &t).dropped, 1);
        assert_eq!(parse_lines(&observation(4, "Sodium", "45"), &t).dropped, 1);
    }

    /// The rule is "matches a token outside the range", not "differs from the
    /// bounds": a potassium of 5.1 against 3.5-5.1 is a real, high-normal result.
    #[test]
    fn a_result_that_equals_a_range_bound_is_kept() {
        let t = vec!["Potassium        5.1      mmol/L    3.5-5.1".to_string()];
        assert_eq!(
            parse_lines(&observation(1, "Potassium", "5.1"), &t)
                .drafts
                .len(),
            1
        );
    }

    #[test]
    fn a_one_letter_analyte_is_checked_rather_than_skipped() {
        let t = lines(PANEL_LINES);
        // "K 105" read off the glucose row: potassium 105 is not survivable, and
        // a label too short to look substantial must not skip the check.
        assert_eq!(parse_lines(&observation(7, "K", "105"), &t).dropped, 1);

        // The same label verifies against a line that actually carries it.
        let short = vec!["K    4.1   mmol/L   3.5-5.1".to_string()];
        assert_eq!(
            parse_lines(&observation(1, "K", "4.1"), &short)
                .drafts
                .len(),
            1
        );
    }

    #[test]
    fn free_text_must_overlap_the_line_it_cites() {
        let t = lines(PANEL_LINES);
        // Line 1 is the lab's letterhead. An impression is not hiding in it.
        let invented = r#"{"findings":[{"kind":"document","source_line":1,
            "value_text":"Impression: metastatic carcinoma"}]}"#;
        assert_eq!(parse_lines(invented, &t).dropped, 1);
    }

    #[test]
    fn a_finding_with_nothing_to_check_is_dropped() {
        let t = lines(PANEL_LINES);
        // A code with no label, value, or text says nothing the line can confirm.
        let bare = r#"{"findings":[{"kind":"observation","source_line":5,
            "system":"loinc","code":"2823-3"}]}"#;
        assert_eq!(parse_lines(bare, &t).dropped, 1);
    }

    #[test]
    fn a_finding_with_no_value_is_verified_on_its_label_alone() {
        let transcript = lines(PANEL_LINES);
        let labelled = r#"{"findings":[{"kind":"observation","source_line":3,
            "value_text":"Analyte Result Unit Reference","display":"Analyte"}]}"#;
        assert_eq!(parse_lines(labelled, &transcript).drafts.len(), 1);
    }
}
