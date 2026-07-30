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
//! Its limit is worth stating plainly. The guard reads a line as words and
//! quantities and matches a claim against those: a claimed value must be a whole
//! quantity of the line it cites, and not one end of a range printed there. It
//! does not know which *cell* a quantity came from, so a swap between two
//! results on the same row still reaches the owner's approval queue. It narrows
//! the failure, it does not eliminate it.

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
/// Every claim the finding makes is checked against that one line, and a finding
/// that makes no checkable claim at all is dropped:
///
/// - The cited line must exist. No `source_line`, or one out of range, fails —
///   an unverifiable claim is not a safer claim.
/// - `display`, when it has a word in it, must share a whole token with the
///   line. Overlap rather than equality, so "Serum potassium" still matches a
///   line reading "Potassium" — while "Sodium" does not, which is the case that
///   matters. The overlap has to be on a word that distinguishes the label when
///   the label has one: `Hb A1c` does not verify against a plain `Hb` line.
///   One- and two-letter labels (`K`, `Na`, `β`) carry the check themselves when
///   that is the whole label, rather than being dismissed as too short.
/// - `value_quantity`, when given, must be a whole [`Production`] of the line —
///   or a contiguous run of them, each read exactly as the claim reads it. `13`
///   is therefore not "found" inside `139` and `5` is not found in `.5`; neither
///   bound of a printed range is found on its own, whichever of them carries the
///   unit; and a result that is itself an interval (`0-2`) verifies when quoted
///   whole, and only as printed.
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
    let lexemes = lex(line);
    let mut checked_something = false;

    let display: Vec<String> = lex(&f.display)
        .into_iter()
        .filter(|l| l.text.chars().any(char::is_alphabetic))
        .map(|l| l.text)
        .collect();
    if !display.is_empty() {
        // A label that has a distinguishing word must match on one of them:
        // `Hb A1c` shares `hb` with a plain haemoglobin line, and only `a1c`
        // tells a haemoglobin from an A1c. A one- or two-letter token carries
        // the check by itself only when that is the whole label.
        let distinguishing = display.iter().any(|d| d.chars().count() >= 3);
        let named = display
            .iter()
            .filter(|d| !distinguishing || d.chars().count() >= 3)
            .any(|d| lexemes.iter().any(|l| &l.text == d));
        if !named {
            return false;
        }
        checked_something = true;
    }

    let claimed = productions(&lex(&f.value_quantity));
    if !claimed.is_empty() {
        if !quotes_a_run(&productions(&lexemes), &claimed, line, &f.unit) {
            return false;
        }
        checked_something = true;
    }

    if !f.value_text.trim().is_empty() {
        let text: Vec<String> = lex(&f.value_text).into_iter().map(|l| l.text).collect();
        let quoted = text
            .iter()
            .filter(|w| lexemes.iter().any(|l| &&l.text == w))
            .count();
        // A strict majority, which for one or two tokens means all of them.
        if quoted * 2 <= text.len() {
            return false;
        }
        checked_something = true;
    }

    checked_something
}

/// One lexeme of a line: letters and digits of any script, lowercased, with a
/// decimal point kept only between them.
struct Lexeme {
    text: String,
    /// The raw characters between the previous lexeme and this one, which is
    /// where the dash that prints a range lives.
    gap: String,
    /// Set when digits run straight into letters. See [`Fused`].
    fused: Option<Fused>,
}

/// Digits running straight into letters, which the line by itself cannot read:
/// `139mmol/L` is a quantity and its unit, `5HIAA` is the name of an analyte,
/// and nothing about the characters tells the two apart. The lexer records the
/// numeric reading and where the letters begin; only the finding's own `unit`
/// settles which reading is right, and only where it is printed — see
/// [`unit_is_printed_at`].
struct Fused {
    number: String,
    /// Byte offset into the line where the letters begin.
    unit_at: usize,
}

/// Split a line into lexemes.
fn lex(s: &str) -> Vec<Lexeme> {
    fn flush(
        out: &mut Vec<Lexeme>,
        gap: &mut String,
        current: &mut String,
        fused: &mut Option<Fused>,
    ) {
        if current.is_empty() {
            *fused = None;
            return;
        }
        out.push(Lexeme {
            text: std::mem::take(current),
            gap: std::mem::take(gap),
            fused: fused.take(),
        });
    }

    let mut out: Vec<Lexeme> = Vec::new();
    let mut gap = String::new();
    let mut current = String::new();
    let mut fused: Option<Fused> = None;
    // Periods seen since the last alphanumeric, resolved by what follows them: a
    // single one against a digit is a decimal point, anything else is
    // punctuation and belongs in the gap. Both halves matter — `98.6.` must not
    // keep the full stop, and `.5 mg` must not become `5 mg`, which is ten times
    // the dose on the page.
    let mut dots = 0usize;

    for (i, c) in s.char_indices() {
        if c.is_alphanumeric() {
            let decimal = dots == 1
                && c.is_ascii_digit()
                && current
                    .chars()
                    .next_back()
                    .is_none_or(|prev| prev.is_ascii_digit());
            if decimal {
                // A bare leading point reads as `0.`, so either spelling of the
                // dose quotes back, while the bare digits still do not.
                if current.is_empty() {
                    current.push('0');
                }
                current.push('.');
            } else if dots > 0 {
                flush(&mut out, &mut gap, &mut current, &mut fused);
                for _ in 0..dots {
                    gap.push('.');
                }
            }
            dots = 0;
            if c.is_alphabetic() && fused.is_none() && is_number(&current) {
                fused = Some(Fused {
                    number: current.clone(),
                    unit_at: i,
                });
            }
            current.extend(c.to_lowercase());
        } else if c == '.' {
            dots += 1;
        } else {
            flush(&mut out, &mut gap, &mut current, &mut fused);
            for _ in 0..dots {
                gap.push('.');
            }
            dots = 0;
            gap.push(c);
        }
    }
    flush(&mut out, &mut gap, &mut current, &mut fused);
    out
}

/// One production of a line: a word, or the numbers printed as a single quantity
/// or a single dash-joined range.
///
/// Range-ness lives here, on the production that spans the bounds, rather than
/// being inferred between neighbouring tokens after the fact. That is what makes
/// a printed bound unquotable however its unit is printed: the guard never has
/// to ask whether a dash it can see joined two things it failed to read as
/// numbers, which is how the lower bound of `70-99mg/dL` used to come loose.
struct Production {
    /// The bounds: one number for a quantity, two or more for a printed range.
    /// Empty for a word.
    numbers: Vec<String>,
    /// Where the letters printed against the last number begin, when there are
    /// any. A claim has to account for them to read the number out from under.
    unit_at: Option<usize>,
    /// The production as a single word, when it is one — including `5hiaa`,
    /// whose digits belong to a name until a claim shows otherwise.
    word: Option<String>,
}

/// Group lexemes into productions.
fn productions(lexemes: &[Lexeme]) -> Vec<Production> {
    let mut out = Vec::new();
    let mut i = 0;
    while i < lexemes.len() {
        let Some(first) = bound(&lexemes[i]) else {
            out.push(Production {
                numbers: Vec::new(),
                unit_at: None,
                word: Some(lexemes[i].text.clone()),
            });
            i += 1;
            continue;
        };
        // A dash between two numbers prints a range, however many bounds it runs
        // to and whatever is printed against the last of them.
        let mut numbers = vec![first];
        let mut last = i;
        while let Some(next) = lexemes
            .get(last + 1)
            .filter(|l| is_range_dash(&l.gap))
            .and_then(bound)
        {
            numbers.push(next);
            last += 1;
        }
        out.push(Production {
            numbers,
            unit_at: lexemes[last].fused.as_ref().map(|f| f.unit_at),
            // A dash-joined run of bounds is never also one word.
            word: (last == i).then(|| lexemes[i].text.clone()),
        });
        i = last + 1;
    }
    out
}

/// The number a lexeme opens with, if any: itself, or the digits a name might be
/// hiding behind (`139mmol` → `139`).
fn bound(l: &Lexeme) -> Option<String> {
    if is_number(&l.text) {
        Some(l.text.clone())
    } else {
        l.fused.as_ref().map(|f| f.number.clone())
    }
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

/// Whether the claim appears on the line as a contiguous run of whole
/// productions, each read as the claim reads it.
fn quotes_a_run(printed: &[Production], claimed: &[Production], line: &str, unit: &str) -> bool {
    if claimed.is_empty() || claimed.len() > printed.len() {
        return false;
    }
    (0..=printed.len() - claimed.len()).any(|start| {
        printed[start..start + claimed.len()]
            .iter()
            .zip(claimed)
            .all(|(p, c)| reads_as(p, c, line, unit))
    })
}

/// Whether one printed production is what the claim says is there.
fn reads_as(printed: &Production, claimed: &Production, line: &str, unit: &str) -> bool {
    if claimed.numbers.is_empty() {
        return claimed.word.is_some() && printed.word == claimed.word;
    }
    if printed.numbers != claimed.numbers {
        return false;
    }
    let Some(at) = printed.unit_at else {
        // Nothing is printed against the number, so it is a quantity outright.
        return true;
    };
    // Otherwise the letters are a unit only if the finding's own unit is what is
    // printed there — or if the number is a decimal, which no name begins with.
    printed.numbers.last().is_some_and(|n| n.contains('.')) || unit_is_printed_at(line, at, unit)
}

/// Whether the unit a finding claims is the one printed against its number, from
/// `at`.
///
/// Only a unit written in more than one part may take a number out from under
/// the letters run into it — `mmol/L`, `ug/dL`, `mm[Hg]`, `10*3/uL`. A bare word
/// never can, because nothing on the line tells a bare unit from the start of a
/// name: `5HIAA` claiming a unit of `HIAA` is an analyte, and `24hr` claiming
/// `hr` is a collection window. The price is a dose printed `10mg`, which is
/// dropped rather than certified — the direction this guard errs in.
fn unit_is_printed_at(line: &str, at: usize, unit: &str) -> bool {
    if parts(unit) < 2 {
        return false;
    }
    // A unit is printed against its number, not assembled across the line, so
    // the reading stops at the first space or dash.
    let printed = line[at..]
        .split(|c: char| c.is_whitespace() || c == '-')
        .next()
        .unwrap_or_default();
    !printed.is_empty() && letters_and_digits(printed) == letters_and_digits(unit)
}

/// How many alphanumeric parts a unit is written in: `mmol/L` is two, `HIAA` one.
fn parts(unit: &str) -> usize {
    unit.split(|c: char| !c.is_alphanumeric())
        .filter(|p| !p.is_empty())
        .count()
}

/// The lowercased letters and digits of `s`, so `mmol/L` and `mmol/l` are the
/// same unit however either side punctuates it.
fn letters_and_digits(s: &str) -> Vec<char> {
    s.chars()
        .filter(|c| c.is_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect()
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

    /// The same, carrying the unit in its own field the way the schema asks.
    fn measured(source_line: usize, display: &str, value: &str, unit: &str) -> String {
        format!(
            r#"{{"findings":[{{"kind":"observation","source_line":{source_line},
               "system":"loinc","code":"2823-3","display":"{display}",
               "value_quantity":"{value}","unit":"{unit}"}}]}}"#
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

    /// A period ending a sentence is punctuation, not part of the reading.
    #[test]
    fn terminal_punctuation_does_not_hide_the_thing_it_follows() {
        let t = vec!["Temperature 98.6.".to_string()];
        assert_eq!(
            parse_lines(&observation(1, "Temperature", "98.6"), &t)
                .drafts
                .len(),
            1
        );

        let normal = r#"{"findings":[{"kind":"document","source_line":1,
            "value_text":"Normal"}]}"#;
        let stopped = ["Normal.".to_string()];
        assert_eq!(parse_lines(normal, &stopped).drafts.len(), 1);
    }

    /// Some results *are* an interval — a urine microscopy count is reported as
    /// one. Quoting it whole is quoting the result; quoting one end of it is
    /// still picking a bound out of a printed range.
    #[test]
    fn a_result_that_is_itself_a_range_verifies_whole_but_not_by_halves() {
        let t = vec!["Urine RBC       0-2      /HPF".to_string()];
        assert_eq!(
            parse_lines(&observation(1, "Urine RBC", "0-2"), &t)
                .drafts
                .len(),
            1
        );
        assert_eq!(
            parse_lines(&observation(1, "Urine RBC", "0"), &t).dropped,
            1
        );
        assert_eq!(
            parse_lines(&observation(1, "Urine RBC", "2"), &t).dropped,
            1
        );
    }

    /// A dose is often printed with a bare decimal point. Losing that point
    /// turns .5 mg into 5 mg — a tenfold overdose arriving as a finding the
    /// guard has certified against the page.
    #[test]
    fn a_leading_decimal_point_is_part_of_the_number() {
        let t = vec!["Digoxin   .5 mg   daily".to_string()];
        assert_eq!(parse_lines(&observation(1, "Digoxin", "5"), &t).dropped, 1);

        // Either spelling of the dose that is actually printed verifies.
        assert_eq!(
            parse_lines(&observation(1, "Digoxin", ".5"), &t)
                .drafts
                .len(),
            1
        );
        assert_eq!(
            parse_lines(&observation(1, "Digoxin", "0.5"), &t)
                .drafts
                .len(),
            1
        );

        // And the inverse tenth is not on the page either.
        let whole = vec!["Digoxin   5 mg   daily".to_string()];
        assert_eq!(
            parse_lines(&observation(1, "Digoxin", "0.5"), &whole).dropped,
            1
        );
        assert_eq!(
            parse_lines(&observation(1, "Digoxin", ".5"), &whole).dropped,
            1
        );
    }

    /// Labs print the unit against the number as often as beside it, and the
    /// finding that quotes it back has the two in separate fields.
    #[test]
    fn a_unit_printed_against_the_number_does_not_swallow_it() {
        let t = vec!["Potassium   4.1mmol/L   3.5-5.1".to_string()];
        let claim = r#"{"findings":[{"kind":"observation","source_line":1,
            "system":"loinc","code":"2823-3","display":"Potassium",
            "value_quantity":"4.1","unit":"mmol/L"}]}"#;
        assert_eq!(parse_lines(claim, &t).drafts.len(), 1);
        // Splitting the unit off must not unstick the range beside it.
        assert_eq!(
            parse_lines(&observation(1, "Potassium", "5.1"), &t).dropped,
            1
        );

        // A name that merely begins with digits is not a number and a unit.
        let hiaa = vec!["5HIAA   6 mg".to_string()];
        assert_eq!(parse_lines(&observation(1, "5HIAA", "5"), &hiaa).dropped, 1);
        assert_eq!(
            parse_lines(&observation(1, "5HIAA", "6"), &hiaa)
                .drafts
                .len(),
            1
        );
    }

    /// The integer case of the same printing: `139mmol/L` is a sodium result,
    /// and the finding quoting it carries the unit in its own field.
    #[test]
    fn an_integer_printed_against_its_unit_is_still_a_quantity() {
        let t = vec!["Sodium   139mmol/L   135-145mmol/L".to_string()];
        let claim = r#"{"findings":[{"kind":"observation","source_line":1,
            "system":"loinc","code":"2951-2","display":"Sodium",
            "value_quantity":"139","unit":"mmol/L"}]}"#;
        assert_eq!(parse_lines(claim, &t).drafts.len(), 1);

        // A bound is still a bound with the unit stuck to it.
        let bound = r#"{"findings":[{"kind":"observation","source_line":1,
            "system":"loinc","code":"2951-2","display":"Sodium",
            "value_quantity":"145","unit":"mmol/L"}]}"#;
        assert_eq!(parse_lines(bound, &t).dropped, 1);
    }

    /// Splitting on the unit the *claim* supplies is what makes an integer
    /// result readable, and it is also how a claim could talk an analyte name
    /// apart: `5HIAA` with a claimed unit of `HIAA` leaves a `5` that is not a
    /// result. The finding naming `5HIAA` is the thing that gives it away.
    #[test]
    fn a_claimed_unit_cannot_split_the_analyte_name_it_came_from() {
        let t = vec!["5HIAA   6 mg".to_string()];
        let as_unit = r#"{"findings":[{"kind":"observation","source_line":1,
            "system":"loinc","code":"1690-7","display":"5HIAA",
            "value_quantity":"5","unit":"HIAA"}]}"#;
        assert_eq!(parse_lines(as_unit, &t).dropped, 1);

        // Nor with a real unit, nor with none.
        let mg = r#"{"findings":[{"kind":"observation","source_line":1,
            "system":"loinc","code":"1690-7","display":"5HIAA",
            "value_quantity":"5","unit":"mg"}]}"#;
        assert_eq!(parse_lines(mg, &t).dropped, 1);
        assert_eq!(parse_lines(&observation(1, "5HIAA", "5"), &t).dropped, 1);

        // Not even when a second, genuine label token vouches for the row: it is
        // the label naming the fused token that settles it, not the vouching.
        let vouched = vec!["Urine 5HIAA   6 mg".to_string()];
        let both = r#"{"findings":[{"kind":"observation","source_line":1,
            "system":"loinc","code":"1690-7","display":"Urine 5HIAA",
            "value_quantity":"5","unit":"HIAA"}]}"#;
        assert_eq!(parse_lines(both, &vouched).dropped, 1);

        // The result that is actually printed verifies.
        let real = r#"{"findings":[{"kind":"observation","source_line":1,
            "system":"loinc","code":"1690-7","display":"5HIAA",
            "value_quantity":"6","unit":"mg"}]}"#;
        assert_eq!(parse_lines(real, &t).drafts.len(), 1);
    }

    /// Hb 12.0 g/dL is an ordinary haemoglobin; HbA1c 12.0% is badly
    /// uncontrolled diabetes. `a1c` is the token that tells them apart, so a
    /// label carrying one must not verify on the part it shares with another
    /// analyte.
    #[test]
    fn a_short_token_does_not_stand_in_for_a_longer_label() {
        let t = vec!["Hb   12.0 g/dL".to_string()];
        let a1c = r#"{"findings":[{"kind":"observation","source_line":1,
            "system":"loinc","code":"4548-4","display":"Hb A1c",
            "value_quantity":"12.0","unit":"%"}]}"#;
        assert_eq!(parse_lines(a1c, &t).dropped, 1);

        // The label that is actually printed still verifies.
        assert_eq!(
            parse_lines(&observation(1, "Hb", "12.0"), &t).drafts.len(),
            1
        );
    }

    /// A claim has to have the shape of the thing it quotes: an interval and two
    /// separate numbers are different readings of a row.
    #[test]
    fn a_dashed_claim_and_a_spaced_source_do_not_cross_match() {
        let dashed = vec!["Urine RBC   0-2   /HPF".to_string()];
        let spaced = vec!["Urine RBC   0 2   /HPF".to_string()];

        assert_eq!(
            parse_lines(&observation(1, "Urine RBC", "0 2"), &dashed).dropped,
            1
        );
        assert_eq!(
            parse_lines(&observation(1, "Urine RBC", "0-2"), &spaced).dropped,
            1
        );

        // Quoted as printed, either way, still verifies.
        assert_eq!(
            parse_lines(&observation(1, "Urine RBC", "0-2"), &dashed)
                .drafts
                .len(),
            1
        );
        assert_eq!(
            parse_lines(&observation(1, "Urine RBC", "0 2"), &spaced)
                .drafts
                .len(),
            1
        );
    }

    /// Records are not all Latin script, and a label that tokenizes to nothing
    /// is a finding with nothing to check — dropped for the wrong reason.
    #[test]
    fn a_non_latin_label_is_checked_not_erased() {
        let t = vec!["糖尿病（2型）   血糖 7.2".to_string()];
        let coded = r#"{"findings":[{"kind":"condition","source_line":1,
            "system":"snomed","code":"44054006","display":"糖尿病"}]}"#;
        assert_eq!(parse_lines(coded, &t).drafts.len(), 1);

        let elsewhere = r#"{"findings":[{"kind":"condition","source_line":1,
            "system":"snomed","code":"38341003","display":"高血圧"}]}"#;
        assert_eq!(parse_lines(elsewhere, &t).dropped, 1);

        // Greek survives the same way, and case folds.
        let greek = vec!["β-hCG   5   mIU/mL".to_string()];
        assert_eq!(
            parse_lines(&observation(1, "Β-hCG", "5"), &greek)
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

    /// A claimed unit may only be read where the number it belongs to is
    /// printed. Reading it off the line at large lets a claim take apart a token
    /// it never named: `5HIAA` is an analyte on a sodium row, not a five of
    /// something, and `24hr` is a collection window.
    #[test]
    fn a_claimed_unit_cannot_split_a_token_it_is_not_printed_against() {
        for (line, display, value, unit) in [
            ("Sodium 139 mmol/L 5HIAA 6 mg", "Sodium", "5", "HIAA"),
            ("Sodium 139 mmol/L 24hr urine 1200 mL", "Sodium", "24", "hr"),
            (
                "Glucose 105 mg/dL 2hr postprandial 140 mg/dL",
                "Glucose",
                "2",
                "hr",
            ),
            (
                "Vitamin B12 450 pg/mL 25OHD 42 ng/mL",
                "Vitamin B12",
                "25",
                "OHD",
            ),
            ("Acc# 12345AB Sodium 139 mmol/L", "Sodium", "12345", "AB"),
            // A unit in two parts does not help when it is not what is printed.
            ("Sodium 139 mmol/L 5HIAA 6 mg", "Sodium", "5", "HIAA/24h"),
        ] {
            let t = vec![line.to_string()];
            assert_eq!(
                parse_lines(&measured(1, display, value, unit), &t).dropped,
                1,
                "{line:?} must not yield {value} {unit} for {display}"
            );
        }

        // The results actually printed on those rows still verify.
        let mixed = vec!["Sodium 139 mmol/L 5HIAA 6 mg".to_string()];
        assert_eq!(
            parse_lines(&measured(1, "Sodium", "139", "mmol/L"), &mixed)
                .drafts
                .len(),
            1
        );
        assert_eq!(
            parse_lines(&measured(1, "5HIAA", "6", "mg"), &mixed)
                .drafts
                .len(),
            1
        );
    }

    /// The short-label half of the attached-unit printing. A one- or two-letter
    /// analyte is as entitled to a unit printed against its number as a spelled
    /// out one; `Na 139mmol/L` is an ordinary sodium result.
    #[test]
    fn a_short_label_reads_an_integer_against_its_unit_too() {
        for (line, display, value, unit) in [
            ("Na 139mmol/L", "Na", "139", "mmol/L"),
            ("K 4mmol/L", "K", "4", "mmol/L"),
            ("Cl 104mmol/L", "Cl", "104", "mmol/L"),
            ("Fe 85ug/dL", "Fe", "85", "ug/dL"),
            ("Hb 12g/dL", "Hb", "12", "g/dL"),
            ("T4 8ug/dL", "T4", "8", "ug/dL"),
        ] {
            let t = vec![line.to_string()];
            assert_eq!(
                parse_lines(&measured(1, display, value, unit), &t)
                    .drafts
                    .len(),
                1,
                "{line:?} should read as {value} {unit}"
            );
        }

        // Still only the number that is printed there.
        let na = vec!["Na 139mmol/L".to_string()];
        assert_eq!(
            parse_lines(&measured(1, "Na", "13", "mmol/L"), &na).dropped,
            1
        );
    }

    /// A printed bound is unquotable from either end, whichever end carries the
    /// unit. Reading the dash *between* two tokens made this depend on both
    /// bounds lexing as numbers, so an upper bound printed `99mg/dL` was not one,
    /// the join vanished, and the lower bound became quotable as a result.
    #[test]
    fn a_bound_stays_a_bound_when_the_other_bound_carries_the_unit() {
        let fused = vec!["Glucose 105 mg/dL Ref 70-99mg/dL".to_string()];
        for (value, unit) in [("70", "mg/dL"), ("99", "mg/dL"), ("70", ""), ("99", "")] {
            assert_eq!(
                parse_lines(&measured(1, "Glucose", value, unit), &fused).dropped,
                1,
                "{value} is a reference bound, not a result"
            );
        }
        // The result on that row still verifies.
        assert_eq!(
            parse_lines(&measured(1, "Glucose", "105", "mg/dL"), &fused)
                .drafts
                .len(),
            1
        );

        // The spaced printing of the same row, and the sodium equivalent.
        let spaced = vec!["Glucose 105 mg/dL Ref 70-99 mg/dL".to_string()];
        assert_eq!(
            parse_lines(&measured(1, "Glucose", "70", "mg/dL"), &spaced).dropped,
            1
        );
        let sodium = vec!["Sodium 139mmol/L 135-145mmol/L".to_string()];
        assert_eq!(
            parse_lines(&measured(1, "Sodium", "135", "mmol/L"), &sodium).dropped,
            1
        );
        assert_eq!(
            parse_lines(&measured(1, "Sodium", "145", "mmol/L"), &sodium).dropped,
            1
        );
        assert_eq!(
            parse_lines(&measured(1, "Sodium", "139", "mmol/L"), &sodium)
                .drafts
                .len(),
            1
        );
    }
}
