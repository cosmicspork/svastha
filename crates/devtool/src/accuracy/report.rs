//! Turning the scores into something a reviewer can act on: a table per
//! reader × fixture, and a verdict per gate.
//!
//! The verdicts are the reason this harness exists. A table of numbers invites
//! a reader to find the story they came for; a line that says
//! `browser default-on gate: FAIL — cross-row=2 on tight-rows-panel` does not.

use serde::Serialize;
use std::collections::BTreeMap;

use super::reader::Reader;
use super::score::Score;

/// One cell of the matrix: what one reader scored on one fixture.
#[derive(Debug, Clone, Serialize)]
pub struct Run {
    pub fixture: String,
    pub reader: Reader,
    pub score: Score,
}

/// A ship gate, and whether this run cleared it.
#[derive(Debug, Clone, Serialize)]
pub struct Gate {
    pub name: String,
    /// `None` when the run could not decide — the reader never ran, or it ran
    /// and proposed nothing. Neither is a pass: an unmeasured gate reported as
    /// cleared is exactly how an ungated default gets flipped.
    pub passed: Option<bool>,
    pub detail: String,
    /// Informational lines carry numbers for a human decision and never gate.
    pub informational: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct Report {
    pub runs: Vec<Run>,
    pub gates: Vec<Gate>,
    /// Readers that could not be run, and why. Kept in the report so a JSON
    /// consumer sees the difference between "scored zero" and "never ran".
    pub skipped: Vec<String>,
}

/// The cross-row gate for one reader, over **every** fixture including the
/// hand-style ones.
///
/// Handwriting is deliberately in scope here even though neither reader claims
/// to support it, because the claim `docs/ROADMAP.md` actually makes is that a
/// handwritten page "answers couldn't read this page rather than guessing". A
/// reader that instead emits a confident mis-pairing off a page it cannot read
/// has broken that promise, and the gate is the place that shows up.
fn cross_row_gate(name: &str, reader: Reader, runs: &[Run], fixture_names: &[String]) -> Gate {
    let gate = |passed, detail| Gate {
        name: name.to_string(),
        passed,
        detail,
        informational: false,
    };

    let mine: Vec<&Run> = runs.iter().filter(|r| r.reader == reader).collect();
    if mine.is_empty() {
        return gate(
            None,
            format!("{reader} did not run — nothing was measured, so nothing is cleared"),
        );
    }

    let offenders: Vec<String> = mine
        .iter()
        .filter(|r| r.score.cross_row > 0)
        .map(|r| format!("cross-row={} on {}", r.score.cross_row, r.fixture))
        .collect();
    if !offenders.is_empty() {
        return gate(Some(false), offenders.join(", "));
    }

    if fixture_names.is_empty() {
        return gate(
            None,
            "no fixture suite was supplied — nothing can clear this gate".to_string(),
        );
    }

    let mut runs_per_fixture: BTreeMap<&str, usize> = BTreeMap::new();
    for run in &mine {
        *runs_per_fixture.entry(run.fixture.as_str()).or_default() += 1;
    }
    let missing: Vec<&str> = fixture_names
        .iter()
        .map(String::as_str)
        .filter(|fixture| !runs_per_fixture.contains_key(*fixture))
        .collect();
    let repeated: Vec<String> = runs_per_fixture
        .iter()
        .filter(|(_, count)| **count > 1)
        .map(|(fixture, count)| format!("{fixture} ({count} runs)"))
        .collect();
    let unexpected: Vec<&str> = runs_per_fixture
        .keys()
        .copied()
        .filter(|fixture| {
            !fixture_names
                .iter()
                .any(|expected| expected.as_str() == *fixture)
        })
        .collect();
    if !missing.is_empty() || !repeated.is_empty() || !unexpected.is_empty() {
        let mut detail = Vec::new();
        if !missing.is_empty() {
            detail.push(format!("missing {}", missing.join(", ")));
        }
        if !repeated.is_empty() {
            detail.push(format!("multiple runs for {}", repeated.join(", ")));
        }
        if !unexpected.is_empty() {
            detail.push(format!("unexpected {}", unexpected.join(", ")));
        }
        return gate(
            None,
            format!(
                "incomplete fixture coverage — {}; a partial run cannot clear this gate",
                detail.join("; ")
            ),
        );
    }

    // Zero cross-row is trivially true of a reader that proposed nothing, so on
    // its own it is not evidence of anything. A page the reader was *expected*
    // to read and did not is therefore inconclusive rather than clear — this is
    // the difference between "it never mis-associated" and "it never spoke".
    // Hand-style pages are exempt: declining those is the documented, correct
    // answer (`docs/ROADMAP.md`), not a gap in the measurement.
    let silent: Vec<&str> = mine
        .iter()
        .filter(|r| !is_handwriting(&r.fixture) && r.score.correct == 0)
        .map(|r| r.fixture.as_str())
        .collect();
    if !silent.is_empty() {
        return gate(
            None,
            format!(
                "zero cross-row, but nothing was proposed on {} — a reader that reads nothing \
                 cannot mis-associate anything, so this does not clear the gate",
                silent.join(", ")
            ),
        );
    }

    let worst = mine
        .iter()
        .filter_map(|r| r.score.recall().map(|v| (r, v)))
        .min_by(|a, b| a.1.total_cmp(&b.1));
    gate(
        Some(true),
        match worst {
            Some((r, v)) => format!(
                "zero cross-row across {} fixtures (lowest recall {:.2} on {})",
                mine.len(),
                v,
                r.fixture
            ),
            None => format!("zero cross-row across {} fixtures", mine.len()),
        },
    )
}

/// Hand-style fixtures are named by convention so the gate can exempt them —
/// see `web/scripts/accuracy/fixtures.ts`.
fn is_handwriting(fixture: &str) -> bool {
    fixture.starts_with("handwritten-")
}

/// The handwriting line is **not** a pass/fail. Whether to support handwriting
/// at all is the owner's call (`docs/ROADMAP.md` currently says no); this only
/// puts numbers under that decision instead of leaving it to intuition.
fn handwriting_note(runs: &[Run]) -> Gate {
    let hand: Vec<&Run> = runs.iter().filter(|r| is_handwriting(&r.fixture)).collect();
    if hand.is_empty() {
        return Gate {
            name: "handwriting decision".to_string(),
            passed: None,
            detail: "no hand-style fixtures ran".to_string(),
            informational: true,
        };
    }
    let parts: Vec<String> = hand
        .iter()
        .map(|r| {
            let recall = r
                .score
                .recall()
                .map(|v| format!("{v:.2}"))
                .unwrap_or_else(|| "-".into());
            let read = match &r.score.unreadable {
                Some(_) => "declined",
                None => "read",
            };
            format!("{}/{}: recall {recall} ({read})", r.reader, r.fixture)
        })
        .collect();
    Gate {
        name: "handwriting decision".to_string(),
        passed: None,
        detail: parts.join("; "),
        informational: true,
    }
}

impl Report {
    pub fn new(runs: Vec<Run>, skipped: Vec<String>, fixture_names: &[String]) -> Self {
        let gates = vec![
            cross_row_gate(
                "browser default-on gate",
                Reader::Tesseract,
                &runs,
                fixture_names,
            ),
            cross_row_gate(
                "node unattended / bulk-read gate",
                Reader::Ocrs,
                &runs,
                fixture_names,
            ),
            handwriting_note(&runs),
        ];
        Self {
            runs,
            gates,
            skipped,
        }
    }

    /// The human-readable report.
    pub fn render(&self) -> String {
        let mut out = String::new();
        out.push_str("fixture              reader      prec   recall  cross  dup  spur  outcome\n");
        out.push_str(
            "---------------------------------------------------------------------------\n",
        );

        for run in &self.runs {
            let s = &run.score;
            let fmt = |v: Option<f64>| {
                v.map(|x| format!("{x:.2}"))
                    .unwrap_or_else(|| "  - ".to_string())
            };
            let outcome = match &s.unreadable {
                // The reader never produced a transcript, so the coding
                // outcome below it would be meaningless.
                Some(why) => format!("unreadable ({why})"),
                None => format!("{:?}", s.outcome).to_lowercase(),
            };
            out.push_str(&format!(
                "{:<20} {:<11} {:>4}   {:>4}   {:>4} {:>4}  {:>4}  {}\n",
                run.fixture,
                run.reader.to_string(),
                fmt(s.precision()),
                fmt(s.recall()),
                s.cross_row,
                s.duplicate,
                s.spurious,
                outcome,
            ));
            if !s.missed.is_empty() {
                out.push_str(&format!("{:>21}missed: {}\n", "", s.missed.join(", ")));
            }
        }

        if !self.skipped.is_empty() {
            out.push_str("\nnot run:\n");
            for s in &self.skipped {
                out.push_str(&format!("  - {s}\n"));
            }
        }

        out.push('\n');
        for gate in &self.gates {
            let verdict = match (gate.informational, gate.passed) {
                (true, _) => "INFO",
                (false, Some(true)) => "PASS",
                (false, Some(false)) => "FAIL",
                (false, None) => "INCONCLUSIVE",
            };
            out.push_str(&format!("{}: {} — {}\n", gate.name, verdict, gate.detail));
        }
        out
    }

    /// Whether every gate cleared. Inconclusive is not clear — see
    /// [`Gate::passed`] — so this is false unless every gate was measured and
    /// passed.
    pub fn all_gates_pass(&self) -> bool {
        self.gates
            .iter()
            .filter(|g| !g.informational)
            .all(|g| g.passed == Some(true))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::accuracy::score::{Expected, Truth};
    use svastha_import::extract::Outcome;

    fn truth(n: usize) -> Truth {
        Truth {
            page: "p.png".into(),
            note: String::new(),
            hazard: String::new(),
            expected: (0..n)
                .map(|i| Expected {
                    analyte: format!("A{i}"),
                    value: format!("{i}"),
                    unit: String::new(),
                })
                .collect(),
        }
    }

    fn run(fixture: &str, reader: Reader, cross_row: usize) -> Run {
        Run {
            fixture: fixture.into(),
            reader,
            score: Score {
                expected: 5,
                proposed: 5,
                correct: 5 - cross_row,
                cross_row,
                duplicate: 0,
                spurious: 0,
                missed: vec![],
                outcome: Outcome::Proposed,
                unreadable: None,
            },
        }
    }

    /// A reader that ran and proposed nothing at all.
    fn silent(fixture: &str, reader: Reader) -> Run {
        Run {
            fixture: fixture.into(),
            reader,
            score: Score {
                expected: 5,
                proposed: 0,
                correct: 0,
                cross_row: 0,
                duplicate: 0,
                spurious: 0,
                missed: vec!["Sodium".into()],
                outcome: Outcome::NothingOnThePage,
                unreadable: None,
            },
        }
    }

    #[test]
    fn a_clean_sweep_passes_its_gate() {
        let report = Report::new(
            vec![run("cmp-panel", Reader::Tesseract, 0)],
            vec![],
            &["cmp-panel".to_string()],
        );
        let gate = &report.gates[0];
        assert_eq!(gate.passed, Some(true));
        assert!(report.render().contains("browser default-on gate: PASS"));
    }

    /// The verdict has to name the fixture and the count, because that is the
    /// line that ends up in a PR description.
    #[test]
    fn one_cross_row_fails_the_gate_and_names_where() {
        let report = Report::new(
            vec![
                run("cmp-panel", Reader::Tesseract, 0),
                run("tight-rows-panel", Reader::Tesseract, 2),
            ],
            vec![],
            &["cmp-panel".to_string(), "tight-rows-panel".to_string()],
        );
        let rendered = report.render();
        assert!(
            rendered.contains("browser default-on gate: FAIL — cross-row=2 on tight-rows-panel"),
            "got: {rendered}"
        );
        assert!(!report.all_gates_pass());
    }

    /// The failure this guards against is a default being flipped on the
    /// strength of a run where the reader was never configured.
    #[test]
    fn a_reader_that_never_ran_is_not_a_pass() {
        let report = Report::new(
            vec![run("cmp-panel", Reader::Tesseract, 0)],
            vec![],
            &["cmp-panel".to_string()],
        );
        let node_gate = report
            .gates
            .iter()
            .find(|g| g.name.contains("node unattended"))
            .expect("node gate");
        assert_eq!(node_gate.passed, None);
        assert!(!report.all_gates_pass());
        assert!(report.render().contains("INCONCLUSIVE"));
    }

    /// The trap this harness would otherwise walk into, and did on its first
    /// real run: the node's reader transcribed a lab panel column-major, so no
    /// finding could ever verify, so it proposed nothing — and "zero cross-row"
    /// was true of a reader that had said nothing at all. Silence must not
    /// clear a safety gate.
    #[test]
    fn a_reader_that_proposed_nothing_does_not_clear_the_gate() {
        let report = Report::new(
            vec![
                run("tight-rows-panel", Reader::Ocrs, 0),
                silent("cmp-panel", Reader::Ocrs),
            ],
            vec![],
            &["cmp-panel".to_string(), "tight-rows-panel".to_string()],
        );
        let gate = report
            .gates
            .iter()
            .find(|g| g.name.contains("node unattended"))
            .expect("node gate");
        assert_eq!(gate.passed, None, "silence is not a pass");
        assert!(gate.detail.contains("cmp-panel"), "got: {}", gate.detail);
        assert!(!report.all_gates_pass());
        assert!(report.render().contains("INCONCLUSIVE"));
    }
    #[test]
    fn a_partial_fixture_run_cannot_clear_a_ship_gate() {
        let report = Report::new(
            vec![run("cmp-panel", Reader::Tesseract, 0)],
            vec![],
            &["cmp-panel".to_string(), "tight-rows-panel".to_string()],
        );
        let gate = &report.gates[0];
        assert_eq!(gate.passed, None);
        assert!(
            gate.detail.contains("tight-rows-panel"),
            "got: {}",
            gate.detail
        );
        assert!(!report.all_gates_pass());
    }

    /// ...but declining a hand-style page is the documented correct answer, so
    /// it must not hold the gate open forever.
    #[test]
    fn silence_on_a_handwritten_page_does_not_block_the_gate() {
        let report = Report::new(
            vec![
                run("cmp-panel", Reader::Tesseract, 0),
                silent("handwritten-vitals", Reader::Tesseract),
            ],
            vec![],
            &["cmp-panel".to_string(), "handwritten-vitals".to_string()],
        );
        let gate = &report.gates[0];
        assert_eq!(gate.passed, Some(true), "detail: {}", gate.detail);
    }

    /// Handwriting informs a decision; it must never be able to block or clear
    /// one on its own.
    #[test]
    fn the_handwriting_line_is_never_a_verdict() {
        let report = Report::new(
            vec![
                run("cmp-panel", Reader::Tesseract, 0),
                run("handwritten-vitals", Reader::Tesseract, 0),
                run("cmp-panel", Reader::Ocrs, 0),
                run("handwritten-vitals", Reader::Ocrs, 0),
            ],
            vec![],
            &["cmp-panel".to_string(), "handwritten-vitals".to_string()],
        );
        let hand = report
            .gates
            .iter()
            .find(|g| g.name.contains("handwriting"))
            .expect("handwriting line");
        assert_eq!(hand.passed, None);
        // ...and it does not drag the overall verdict down with it.
        assert!(report.all_gates_pass());
    }

    /// A cross-row on a page the reader should have declined is still a gate
    /// failure — that is the ROADMAP's "couldn't read this" promise.
    #[test]
    fn a_cross_row_on_a_handwritten_page_still_fails_the_gate() {
        let report = Report::new(
            vec![
                run("cmp-panel", Reader::Ocrs, 0),
                run("handwritten-meds", Reader::Ocrs, 1),
            ],
            vec![],
            &["cmp-panel".to_string(), "handwritten-meds".to_string()],
        );
        let gate = report
            .gates
            .iter()
            .find(|g| g.name.contains("node unattended"))
            .expect("node gate");
        assert_eq!(gate.passed, Some(false));
        assert!(gate.detail.contains("handwritten-meds"));
    }

    #[test]
    fn the_answer_key_shape_round_trips() {
        let t = truth(3);
        assert_eq!(t.expected.len(), 3);
    }
}
