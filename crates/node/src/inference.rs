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
//! text. Turning that text into draft events lives in [`crate::extract`], so the
//! two concerns test independently.

use std::time::Duration;

use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use serde::Deserialize;
use ureq::http::StatusCode;
use ureq::Agent;

use crate::config::InferenceConfig;

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
                { "role": "system", "content": crate::extract::SYSTEM_PROMPT },
                { "role": "user", "content": [
                    { "type": "text", "text": crate::extract::USER_PROMPT },
                    { "type": "image_url", "image_url": { "url": data_url } }
                ] }
            ]
        });
        let body =
            serde_json::to_vec(&request).map_err(|e| InferenceError::Transport(e.to_string()))?;

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
}
