//! Scoring one reader's run over one fixture page against that page's answer key.
//!
//! Everything here is a pure function over already-extracted drafts and an
//! already-loaded answer key: no endpoint, no recognizer, no images. That is
//! what lets the part of this harness that decides pass/fail be unit-tested,
//! while the part that needs a model stays a manual run.
//!
//! ## The two failures, and why only one of them is a gate
//!
//! A wrong reading is not a uniform thing. Missing `Glucose 105` entirely leaves
//! the record incomplete, which the owner can see. Reporting `Potassium 139` —
//! a real analyte from one row wearing a real value from another — leaves the
//! record *confidently wrong*, and 139 mmol/L of potassium is not a value a
//! human reviewer reads as a typo. It is the failure that flattening a table
//! row-major produces, it survives every schema check (see
//! `fixtures/ocr/cmp-panel.cross-row.answer.json`), and it is the one the ship
//! gate is set at zero for. Precision and recall are reported alongside because
//! a reader can reach zero cross-row by reading nothing at all.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use svastha_core::event::EventValue;
use svastha_import::extract::{Extraction, Outcome};
use svastha_import::EventDraft;

/// One printed result row from a fixture's `.truth.json`.
#[derive(Debug, Clone, Deserialize)]
pub struct Expected {
    pub analyte: String,
    pub value: String,
    #[serde(default)]
    pub unit: String,
}

/// A fixture's answer key, as committed beside its PNG.
#[derive(Debug, Clone, Deserialize)]
pub struct Truth {
    pub page: String,
    #[serde(default)]
    pub note: String,
    #[serde(default)]
    pub hazard: String,
    pub expected: Vec<Expected>,
}

/// One (analyte, value, unit) result a reader's run actually proposed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Proposed {
    pub analyte: String,
    pub value: String,
    pub unit: String,
}

/// What one proposed pair turned out to be.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Class {
    /// The pair is on the page, and this is the first proposal to claim it.
    Correct,
    /// The analyte and the value are both on the page but on **different rows**.
    /// The gate.
    CrossRow,
    /// The same correct pair proposed twice. Counted against precision (a
    /// duplicate proposal is still a spurious event the owner has to triage)
    /// but deliberately not as a cross-row: nothing was mis-associated.
    Duplicate,
    /// Neither a pair on the page nor a recognizable mis-pairing — a misread
    /// label, an invented value, or a reference-range bound read as a result.
    Spurious,
}

/// The score for one reader over one fixture.
#[derive(Debug, Clone, Serialize)]
pub struct Score {
    pub expected: usize,
    pub proposed: usize,
    pub correct: usize,
    pub cross_row: usize,
    pub duplicate: usize,
    pub spurious: usize,
    /// Rows on the page that nothing correctly claimed.
    pub missed: Vec<String>,
    /// What the coding step made of the transcript. `AllDropped` here is a
    /// success story, not a failure: it means the source-line guard caught
    /// everything the model got wrong.
    pub outcome: Outcome,
    /// Set when the reader itself produced no usable transcript, which is a
    /// different thing from a page the coder found nothing on.
    pub unreadable: Option<String>,
}

impl Score {
    pub fn precision(&self) -> Option<f64> {
        (self.proposed > 0).then(|| self.correct as f64 / self.proposed as f64)
    }

    pub fn recall(&self) -> Option<f64> {
        (self.expected > 0).then(|| self.correct as f64 / self.expected as f64)
    }
}

/// The score for a reader that could not read the page at all. Distinct from a
/// zero score over a read page: "couldn't read this" is the honest outcome the
/// whole pipeline is built to be able to say, and a harness that recorded it as
/// 0/0 precision would flatter a reader that simply declined.
pub fn unreadable(truth: &Truth, why: String) -> Score {
    Score {
        expected: truth.expected.len(),
        proposed: 0,
        correct: 0,
        cross_row: 0,
        duplicate: 0,
        spurious: 0,
        missed: truth.expected.iter().map(|e| e.analyte.clone()).collect(),
        outcome: Outcome::NothingOnThePage,
        unreadable: Some(why),
    }
}

/// Recover a measured result a draft asserts. A coded condition with no
/// measurement is out of scope for answer keys made of result rows, but a
/// quantity without an analyte code is still a spurious proposed event and must
/// not disappear from precision.
pub fn proposed_from(draft: &EventDraft) -> Option<Proposed> {
    let Some(EventValue::Quantity { value, unit }) = draft.value.as_ref() else {
        return None;
    };
    let analyte = draft
        .code
        .as_ref()
        .map(|code| code.display.clone().unwrap_or_else(|| code.code.clone()))
        .unwrap_or_default();
    let unit = unit
        .as_ref()
        .map(|unit| unit.code.clone())
        .unwrap_or_default();
    Some(Proposed {
        analyte,
        value: value.clone(),
        unit,
    })
}

/// Fold case, punctuation, and spacing out of a label so `Serum Potassium`,
/// `serum potassium` and `SerumPotassium` compare equal.
///
/// Deliberately not fuzzy beyond that. Edit-distance matching would let
/// `Sodium` match `Codium` and quietly turn a misread label into a hit, which
/// is the opposite of what a measurement harness is for — the number this
/// reports has to be the number a reader earned.
fn fold(text: &str) -> String {
    text.chars()
        .filter(|c| c.is_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect()
}

/// Words that name the specimen or restate the measurement rather than saying
/// *which* measurement it is. A model told to copy "the human label exactly as
/// written" mostly does, but "Serum Potassium" for a line reading "Potassium"
/// is common enough that scoring it as a miss would understate every reader.
///
/// The list is short on purpose. Every word added to it is a word that stops
/// distinguishing two analytes, and the failure mode of a too-generous list is
/// a harness that reports a reader as more accurate than it is.
const QUALIFIERS: &[&str] = &[
    "serum",
    "plasma",
    "blood",
    "whole",
    "urine",
    "level",
    "concentration",
    "measurement",
    "in",
    "of",
    "the",
];

/// The part of a label that actually names the analyte: its tokens with the
/// qualifiers dropped.
fn distinguishing(label: &str) -> String {
    let kept: Vec<String> = label
        .split_whitespace()
        .map(fold)
        .filter(|t| !t.is_empty() && !QUALIFIERS.contains(&t.as_str()))
        .collect();
    kept.concat()
}

/// Whether a proposed label names an expected row's analyte.
///
/// Equal once case, punctuation and specimen qualifiers are set aside — so
/// `Serum Potassium` matches `Potassium`, and `Hb A1c` does **not** match `Hb`,
/// because `A1c` is not a qualifier: it is the word that says which test this
/// is. That asymmetry is the whole difficulty, and getting it wrong in the
/// generous direction would let a misread label score as a hit.
fn analyte_eq(expected: &str, proposed: &str) -> bool {
    let (a, b) = (fold(expected), fold(proposed));
    if a.is_empty() || b.is_empty() {
        return false;
    }
    if a == b {
        return true;
    }
    let (ca, cb) = (distinguishing(expected), distinguishing(proposed));
    !ca.is_empty() && ca == cb
}

/// Units are compared case-insensitively with whitespace removed, but their
/// punctuation stays meaningful. A blank unit only matches a blank unit.
fn unit_eq(expected: &str, proposed: &str) -> bool {
    let normalize = |unit: &str| {
        unit.chars()
            .filter(|character| !character.is_whitespace())
            .flat_map(char::to_lowercase)
            .collect::<String>()
    };
    normalize(expected) == normalize(proposed)
}

/// The normalized sign, whole and fractional parts of a base-10 number. Empty
/// whole and fraction parts stand for zero, so `4.10` and `4.1` compare equal
/// without ever rounding through a binary float.
fn decimal_parts(value: &str) -> Option<(bool, &str, &str)> {
    let (negative, unsigned) = match value.strip_prefix('-') {
        Some(unsigned) => (true, unsigned),
        None => (false, value.strip_prefix('+').unwrap_or(value)),
    };
    let (whole, fraction) = unsigned.split_once('.').unwrap_or((unsigned, ""));
    if (whole.is_empty() && fraction.is_empty())
        || !whole.bytes().all(|byte| byte.is_ascii_digit())
        || !fraction.bytes().all(|byte| byte.is_ascii_digit())
    {
        return None;
    }
    let whole = whole.trim_start_matches('0');
    let fraction = fraction.trim_end_matches('0');
    Some((
        negative && !(whole.is_empty() && fraction.is_empty()),
        whole,
        fraction,
    ))
}

/// Numeric equality on the printed form. `4.1` and `4.10` are the same reading
/// and both are correct; `4.1` and `41` are not. Empty and non-finite numbers
/// never form a result-row match.
fn value_eq(expected: &str, proposed: &str) -> bool {
    let (a, b) = (expected.trim(), proposed.trim());
    if a.is_empty() || b.is_empty() {
        return false;
    }
    let is_non_finite = |value: &str| {
        let unsigned = value.trim_start_matches(['+', '-']);
        unsigned.eq_ignore_ascii_case("nan")
            || unsigned.eq_ignore_ascii_case("inf")
            || unsigned.eq_ignore_ascii_case("infinity")
    };
    if is_non_finite(a) || is_non_finite(b) {
        return false;
    }
    match (decimal_parts(a), decimal_parts(b)) {
        (Some(a), Some(b)) => a == b,
        (None, None) => a == b,
        _ => false,
    }
}

/// Classify one proposal against the answer key. `claimed[i]` tracks which
/// expected rows have already been correctly claimed, so a second proposal of
/// the same row scores as a duplicate rather than a second hit.
fn classify(p: &Proposed, expected: &[Expected], claimed: &mut [bool]) -> Class {
    let exact: Vec<usize> = expected
        .iter()
        .enumerate()
        .filter(|(_, e)| {
            analyte_eq(&e.analyte, &p.analyte)
                && value_eq(&e.value, &p.value)
                && unit_eq(&e.unit, &p.unit)
        })
        .map(|(i, _)| i)
        .collect();

    if !exact.is_empty() {
        return match exact.iter().find(|&&i| !claimed[i]) {
            Some(&i) => {
                claimed[i] = true;
                Class::Correct
            }
            // Every row this pair could be is already claimed.
            None => Class::Duplicate,
        };
    }

    // Not a row on the page. It is the *dangerous* kind only if the analyte
    // and the complete value-plus-unit result are real and came from different
    // rows — that is a mis-association, as opposed to a misread label, unit, or
    // invented number.
    let analyte_on_page = expected.iter().any(|e| analyte_eq(&e.analyte, &p.analyte));
    let result_on_page = expected
        .iter()
        .any(|e| value_eq(&e.value, &p.value) && unit_eq(&e.unit, &p.unit));
    if analyte_on_page && result_on_page {
        Class::CrossRow
    } else {
        Class::Spurious
    }
}

/// Score one extraction against one fixture's answer key.
pub fn score(truth: &Truth, extraction: &Extraction) -> Score {
    let proposals: Vec<Proposed> = extraction.drafts.iter().filter_map(proposed_from).collect();
    let mut claimed = vec![false; truth.expected.len()];
    let mut counts: BTreeMap<&str, usize> = BTreeMap::new();

    for p in &proposals {
        let class = classify(p, &truth.expected, &mut claimed);
        let key = match class {
            Class::Correct => "correct",
            Class::CrossRow => "cross_row",
            Class::Duplicate => "duplicate",
            Class::Spurious => "spurious",
        };
        *counts.entry(key).or_default() += 1;
    }

    let missed = truth
        .expected
        .iter()
        .zip(&claimed)
        .filter(|(_, &c)| !c)
        .map(|(e, _)| e.analyte.clone())
        .collect();

    Score {
        expected: truth.expected.len(),
        proposed: proposals.len(),
        correct: counts.get("correct").copied().unwrap_or(0),
        cross_row: counts.get("cross_row").copied().unwrap_or(0),
        duplicate: counts.get("duplicate").copied().unwrap_or(0),
        spurious: counts.get("spurious").copied().unwrap_or(0),
        missed,
        outcome: extraction.outcome(),
        unreadable: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn truth() -> Truth {
        Truth {
            page: "cmp-panel.png".into(),
            note: String::new(),
            hazard: String::new(),
            expected: vec![
                row("Sodium", "139", "mmol/L"),
                row("Potassium", "4.1", "mmol/L"),
                row("Chloride", "104", "mmol/L"),
                row("Glucose", "105", "mg/dL"),
                row("Creatinine", "0.9", "mg/dL"),
            ],
        }
    }

    fn row(analyte: &str, value: &str, unit: &str) -> Expected {
        Expected {
            analyte: analyte.into(),
            value: value.into(),
            unit: unit.into(),
        }
    }

    /// The transcript of the committed `cmp-panel.png`, as stage A produces it.
    /// Canned so these tests never touch a recognizer.
    fn lines() -> Vec<String> {
        [
            "Springfield Community Laboratory",
            "Patient: Synthetic Test",
            "Collected: 2026-01-14",
            "Comprehensive Metabolic Panel",
            "Analyte Result Unit Reference",
            "Sodium 139 mmol/L 135-145",
            "Potassium 4.1 mmol/L 3.5-5.1",
            "Chloride 104 mmol/L 98-107",
            "Glucose 105 mg/dL 70-99",
            "Creatinine 0.9 mg/dL 0.6-1.2",
        ]
        .into_iter()
        .map(str::to_string)
        .collect()
    }

    fn finding(line: usize, display: &str, value: &str, unit: &str) -> String {
        format!(
            r#"{{"kind":"observation","source_line":{line},"system":"http://loinc.org",
               "code":"2951-2","display":"{display}","value_quantity":"{value}",
               "unit":"{unit}","effective_at":"2026-01-14","confidence":0.9}}"#
        )
    }

    fn answer(findings: &[String]) -> String {
        format!(r#"{{"findings":[{}]}}"#, findings.join(","))
    }

    #[test]
    fn a_perfect_read_scores_one_and_one() {
        let a = answer(&[
            finding(6, "Sodium", "139", "mmol/L"),
            finding(7, "Potassium", "4.1", "mmol/L"),
            finding(8, "Chloride", "104", "mmol/L"),
            finding(9, "Glucose", "105", "mg/dL"),
            finding(10, "Creatinine", "0.9", "mg/dL"),
        ]);
        let s = score(
            &truth(),
            &svastha_import::extract::parse_lines(&a, &lines()),
        );
        assert_eq!(s.correct, 5);
        assert_eq!(s.cross_row, 0);
        assert_eq!(s.precision(), Some(1.0));
        assert_eq!(s.recall(), Some(1.0));
        assert!(s.missed.is_empty());
        assert_eq!(s.outcome, Outcome::Proposed);
    }

    /// The whole point of the harness: a value lifted from another row has to
    /// be counted as its own class, not blended into precision.
    #[test]
    fn a_value_from_another_row_counts_as_cross_row() {
        // "Potassium 139" — a real analyte and a real value from the row above.
        // Cited against the Potassium line so it reaches the scorer at all;
        // the guard drops it when the line does not bear it out, which is the
        // case the next test covers.
        let p = Proposed {
            analyte: "Potassium".into(),
            value: "139".into(),
            unit: "mmol/L".into(),
        };
        let t = truth();
        let mut claimed = vec![false; t.expected.len()];
        assert_eq!(classify(&p, &t.expected, &mut claimed), Class::CrossRow);
    }

    /// The scorer must agree with the guard the pipeline actually ships: an
    /// answer whose findings cite lines that do not bear them out reaches the
    /// scorer as *nothing proposed*, so it can never score as cross-row.
    #[test]
    fn the_source_line_guard_drops_cross_row_findings_before_scoring() {
        // Every finding here is schema-valid and mis-associated.
        let a = answer(&[
            finding(7, "Potassium", "139", "mmol/L"),
            finding(6, "Sodium", "4.1", "mmol/L"),
        ]);
        let extraction = svastha_import::extract::parse_lines(&a, &lines());
        let s = score(&truth(), &extraction);
        assert_eq!(s.proposed, 0, "the guard should have dropped both");
        assert_eq!(s.cross_row, 0);
        assert_eq!(s.outcome, Outcome::AllDropped);
        // ...and that is precisely what verification buys: unverified, the same
        // answer proposes both mis-associations.
        let unguarded = score(&truth(), &svastha_import::extract::parse(&a));
        assert_eq!(unguarded.cross_row, 2);
    }

    /// A reference-range bound read as the result is wrong but is not a
    /// mis-association, so it must not consume the gate's budget.
    #[test]
    fn a_range_bound_read_as_a_result_is_spurious_not_cross_row() {
        let p = Proposed {
            analyte: "Sodium".into(),
            value: "135".into(),
            unit: "mmol/L".into(),
        };
        let t = truth();
        let mut claimed = vec![false; t.expected.len()];
        assert_eq!(classify(&p, &t.expected, &mut claimed), Class::Spurious);
    }

    #[test]
    fn an_invented_analyte_is_spurious() {
        let p = Proposed {
            analyte: "Magnesium".into(),
            value: "139".into(),
            unit: "mmol/L".into(),
        };
        let t = truth();
        let mut claimed = vec![false; t.expected.len()];
        assert_eq!(classify(&p, &t.expected, &mut claimed), Class::Spurious);
    }
    #[test]
    fn a_quantity_without_an_analyte_code_is_spurious() {
        let a = r#"{"findings":[{"kind":"observation","source_line":6,"display":"Sodium","value_quantity":"139","unit":"mmol/L","confidence":0.9}]}"#;
        let s = score(&truth(), &svastha_import::extract::parse_lines(a, &lines()));

        assert_eq!(s.proposed, 1);
        assert_eq!(s.correct, 0);
        assert_eq!(s.spurious, 1);
    }

    #[test]
    fn a_wrong_unit_is_not_a_correct_row() {
        let a = answer(&[finding(6, "Sodium", "139", "mg/dL")]);
        let s = score(&truth(), &svastha_import::extract::parse(&a));

        assert_eq!(s.proposed, 1);
        assert_eq!(s.correct, 0);
        assert_eq!(s.spurious, 1);
    }

    #[test]
    fn punctuation_only_units_remain_matchable() {
        assert!(unit_eq("%", "%"));
        assert!(unit_eq("mg/dL", "mg / dl"));
    }

    #[test]
    fn the_same_row_proposed_twice_is_a_duplicate_not_a_second_hit() {
        let t = truth();
        let mut claimed = vec![false; t.expected.len()];
        let p = Proposed {
            analyte: "Sodium".into(),
            value: "139".into(),
            unit: "mmol/L".into(),
        };
        assert_eq!(classify(&p, &t.expected, &mut claimed), Class::Correct);
        assert_eq!(classify(&p, &t.expected, &mut claimed), Class::Duplicate);
    }

    #[test]
    fn a_qualified_label_still_matches_its_row() {
        assert!(analyte_eq("Potassium", "Serum Potassium"));
        assert!(analyte_eq("Potassium", "potassium"));
        assert!(analyte_eq("Glucose", "Plasma Glucose"));
        assert!(analyte_eq("Sodium", "sodium (serum)"));
    }

    /// The generous direction is the dangerous one: a word that narrows a label
    /// to a *different* test must not be treated as noise, or a misread label
    /// scores as a hit and the harness overstates the reader.
    #[test]
    fn a_narrowing_word_is_not_a_qualifier() {
        assert!(!analyte_eq("Hb", "Hb A1c"));
        assert!(!analyte_eq("Hemoglobin", "Hemoglobin A1c"));
        assert!(!analyte_eq("Sodium", "Potassium"));
        assert!(!analyte_eq("Glucose", "Glucose Tolerance"));
    }

    #[test]
    fn numeric_equality_rejects_empty_and_non_finite_values() {
        assert!(value_eq("4.1", "4.10"));
        assert!(value_eq("139", "139"));
        assert!(!value_eq("4.1", "41"));
        assert!(!value_eq("0.9", "9"));
        assert!(!value_eq("", ""));
        assert!(!value_eq("NaN", "NaN"));
        assert!(!value_eq("9007199254740992", "9007199254740993"));
    }

    /// Recall has to fall when rows go unread, and the missed rows have to be
    /// named — a bare number gives a reviewer nothing to act on.
    #[test]
    fn unread_rows_lower_recall_and_are_named() {
        let a = answer(&[finding(6, "Sodium", "139", "mmol/L")]);
        let s = score(
            &truth(),
            &svastha_import::extract::parse_lines(&a, &lines()),
        );
        assert_eq!(s.correct, 1);
        assert_eq!(s.recall(), Some(0.2));
        assert_eq!(s.precision(), Some(1.0));
        assert_eq!(
            s.missed,
            vec!["Potassium", "Chloride", "Glucose", "Creatinine"]
        );
    }

    /// A page no reader could transcribe must not look like a clean sweep.
    #[test]
    fn an_unreadable_page_scores_zero_recall_and_names_every_row() {
        let s = unreadable(&truth(), "no text detected".into());
        assert_eq!(s.recall(), Some(0.0));
        assert_eq!(
            s.precision(),
            None,
            "nothing was proposed to be precise about"
        );
        assert_eq!(s.missed.len(), 5);
        assert!(s.unreadable.is_some());
    }

    /// A draft with no measurement is not scored either way — the answer key is
    /// made of result rows, so a coded condition is simply out of scope.
    #[test]
    fn a_draft_with_no_quantity_is_not_scored() {
        let a = r#"{"findings":[{"kind":"condition","source_line":4,"display":"Comprehensive Metabolic Panel","system":"http://snomed.info/sct","code":"1234","confidence":0.5}]}"#;
        let s = score(&truth(), &svastha_import::extract::parse_lines(a, &lines()));
        assert_eq!(s.proposed, 0);
        assert_eq!(s.spurious, 0);
    }
}
