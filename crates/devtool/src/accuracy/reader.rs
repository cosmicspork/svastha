//! The three page readers this harness compares, and the endpoint it codes
//! their output with.
//!
//! Each reader is measured **as it ships**, not as a reimplementation of what it
//! ships. `ocrs` runs through the node's own [`svastha_node::transcribe`]; the
//! browser reader runs the real `web/src/lib/ocr-engine.ts` inside a real
//! Chromium against the vendored assets in `web/public/ocr`. A harness that
//! hand-rolled either would be measuring the harness.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;

use anyhow::{anyhow, bail, Context, Result};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use serde::Deserialize;
use ureq::http::StatusCode;
use ureq::Agent;

use svastha_node::transcribe::{numbered, PageReader, Transcriber};

/// Which reader produced a transcript.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, serde::Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Reader {
    /// The node's in-process reader (`ocrs` over `rten`), stage A as the node
    /// runs it unattended.
    Ocrs,
    /// The browser's on-device reader (tesseract.js over the vendored assets),
    /// stage A as a phone runs it.
    Tesseract,
    /// The pre-#156 single-pass vision path, recovered from git history. Not a
    /// transcriber at all — it reads and codes in one call, so it produces no
    /// transcript and nothing can check what it claims. That is the comparison.
    Vision,
}

impl Reader {
    pub fn label(&self) -> &'static str {
        match self {
            Reader::Ocrs => "ocrs (node, in-process)",
            Reader::Tesseract => "tesseract.js (browser, vendored)",
            Reader::Vision => "vision (pre-#156, unverified)",
        }
    }
}

impl std::fmt::Display for Reader {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Reader::Ocrs => "ocrs",
            Reader::Tesseract => "tesseract",
            Reader::Vision => "vision",
        })
    }
}

// ---------------------------------------------------------------- ocrs

/// Load the node's reader from `SVASTHA_NODE_OCR_MODELS_DIR` (or its default).
///
/// The `.rten` models are baked into the node's image and are not in this repo
/// (see `Dockerfile.node`), so a developer machine usually has to be pointed at
/// a downloaded copy. Failing here skips the ocrs rows with a stated reason
/// rather than reporting a reader that never ran as a reader that read nothing.
pub fn load_ocrs() -> Result<Transcriber> {
    Transcriber::from_env().context(
        "could not load the ocrs models — set SVASTHA_NODE_OCR_MODELS_DIR to a directory \
         holding text-detection.rten and text-recognition.rten (see Dockerfile.node for the \
         URLs and their pinned SHA-256s)",
    )
}

pub fn ocrs_lines(transcriber: &Transcriber, page: &[u8]) -> Result<Vec<String>> {
    transcriber.transcribe(page)
}

// ------------------------------------------------------------ tesseract

/// Run the browser reader over one page by driving a real Chromium.
///
/// Shelling out to bun rather than reimplementing tesseract.js in Rust is the
/// point: `web/scripts/accuracy/read-page.ts` loads the same module the app
/// loads, from the same origin, over the same committed assets, and returns the
/// same `groupLines` output the coding step would receive in the app.
pub fn tesseract_lines(web_dir: &Path, page: &Path) -> Result<Vec<String>> {
    let out = Command::new("bun")
        .arg("run")
        .arg("scripts/accuracy/read-page.ts")
        .arg(page)
        .current_dir(web_dir)
        .output()
        .context("could not run bun — is it on PATH? (the browser reader needs `bun` and a Playwright chromium)")?;

    if !out.status.success() {
        bail!(
            "the browser reader failed ({}): {}",
            out.status,
            String::from_utf8_lossy(&out.stderr).trim()
        );
    }

    // The script prints progress on stderr and exactly one JSON array on stdout,
    // so bun's own noise cannot corrupt the transcript.
    let stdout = String::from_utf8(out.stdout).context("the browser reader printed non-UTF-8")?;
    serde_json::from_str(stdout.trim()).with_context(|| {
        format!(
            "the browser reader printed something that is not a JSON array of lines: {}",
            stdout.trim()
        )
    })
}

// ------------------------------------------------------------- endpoint

/// Where to send coding (and, with `--vision`, page images).
#[derive(Debug, Clone)]
pub struct Endpoint {
    pub url: String,
    pub api_key: Option<String>,
    pub model: String,
    pub vision_model: Option<String>,
}

const ENV_ENDPOINT: &str = "SVASTHA_DEVTOOL_ENDPOINT";
const ENV_MODEL: &str = "SVASTHA_DEVTOOL_MODEL";
const ENV_VISION_MODEL: &str = "SVASTHA_DEVTOOL_VISION_MODEL";
const ENV_API_KEY: &str = "SVASTHA_DEVTOOL_API_KEY";

/// The refusal a developer sees when the harness is run bare. Spelled out
/// rather than a one-liner because the alternative to a clear refusal here is a
/// run that looks like it measured something and did not.
pub const NO_ENDPOINT: &str = "\
accuracy needs a coding endpoint, and nothing configured one.

  Set at least:
    SVASTHA_DEVTOOL_ENDPOINT   an OpenAI-compatible base URL, e.g. http://127.0.0.1:11434/v1

  Optional:
    SVASTHA_DEVTOOL_MODEL          model id for coding transcripts (default: \"default\")
    SVASTHA_DEVTOOL_VISION_MODEL   model id for --vision (no default; --vision refuses without it)
    SVASTHA_DEVTOOL_API_KEY        sent as a bearer token when set

This harness never runs in CI and has no offline mode: the scores it prints are
a property of a specific reader against a specific coding model, and a run with
either half missing would be a number with nothing behind it.";

impl Endpoint {
    /// Resolve from the environment, or explain what is missing.
    pub fn from_env() -> Result<Self> {
        let url = std::env::var(ENV_ENDPOINT)
            .ok()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .ok_or_else(|| anyhow!("{NO_ENDPOINT}"))?;

        // The node's own design-§8 constraint, applied here too: a batch
        // endpoint retains its inputs server-side, and this harness sends real
        // page text (synthetic here, but the habit is the point).
        svastha_node::config::validate_inference_endpoint(&url)
            .map_err(|e| anyhow!("{ENV_ENDPOINT} is not usable: {e}"))?;

        Ok(Self {
            url,
            api_key: env_opt(ENV_API_KEY),
            model: env_opt(ENV_MODEL).unwrap_or_else(|| "default".to_string()),
            vision_model: env_opt(ENV_VISION_MODEL),
        })
    }

    /// The node's coding client, built for this endpoint — so the request this
    /// harness scores is byte-for-byte the request the node makes.
    pub fn coding_client(&self) -> svastha_node::inference::InferenceClient {
        svastha_node::inference::InferenceClient::new(&svastha_node::config::InferenceConfig {
            endpoint: self.url.clone(),
            api_key: self.api_key.clone(),
            model: self.model.clone(),
        })
    }

    /// Code a transcript exactly as the node does: the shared prompts plus the
    /// numbered lines. Returns the model's raw answer for `parse_lines`.
    pub fn code(&self, lines: &[String]) -> Result<String> {
        self.coding_client()
            .code_page(&numbered(lines))
            .map_err(|e| anyhow!("coding request failed: {e}"))
    }
}

fn env_opt(key: &str) -> Option<String> {
    std::env::var(key)
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

// --------------------------------------------------------------- vision

// The pre-#156 single-pass prompts, recovered verbatim from
// `git show 1f72aea^:crates/import/src/extract.rs`. They live here rather than
// back in `svastha-import` on purpose: that crate ships, and re-exporting a
// retired unverifiable path from it would put it back within reach of a caller.
// This is a measurement copy, and the only thing that reads it is this harness.

/// Pre-#156 `VISION_SYSTEM_PROMPT`.
const VISION_SYSTEM_PROMPT: &str = "\
You transcribe medical documents into structured data. Extract ONLY facts that \
are visibly written on the page — measurements, medications, immunizations, \
problems, procedures, and their dates. Never infer, diagnose, predict, or add \
anything not literally present. If the page is blank or unreadable, return an \
empty findings list. Respond with a single JSON object and nothing else.";

/// Pre-#156 `VISION_USER_PROMPT`. Note what it does not ask for: a
/// `source_line`. There is no transcript, so an answer to this cannot be
/// checked against anything — which is why the path was retired and why the
/// harness reports its findings through the unverified `parse`.
const VISION_USER_PROMPT: &str = "\
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

/// Matches the node's own inference timeout — a self-hosted vision model on
/// modest hardware is slow, and this bounds one wedged request, not the run.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(120);

/// Send one page image with the recovered prompts and return the raw answer.
///
/// Kept in this crate rather than restored to `svastha-node`: the node no longer
/// has a vision path, and re-adding one so a dev tool could call it would be
/// shipping the thing being measured.
pub fn vision_answer(endpoint: &Endpoint, page: &[u8], mime: &str) -> Result<String> {
    let model = endpoint.vision_model.as_ref().ok_or_else(|| {
        anyhow!(
            "--vision needs {ENV_VISION_MODEL} — not every OpenAI-compatible endpoint accepts \
             images, so this is opt-in rather than assumed"
        )
    })?;

    let data_url = format!("data:{};base64,{}", mime, BASE64.encode(page));
    let request = serde_json::json!({
        "model": model,
        // Deterministic, as the retired path was.
        "temperature": 0,
        "messages": [
            { "role": "system", "content": VISION_SYSTEM_PROMPT },
            { "role": "user", "content": [
                { "type": "text", "text": VISION_USER_PROMPT },
                { "type": "image_url", "image_url": { "url": data_url } }
            ] }
        ]
    });

    let agent: Agent = Agent::config_builder()
        .http_status_as_error(false)
        .timeout_global(Some(REQUEST_TIMEOUT))
        .build()
        .into();

    let mut builder = agent
        .post(&chat_completions_url(&endpoint.url))
        .header("content-type", "application/json");
    if let Some(key) = &endpoint.api_key {
        builder = builder.header("authorization", format!("Bearer {key}"));
    }

    let body = serde_json::to_vec(&request)?;
    let mut resp = builder
        .send(&body)
        .map_err(|e| anyhow!("vision request failed: {e}"))?;
    if resp.status() != StatusCode::OK {
        bail!("vision endpoint returned status {}", resp.status().as_u16());
    }
    let bytes = resp.body_mut().read_to_vec()?;
    let parsed: ChatCompletion = serde_json::from_slice(&bytes)
        .context("vision response was not chat-completions shaped")?;
    parsed
        .choices
        .into_iter()
        .next()
        .map(|c| c.message.content)
        .ok_or_else(|| anyhow!("vision response carried no choices"))
}

/// Same resolution rule as the node's client, so a base URL configured for one
/// works for the other.
fn chat_completions_url(endpoint: &str) -> String {
    let trimmed = endpoint.trim_end_matches('/');
    if trimmed.ends_with("/chat/completions") {
        trimmed.to_string()
    } else {
        format!("{trimmed}/chat/completions")
    }
}

#[derive(Deserialize)]
struct ChatCompletion {
    choices: Vec<Choice>,
}

#[derive(Deserialize)]
struct Choice {
    message: Message,
}

#[derive(Deserialize)]
struct Message {
    #[serde(default)]
    content: String,
}

/// Where the repo's `web/` and `fixtures/ocr/` directories are, relative to this
/// crate. Resolved from `CARGO_MANIFEST_DIR` so the tool works from any cwd.
pub fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(Path::parent)
        .map(Path::to_path_buf)
        .unwrap_or_else(|| PathBuf::from("."))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_base_url_resolves_to_chat_completions() {
        assert_eq!(
            chat_completions_url("http://127.0.0.1:11434/v1"),
            "http://127.0.0.1:11434/v1/chat/completions"
        );
        // An operator who already pointed at the full path is left alone.
        assert_eq!(
            chat_completions_url("http://h/v1/chat/completions"),
            "http://h/v1/chat/completions"
        );
    }

    #[test]
    fn the_repo_root_holds_the_fixtures_this_harness_reads() {
        assert!(repo_root().join("fixtures/ocr").is_dir());
        assert!(repo_root().join("web/scripts/accuracy").is_dir());
    }

    /// The refusal has to name the variable that would fix it — a harness that
    /// says only "not configured" sends the reader to the source.
    #[test]
    fn the_refusal_names_the_variables() {
        assert!(NO_ENDPOINT.contains(ENV_ENDPOINT));
        assert!(NO_ENDPOINT.contains(ENV_MODEL));
        assert!(NO_ENDPOINT.contains(ENV_VISION_MODEL));
    }
}
