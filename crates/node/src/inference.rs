//! A generic, blocking **OpenAI-compatible chat-completions** client for vision
//! extraction (design §8). The endpoint, key, and model are user-supplied
//! ([`crate::config::InferenceConfig`]); the node ships no models and speaks only
//! the one wire shape every such server (Ollama, LM Studio, vLLM, or a cloud
//! endpoint the operator explicitly chose) understands.
//!
//! Two deliberate posture choices:
//!
//! - **Synchronous only.** The node posts one request and blocks for one answer.
//!   A batch-style API is rejected at config time ([`crate::config`]) — batch
//!   outputs are retained server-side, which would leak plaintext beyond the
//!   user's trust boundary.
//! - **Content-free logs.** The request necessarily carries the decrypted page to
//!   the configured endpoint — that is the design's trust decision — but *this*
//!   crate's logs never carry the image, the prompt, or the extracted text: only
//!   the model id and byte/finding counts.
//!
//! This client is transport only: it returns the model's raw assistant-message
//! text. Turning that text into draft events lives in `svastha_import::extract`, so the
//! two concerns test independently.

use std::path::{Path, PathBuf};
use std::time::Duration;

use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use serde::{Deserialize, Serialize};
use ureq::http::StatusCode;
use ureq::Agent;

use crate::config::{validate_inference_endpoint, InferenceConfig};

/// The maximum time to wait on one inference round-trip. Vision inference is slow
/// and rate-limited; the OCR loop is serial (below), so a generous ceiling here
/// only bounds a single wedged request, never the whole node.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(120);

/// A failure talking to the inference endpoint. Every variant is transient from
/// the pipeline's point of view — the source page is marked failed and retried
/// with backoff, never dropped (see [`crate::ocr`]).
#[derive(Debug, thiserror::Error)]
pub enum InferenceError {
    #[error("inference request failed: {0}")]
    Transport(String),
    #[error("inference endpoint returned status {0}")]
    Status(u16),
    #[error("inference response was not the expected chat-completions shape")]
    BadResponse,
}

/// A blocking OpenAI-compatible chat-completions client.
pub struct InferenceClient {
    /// The fully-resolved `.../chat/completions` URL.
    url: String,
    api_key: Option<String>,
    model: String,
    agent: Agent,
}

impl InferenceClient {
    /// Build a client from the validated inference config.
    pub fn new(config: &InferenceConfig) -> Self {
        let agent = Agent::config_builder()
            .http_status_as_error(false)
            .timeout_global(Some(REQUEST_TIMEOUT))
            .build()
            .into();
        Self {
            url: chat_completions_url(&config.endpoint),
            api_key: config.api_key.clone(),
            model: config.model.clone(),
            agent,
        }
    }

    /// The configured model id (also stamped into each draft's provenance).
    pub fn model(&self) -> &str {
        &self.model
    }

    /// The resolved chat-completions URL, for a content-free admin `job_status`
    /// echo (an endpoint URL is configuration, not record content).
    pub fn url(&self) -> &str {
        &self.url
    }

    /// Run one **text** chat completion (no image): send `system` + `user` and
    /// return the model's raw assistant-message text. This is the RAG turn (D3) —
    /// the caller supplies the retrieved context inside `user` and parses the
    /// answer defensively (this method makes no claim the text is well-formed).
    /// Shares the vision path's transport, timeout, and deterministic
    /// `temperature: 0`; like it, it logs nothing — the prompt carries the
    /// decrypted context to the endpoint the operator chose, and never to a log.
    pub fn answer(&self, system: &str, user: &str) -> Result<String, InferenceError> {
        let request = serde_json::json!({
            "model": self.model,
            "temperature": 0,
            "messages": [
                { "role": "system", "content": system },
                { "role": "user", "content": user }
            ]
        });
        self.chat(&request)
    }

    /// Post a chat-completions request and return the first choice's text. Shared
    /// by [`extract`](Self::extract) (vision) and [`answer`](Self::answer) (text).
    fn chat(&self, request: &serde_json::Value) -> Result<String, InferenceError> {
        let body =
            serde_json::to_vec(request).map_err(|e| InferenceError::Transport(e.to_string()))?;
        let mut builder = self
            .agent
            .post(&self.url)
            .header("content-type", "application/json");
        if let Some(key) = &self.api_key {
            builder = builder.header("authorization", format!("Bearer {key}"));
        }
        let mut resp = builder
            .send(&body)
            .map_err(|e| InferenceError::Transport(e.to_string()))?;
        if resp.status() != StatusCode::OK {
            return Err(InferenceError::Status(resp.status().as_u16()));
        }
        let bytes = resp
            .body_mut()
            .read_to_vec()
            .map_err(|e| InferenceError::Transport(e.to_string()))?;
        let parsed: ChatCompletion =
            serde_json::from_slice(&bytes).map_err(|_| InferenceError::BadResponse)?;
        parsed
            .choices
            .into_iter()
            .next()
            .map(|c| c.message.content)
            .ok_or(InferenceError::BadResponse)
    }

    /// Run one vision extraction: send `image` (with its `mime`) plus the
    /// extraction prompt and return the model's raw assistant-message text. The
    /// caller parses it defensively — this method makes no claim the text is
    /// well-formed JSON.
    pub fn extract(&self, image: &[u8], mime: &str) -> Result<String, InferenceError> {
        let data_url = format!("data:{};base64,{}", mime, BASE64.encode(image));
        let request = serde_json::json!({
            "model": self.model,
            // Deterministic extraction: no creative variance when reading a record.
            "temperature": 0,
            "messages": [
                { "role": "system", "content": svastha_import::extract::VISION_SYSTEM_PROMPT },
                { "role": "user", "content": [
                    { "type": "text", "text": svastha_import::extract::VISION_USER_PROMPT },
                    { "type": "image_url", "image_url": { "url": data_url } }
                ] }
            ]
        });
        self.chat(&request)
    }
}

/// The runtime inference target for both roles, mutable by the
/// `set_inference_endpoint` admin command (design §9). It owns the live
/// [`InferenceClient`]s the OCR (vision) and chat (RAG) passes use — each with
/// its own model and API key from the boot config — and resolves the effective
/// endpoint per role.
///
/// **Precedence: a persisted runtime override wins over the env boot default.**
/// The env is only the *boot* default; once an owner sets an endpoint over the
/// mailbox it is written to the data dir and re-read at boot, so the override
/// survives a restart and takes precedence. The `admin_cmd` carries only a single
/// endpoint, so the override is **node-wide**: it retargets both roles' endpoints
/// at once, while each role keeps its own boot model and API key. An override
/// needs at least one boot role config to borrow a model from — setting an
/// endpoint on a node with no inference model configured is rejected. (Splitting
/// the two roles across *different* endpoints is a boot-env choice; a per-role
/// live override would need a wider admin command.)
pub struct InferenceRuntime {
    /// OCR-role boot config (vision model + key + endpoint), or `None`.
    ocr_boot: Option<InferenceConfig>,
    /// Chat-role boot config (text model + key + endpoint), or `None`.
    chat_boot: Option<InferenceConfig>,
    /// Where the node-wide endpoint override persists (data dir).
    override_path: PathBuf,
    /// Live OCR client for the effective endpoint, or `None` when OCR inference
    /// is not usable (no OCR boot config to supply a model).
    ocr_current: Option<InferenceClient>,
    /// Live chat client for the effective endpoint, or `None` when chat inference
    /// is not usable (no chat boot config to supply a model).
    chat_current: Option<InferenceClient>,
    /// The effective endpoint each live client targets (for status echoes).
    ocr_endpoint: Option<String>,
    chat_endpoint: Option<String>,
}

/// The persisted endpoint override — a single URL. Config, not record content, so
/// it is safe in the durable data dir (unlike plaintext, which stays ephemeral).
#[derive(Serialize, Deserialize)]
struct EndpointOverride {
    endpoint: String,
}

const OVERRIDE_FILE: &str = "inference-endpoint.json";

impl InferenceRuntime {
    /// Build the runtime from the two role boot configs and the data dir. Reads
    /// any persisted override and resolves each role's effective endpoint.
    pub fn load(
        ocr_boot: Option<InferenceConfig>,
        chat_boot: Option<InferenceConfig>,
        data_dir: &Path,
    ) -> Self {
        let override_path = data_dir.join(OVERRIDE_FILE);
        let overridden = read_override(&override_path);
        let mut rt = Self {
            ocr_boot,
            chat_boot,
            override_path,
            ocr_current: None,
            chat_current: None,
            ocr_endpoint: None,
            chat_endpoint: None,
        };
        rt.rebuild(overridden);
        rt
    }

    /// The live OCR (vision) client, if OCR inference is usable. `None` means the
    /// OCR pass does not run (a page waits rather than getting a fake extraction).
    pub fn ocr_client(&self) -> Option<&InferenceClient> {
        self.ocr_current.as_ref()
    }

    /// The live chat (RAG) client, if chat inference is usable. `None` means the
    /// chat pass does not run (a question waits rather than getting a fake answer,
    /// mirroring the web's honest waiting state).
    pub fn chat_client(&self) -> Option<&InferenceClient> {
        self.chat_current.as_ref()
    }

    /// The effective OCR endpoint URL, for the `job_status` echo. `None` when unset.
    pub fn ocr_endpoint(&self) -> Option<&str> {
        self.ocr_endpoint.as_deref()
    }

    /// The effective chat endpoint URL, for the `job_status` echo. `None` when unset.
    pub fn chat_endpoint(&self) -> Option<&str> {
        self.chat_endpoint.as_deref()
    }

    /// Apply a `set_inference_endpoint` command: validate the endpoint against the
    /// same design-§8 hard constraints boot uses (synchronous, non-batch), then
    /// swap **both** live clients (node-wide) and persist the override. Returns a
    /// human-readable detail on success, or the validation/precondition message to
    /// send back as `ok: false` — never a panic, so a bad value just fails the
    /// command.
    pub fn set_endpoint(&mut self, endpoint: &str) -> Result<String, String> {
        let endpoint = endpoint.trim().to_string();
        validate_inference_endpoint(&endpoint)?;
        // The command carries only an endpoint; each role's model/API key come
        // from its boot config, so without any role there is nothing to run.
        if self.ocr_boot.is_none() && self.chat_boot.is_none() {
            return Err(
                "no inference model configured at boot (SVASTHA_NODE_INFERENCE_MODEL); \
                 an endpoint alone cannot run"
                    .to_string(),
            );
        }
        self.persist_override(&endpoint)
            .map_err(|e| format!("could not persist the endpoint override: {e}"))?;
        self.rebuild(Some(endpoint.clone()));
        Ok(format!("inference endpoint updated to {endpoint}"))
    }

    /// Rebuild both live clients for the given node-wide override (or each role's
    /// boot endpoint when `None`). The model and key always come from the role's
    /// own boot config.
    fn rebuild(&mut self, overridden: Option<String>) {
        let (ocr_current, ocr_endpoint) = build_client(&self.ocr_boot, overridden.as_deref());
        let (chat_current, chat_endpoint) = build_client(&self.chat_boot, overridden.as_deref());
        self.ocr_current = ocr_current;
        self.ocr_endpoint = ocr_endpoint;
        self.chat_current = chat_current;
        self.chat_endpoint = chat_endpoint;
    }

    fn persist_override(&self, endpoint: &str) -> std::io::Result<()> {
        if let Some(parent) = self.override_path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let bytes = serde_json::to_vec_pretty(&EndpointOverride {
            endpoint: endpoint.to_string(),
        })
        .map_err(std::io::Error::other)?;
        // Atomic write-temp-then-rename, like the journal, so a crash never leaves
        // a half-written override that would fail to parse.
        let tmp = self.override_path.with_extension("json.tmp");
        std::fs::write(&tmp, &bytes)?;
        std::fs::rename(&tmp, &self.override_path)
    }
}

/// Read a persisted endpoint override, if present and readable. A missing or
/// unreadable file simply means "no override" — fall back to the env boot default.
fn read_override(path: &Path) -> Option<String> {
    let bytes = std::fs::read(path).ok()?;
    let parsed: EndpointOverride = serde_json::from_slice(&bytes).ok()?;
    let endpoint = parsed.endpoint.trim().to_string();
    // A persisted value that no longer validates (e.g. constraints tightened) is
    // ignored rather than trusted, so a stale override cannot weaken the boot guard.
    if validate_inference_endpoint(&endpoint).is_ok() {
        Some(endpoint)
    } else {
        None
    }
}

/// Build a role's live client: the effective endpoint is the node-wide override
/// when set, else the role's own boot endpoint; the model and API key always come
/// from the boot config. Returns `(None, None)` for a role with no boot config.
fn build_client(
    boot: &Option<InferenceConfig>,
    overridden: Option<&str>,
) -> (Option<InferenceClient>, Option<String>) {
    let Some(boot) = boot else {
        return (None, None);
    };
    let endpoint = overridden
        .map(str::to_string)
        .unwrap_or_else(|| boot.endpoint.clone());
    let config = InferenceConfig {
        endpoint: endpoint.clone(),
        api_key: boot.api_key.clone(),
        model: boot.model.clone(),
    };
    (Some(InferenceClient::new(&config)), Some(endpoint))
}

/// Resolve the configured base (e.g. `https://host/v1`) to the chat-completions
/// URL. If the operator already pointed at the full path, use it verbatim.
fn chat_completions_url(endpoint: &str) -> String {
    let trimmed = endpoint.trim_end_matches('/');
    if trimmed.ends_with("/chat/completions") {
        trimmed.to_string()
    } else {
        format!("{trimmed}/chat/completions")
    }
}

/// The subset of the chat-completions response the node reads: the first
/// choice's assistant message text. Unknown fields (`usage`, `id`, …) are
/// ignored, so any compliant server's extra keys are harmless.
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
    /// Assistant content. Required as a string here; a server that returns a
    /// structured content array instead fails parsing and is treated as a
    /// transient bad response (retried), never a malformed proposal.
    #[serde(default)]
    content: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_base_to_chat_completions() {
        assert_eq!(
            chat_completions_url("https://host/v1"),
            "https://host/v1/chat/completions"
        );
        assert_eq!(
            chat_completions_url("https://host/v1/"),
            "https://host/v1/chat/completions"
        );
        // An operator who pointed at the full path is honoured verbatim.
        assert_eq!(
            chat_completions_url("https://host/v1/chat/completions"),
            "https://host/v1/chat/completions"
        );
    }

    #[test]
    fn parses_a_minimal_completion() {
        let json = r#"{"id":"x","choices":[{"message":{"role":"assistant","content":"hello"}}],"usage":{}}"#;
        let parsed: ChatCompletion = serde_json::from_str(json).unwrap();
        assert_eq!(parsed.choices[0].message.content, "hello");
    }

    #[test]
    fn empty_choices_has_no_content() {
        let json = r#"{"choices":[]}"#;
        let parsed: ChatCompletion = serde_json::from_str(json).unwrap();
        assert!(parsed.choices.is_empty());
    }

    fn boot(endpoint: &str) -> InferenceConfig {
        InferenceConfig {
            endpoint: endpoint.to_string(),
            api_key: None,
            model: "m".to_string(),
        }
    }

    /// A boot config with an explicit model, to prove per-role model routing.
    fn boot_model(endpoint: &str, model: &str) -> InferenceConfig {
        InferenceConfig {
            endpoint: endpoint.to_string(),
            api_key: None,
            model: model.to_string(),
        }
    }

    #[test]
    fn each_role_uses_its_own_boot_endpoint_and_model() {
        let dir = tempfile::tempdir().unwrap();
        let rt = InferenceRuntime::load(
            Some(boot_model("https://vision/v1", "vision-model")),
            Some(boot_model("https://chat/v1", "chat-model")),
            dir.path(),
        );
        assert_eq!(rt.ocr_endpoint(), Some("https://vision/v1"));
        assert_eq!(rt.chat_endpoint(), Some("https://chat/v1"));
        assert_eq!(rt.ocr_client().map(|c| c.model()), Some("vision-model"));
        assert_eq!(rt.chat_client().map(|c| c.model()), Some("chat-model"));
    }

    #[test]
    fn a_role_with_no_boot_config_is_disabled_while_the_other_runs() {
        let dir = tempfile::tempdir().unwrap();
        // Chat-only: OCR has no boot config, so its pass never runs.
        let rt = InferenceRuntime::load(None, Some(boot("https://chat/v1")), dir.path());
        assert!(rt.ocr_client().is_none());
        assert!(rt.chat_client().is_some());
    }

    #[test]
    fn set_endpoint_retargets_both_roles_but_keeps_per_role_models() {
        let dir = tempfile::tempdir().unwrap();
        let mut rt = InferenceRuntime::load(
            Some(boot_model("https://vision/v1", "vision-model")),
            Some(boot_model("https://chat/v1", "chat-model")),
            dir.path(),
        );
        rt.set_endpoint("https://override/v1").unwrap();
        // The node-wide override retargets both endpoints…
        assert_eq!(rt.ocr_endpoint(), Some("https://override/v1"));
        assert_eq!(rt.chat_endpoint(), Some("https://override/v1"));
        // …while each role keeps its own model and API key.
        assert_eq!(rt.ocr_client().map(|c| c.model()), Some("vision-model"));
        assert_eq!(rt.chat_client().map(|c| c.model()), Some("chat-model"));

        // A restart (fresh load from the same dir) keeps the override.
        let rt2 = InferenceRuntime::load(
            Some(boot("https://vision/v1")),
            Some(boot("https://chat/v1")),
            dir.path(),
        );
        assert_eq!(rt2.ocr_endpoint(), Some("https://override/v1"));
        assert_eq!(rt2.chat_endpoint(), Some("https://override/v1"));
    }

    #[test]
    fn set_endpoint_rejects_a_batch_path_without_swapping() {
        let dir = tempfile::tempdir().unwrap();
        let mut rt = InferenceRuntime::load(
            Some(boot("https://boot/v1")),
            Some(boot("https://boot/v1")),
            dir.path(),
        );
        let err = rt.set_endpoint("https://api/v1/batch").unwrap_err();
        assert!(err.contains("Batch"), "batch rejection message surfaced");
        // Rejected value never becomes live.
        assert_eq!(rt.ocr_endpoint(), Some("https://boot/v1"));
        assert_eq!(rt.chat_endpoint(), Some("https://boot/v1"));
    }

    #[test]
    fn set_endpoint_without_any_boot_model_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        let mut rt = InferenceRuntime::load(None, None, dir.path());
        assert!(rt.ocr_client().is_none() && rt.chat_client().is_none());
        let err = rt.set_endpoint("https://override/v1").unwrap_err();
        assert!(err.contains("model"), "explains the missing boot model");
        assert!(
            rt.ocr_client().is_none() && rt.chat_client().is_none(),
            "still unusable"
        );
    }
}
