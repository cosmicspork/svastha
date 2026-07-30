//! Score the page readers against the fixture pages.
//!
//! The OCR pipeline ships with two readers that have never been measured — the
//! node's in-process `ocrs` and the browser's tesseract.js — and a third,
//! retired single-pass vision path recoverable from git history. Three defaults
//! are waiting on numbers that do not exist: whether browser OCR can be on by
//! default, whether the node can work a backlog unattended, and whether
//! handwriting is worth supporting at all. This produces those numbers.
//!
//! ## What is actually being measured
//!
//! Not "does the OCR read the text". A reader that transcribes a page perfectly
//! and a reader that transcribes it into shuffled rows both produce plausible
//! text; the difference only shows up after the text has been coded. So each
//! reader's transcript goes through the **real** coding path —
//! [`svastha_import::extract::parse_lines`], via the node's own request shape —
//! and the score is over the draft events that come out the far end. What is
//! scored is the pipeline, with the reader as the only variable.
//!
//! The vision path is the exception and deliberately so: it reads and codes in
//! one call, so there is no transcript, nothing to cite, and nothing to check.
//! It is scored through the unverified [`svastha_import::extract::parse`], which
//! is the entire argument for the two-stage split — see the `--vision` rows.
//!
//! ## Never in CI
//!
//! Every scored run needs a coding model, and the score is a property of that
//! model as much as of the reader. A CI job would either need a pinned endpoint
//! (which this project does not have and should not acquire) or would silently
//! measure nothing. So this is a manual tool: it refuses without
//! `SVASTHA_DEVTOOL_ENDPOINT`, and nothing under `.github/workflows` invokes it.
//! The logic that decides pass/fail is unit-tested against canned transcripts,
//! which is the part that can be tested without a model.

pub mod reader;
pub mod report;
pub mod score;

use std::fs;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};

use reader::{Endpoint, Reader};
use report::{Report, Run};
use score::Truth;

/// What to run.
pub struct AccuracyConfig {
    /// Emit the machine-readable report instead of the table.
    pub json: bool,
    /// Include the retired single-pass vision path. Off by default: not every
    /// OpenAI-compatible endpoint accepts images.
    pub vision: bool,
    /// Score only fixtures whose name contains this.
    pub only: Option<String>,
}

/// One fixture page: the image and the answer key beside it.
struct Fixture {
    name: String,
    path: PathBuf,
    truth: Truth,
}

/// Load every `<name>.truth.json` in `fixtures/ocr/` with its matching
/// `<name>.png`.
///
/// A fixture pair is one test case. A missing, mismatched, or empty answer key
/// would leave a hole in the gate's evidence, so reject it rather than silently
/// omitting it from the report.
fn load_fixtures(dir: &Path, only: Option<&str>) -> Result<Vec<Fixture>> {
    let mut entries: Vec<PathBuf> = fs::read_dir(dir)
        .with_context(|| format!("could not read {}", dir.display()))?
        .map(|entry| entry.map(|entry| entry.path()))
        .collect::<std::io::Result<_>>()
        .with_context(|| format!("could not list {}", dir.display()))?;
    entries.sort();

    for page in entries
        .iter()
        .filter(|path| path.extension().and_then(|extension| extension.to_str()) == Some("png"))
    {
        let name = page
            .file_stem()
            .and_then(|stem| stem.to_str())
            .filter(|stem| !stem.is_empty())
            .ok_or_else(|| anyhow::anyhow!("invalid fixture page name {}", page.display()))?;
        let truth_path = dir.join(format!("{name}.truth.json"));
        anyhow::ensure!(
            truth_path.is_file(),
            "{} has no answer key {}; every fixture page must be scored",
            page.display(),
            truth_path.display()
        );
    }

    let mut out = Vec::new();
    for truth_path in entries.iter().filter(|path| {
        path.file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.ends_with(".truth.json"))
    }) {
        let name = truth_path
            .file_name()
            .and_then(|name| name.to_str())
            .and_then(|name| name.strip_suffix(".truth.json"))
            .filter(|name| !name.is_empty())
            .ok_or_else(|| anyhow::anyhow!("invalid answer-key name {}", truth_path.display()))?;
        let expected_page = format!("{name}.png");
        let raw = fs::read_to_string(truth_path)?;
        let truth: Truth = serde_json::from_str(&raw)
            .with_context(|| format!("could not parse {}", truth_path.display()))?;
        anyhow::ensure!(
            truth.page == expected_page,
            "{} names {} but must name {}",
            truth_path.display(),
            truth.page,
            expected_page
        );
        anyhow::ensure!(
            !truth.expected.is_empty(),
            "{} has no expected rows",
            truth_path.display()
        );
        for row in &truth.expected {
            anyhow::ensure!(
                !row.analyte.trim().is_empty(),
                "{} has an expected row without an analyte",
                truth_path.display()
            );
            anyhow::ensure!(
                !row.value.trim().is_empty(),
                "{} has an expected row without a value",
                truth_path.display()
            );
        }

        let path = dir.join(&expected_page);
        anyhow::ensure!(
            path.is_file(),
            "{} names {} but that page is not committed",
            truth_path.display(),
            expected_page
        );
        if only.is_some_and(|filter| !name.contains(filter)) {
            continue;
        }
        out.push(Fixture {
            name: name.to_string(),
            path,
            truth,
        });
    }
    Ok(out)
}

/// Run the harness. Returns the report; the caller prints it.
pub fn run(config: &AccuracyConfig) -> Result<Report> {
    let endpoint = Endpoint::from_env()?;
    let root = reader::repo_root();
    let all_fixtures = load_fixtures(&root.join("fixtures/ocr"), None)?;
    let fixture_names: Vec<String> = all_fixtures
        .iter()
        .map(|fixture| fixture.name.clone())
        .collect();
    let fixtures: Vec<Fixture> = all_fixtures
        .into_iter()
        .filter(|fixture| match config.only.as_deref() {
            Some(filter) => fixture.name.contains(filter),
            None => true,
        })
        .collect();
    anyhow::ensure!(!fixtures.is_empty(), "no fixtures matched");

    let mut runs: Vec<Run> = Vec::new();
    let mut skipped: Vec<String> = Vec::new();

    // Load the node's reader once — the models cost real time and memory, so
    // never per page (the node itself is careful about exactly this).
    let transcriber = match reader::load_ocrs() {
        Ok(t) => Some(t),
        Err(e) => {
            skipped.push(format!("ocrs: {e:#}"));
            None
        }
    };

    for fixture in &fixtures {
        let bytes = fs::read(&fixture.path)?;

        if let Some(transcriber) = &transcriber {
            eprintln!("reading {} with ocrs...", fixture.name);
            let run = match reader::ocrs_lines(transcriber, &bytes) {
                Ok(lines) => transcript_run(&endpoint, fixture, Reader::Ocrs, lines),
                Err(e) => Run {
                    fixture: fixture.name.clone(),
                    reader: Reader::Ocrs,
                    score: score::unreadable(&fixture.truth, format!("{e:#}")),
                },
            };
            runs.push(run);
        }

        eprintln!("reading {} with tesseract.js...", fixture.name);
        let run = match reader::tesseract_lines(&root.join("web"), &fixture.path) {
            Ok(lines) => transcript_run(&endpoint, fixture, Reader::Tesseract, lines),
            Err(e) => Run {
                fixture: fixture.name.clone(),
                reader: Reader::Tesseract,
                score: score::unreadable(&fixture.truth, format!("{e:#}")),
            },
        };
        runs.push(run);

        if config.vision {
            eprintln!("reading {} with the vision path...", fixture.name);
            // No transcript exists, so the answer goes through the *unverified*
            // parse. That is not a shortcut in the harness — it is the property
            // being measured.
            let run = match reader::vision_answer(&endpoint, &bytes, "image/png") {
                Ok(answer) => Run {
                    fixture: fixture.name.clone(),
                    reader: Reader::Vision,
                    score: score::score(&fixture.truth, &svastha_import::extract::parse(&answer)),
                },
                Err(e) => Run {
                    fixture: fixture.name.clone(),
                    reader: Reader::Vision,
                    score: score::unreadable(&fixture.truth, format!("{e:#}")),
                },
            };
            runs.push(run);
        }
    }

    Ok(Report::new(runs, skipped, &fixture_names))
}

/// Code one transcript through the node's real request shape and score what
/// comes out. A reader that produced no lines never reaches the model: an empty
/// transcript is "couldn't read this page", not a page with nothing on it.
fn transcript_run(
    endpoint: &Endpoint,
    fixture: &Fixture,
    which: Reader,
    lines: Vec<String>,
) -> Run {
    if lines.is_empty() {
        return Run {
            fixture: fixture.name.clone(),
            reader: which,
            score: score::unreadable(&fixture.truth, "no text recognized".into()),
        };
    }
    let score = match endpoint.code(&lines) {
        Ok(answer) => score::score(
            &fixture.truth,
            &svastha_import::extract::parse_lines(&answer, &lines),
        ),
        Err(e) => score::unreadable(&fixture.truth, format!("{e:#}")),
    };
    Run {
        fixture: fixture.name.clone(),
        reader: which,
        score,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Every committed answer key must name a page that exists and hold at
    /// least one expected row — an empty key would make any reader look
    /// perfect.
    #[test]
    fn every_committed_fixture_has_a_usable_answer_key() {
        let dir = reader::repo_root().join("fixtures/ocr");
        let fixtures = load_fixtures(&dir, None).expect("fixtures load");
        assert!(
            fixtures.len() >= 5,
            "expected the five rendered pages, got {}",
            fixtures.len()
        );
        for f in &fixtures {
            assert!(f.path.exists(), "{} is missing its page", f.name);
            assert!(
                !f.truth.expected.is_empty(),
                "{} has an empty answer key",
                f.name
            );
        }
    }

    /// The hazard fixtures are the reason the harness exists; a rename that
    /// silently dropped one would leave the gates measuring only the easy page.
    #[test]
    fn the_hazard_and_handwriting_fixtures_are_present() {
        let dir = reader::repo_root().join("fixtures/ocr");
        let names: Vec<String> = load_fixtures(&dir, None)
            .expect("fixtures load")
            .into_iter()
            .map(|f| f.name)
            .collect();
        for required in [
            "cmp-panel",
            "tight-rows-panel",
            "skewed-panel",
            "handwritten-vitals",
            "handwritten-meds",
        ] {
            assert!(names.iter().any(|n| n == required), "missing {required}");
        }
    }

    #[test]
    fn a_truth_file_must_name_the_page_with_its_own_stem() {
        let dir = tempfile::tempdir().expect("temporary fixture directory");
        std::fs::write(
            dir.path().join("control.truth.json"),
            r#"{"page":"other.png","expected":[{"analyte":"Sodium","value":"139"}]}"#,
        )
        .expect("write truth");
        std::fs::write(dir.path().join("other.png"), []).expect("write page");
        std::fs::write(dir.path().join("control.png"), []).expect("write page");
        std::fs::write(
            dir.path().join("other.truth.json"),
            r#"{"page":"other.png","expected":[{"analyte":"Potassium","value":"4.1"}]}"#,
        )
        .expect("write truth");

        let error = load_fixtures(dir.path(), None)
            .err()
            .expect("mismatched fixture identity must fail");
        assert!(
            error.to_string().contains("control.png"),
            "error: {error:#}"
        );
    }

    #[test]
    fn every_fixture_page_requires_an_answer_key() {
        let dir = tempfile::tempdir().expect("temporary fixture directory");
        std::fs::write(dir.path().join("orphan.png"), []).expect("write page");

        let error = load_fixtures(dir.path(), None)
            .err()
            .expect("a page without truth must fail");
        assert!(
            error.to_string().contains("orphan.truth.json"),
            "error: {error:#}"
        );
    }

    #[test]
    fn empty_answer_keys_are_rejected_at_load_time() {
        let dir = tempfile::tempdir().expect("temporary fixture directory");
        std::fs::write(dir.path().join("empty.png"), []).expect("write page");
        std::fs::write(
            dir.path().join("empty.truth.json"),
            r#"{"page":"empty.png","expected":[]}"#,
        )
        .expect("write truth");

        let error = load_fixtures(dir.path(), None)
            .err()
            .expect("an empty denominator must fail");
        assert!(
            error.to_string().contains("no expected rows"),
            "error: {error:#}"
        );
    }
    #[test]
    fn a_filter_narrows_the_run() {
        let dir = reader::repo_root().join("fixtures/ocr");
        let only = load_fixtures(&dir, Some("handwritten")).expect("fixtures load");
        assert_eq!(only.len(), 2);
    }
}
