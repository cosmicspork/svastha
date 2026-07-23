//! Boot configuration, read once from the environment. The node is
//! **multi-tenant with no per-user config**: each owner enrols by granting the
//! node and depositing a `key_handoff` (see [`crate::sync`]), so there is nothing
//! to configure per person. Everything here is process-wide.
//!
//! The one hard rule is that `RELAY_URL` is **required and never defaulted** — the
//! node must never assume it is co-located with a relay (see
//! `docs/ARCHITECTURE.md`, "Self-hosting"). Everything else has a safe default.
//!
//! The inference endpoint, model, and API key are read and *validated* here.
//! Setting the endpoint **enables OCR** (D2); a misconfiguration fails at boot
//! rather than at first inference. [`validate_inference_endpoint`] is the design
//! §8 hard-constraint hook (synchronous, zero-retention endpoints only).

use std::net::ToSocketAddrs;
use std::path::PathBuf;
use std::time::Duration;

/// Required. The relay base URL, e.g. `https://relay.example`. Never defaulted:
/// the node reaches the relay outbound and must be told where it is.
pub const ENV_RELAY_URL: &str = "SVASTHA_RELAY_URL";
/// Durable directory. Holds the **only** durable state — the node identity seed.
pub const ENV_DATA_DIR: &str = "SVASTHA_NODE_DATA_DIR";
/// Ephemeral directory for decrypted plaintext (see [`crate::sync`]). Treated as
/// disposable: on restart, anything missing simply re-syncs.
pub const ENV_CACHE_DIR: &str = "SVASTHA_NODE_CACHE_DIR";
/// Optional OpenAI-compatible inference endpoint. When set, OCR (D2) is enabled
/// and this is the chat-completions base the node posts vision requests to; a
/// model id ([`ENV_INFERENCE_MODEL`]) is then required.
pub const ENV_INFERENCE_ENDPOINT: &str = "SVASTHA_NODE_INFERENCE_ENDPOINT";
/// Optional inference API key. Sent as an `Authorization: Bearer` header; never
/// logged.
pub const ENV_INFERENCE_API_KEY: &str = "SVASTHA_NODE_INFERENCE_API_KEY";
/// The chat-completions model id (e.g. a vision model). **Required whenever
/// [`ENV_INFERENCE_ENDPOINT`] is set** — an OpenAI-compatible request carries a
/// `model` field, and leaving it to an endpoint default is too surprising for a
/// pipeline that writes proposals into someone's medical record.
pub const ENV_INFERENCE_MODEL: &str = "SVASTHA_NODE_INFERENCE_MODEL";
/// Optional bind address for the bootstrap page. **Loopback only** (validated).
pub const ENV_BOOTSTRAP_ADDR: &str = "SVASTHA_NODE_BOOTSTRAP_ADDR";
/// Optional fallback poll interval (seconds) for when the SSE stream is down.
pub const ENV_POLL_INTERVAL_SECS: &str = "SVASTHA_NODE_POLL_INTERVAL_SECS";
/// Optional human label shown in the node's `svastha1:` identity code.
pub const ENV_LABEL: &str = "SVASTHA_NODE_LABEL";

const DEFAULT_DATA_DIR: &str = "svastha-node/data";
const DEFAULT_CACHE_DIR: &str = "svastha-node/cache";
const DEFAULT_BOOTSTRAP_ADDR: &str = "127.0.0.1:7071";
const DEFAULT_POLL_INTERVAL_SECS: u64 = 60;
const DEFAULT_LABEL: &str = "svastha-node";

/// A configuration error precise enough to fix without reading the code. Boot
/// fails fast on any of these.
#[derive(Debug, thiserror::Error)]
pub enum ConfigError {
    #[error("{ENV_RELAY_URL} is required (the node never assumes a co-located relay)")]
    MissingRelayUrl,
    #[error("{ENV_RELAY_URL} must be an http(s) URL, got: {0}")]
    BadRelayUrl(String),
    #[error("{ENV_BOOTSTRAP_ADDR} must resolve to a loopback address (the bootstrap page is never exposed), got: {0}")]
    NonLoopbackBootstrap(String),
    #[error("{ENV_BOOTSTRAP_ADDR} is not a valid socket address: {0}")]
    BadBootstrapAddr(String),
    #[error("{ENV_POLL_INTERVAL_SECS} must be a positive integer, got: {0}")]
    BadPollInterval(String),
    #[error("{ENV_INFERENCE_ENDPOINT} is invalid: {0}")]
    BadInferenceEndpoint(String),
    #[error("{ENV_INFERENCE_MODEL} is required when {ENV_INFERENCE_ENDPOINT} is set (an OpenAI-compatible request carries a model id)")]
    MissingInferenceModel,
}

/// The inference target (OpenAI-compatible chat completions). Present exactly
/// when [`ENV_INFERENCE_ENDPOINT`] is set; its presence is what enables the OCR
/// pipeline (D2).
#[derive(Clone, Debug)]
pub struct InferenceConfig {
    pub endpoint: String,
    /// Present only if the operator supplied one; never logged.
    pub api_key: Option<String>,
    /// The chat-completions model id sent in every request.
    pub model: String,
}

/// Process-wide boot configuration.
#[derive(Clone, Debug)]
pub struct Config {
    /// Relay base URL, trailing slash trimmed so callers never re-trim.
    pub relay_url: String,
    /// Durable dir (node identity seed only).
    pub data_dir: PathBuf,
    /// Ephemeral dir for decrypted plaintext.
    pub cache_dir: PathBuf,
    /// Inference target, validated if present; unused until D2/D3.
    pub inference: Option<InferenceConfig>,
    /// Loopback-only bootstrap-page bind address.
    pub bootstrap_addr: String,
    /// Fallback pull cadence when the SSE poke stream is unavailable.
    pub poll_interval: Duration,
    /// Human label for the node's identity code.
    pub label: String,
}

impl Config {
    /// Read and validate the configuration from the process environment.
    pub fn from_env() -> Result<Self, ConfigError> {
        let relay_url = std::env::var(ENV_RELAY_URL)
            .ok()
            .filter(|s| !s.trim().is_empty())
            .ok_or(ConfigError::MissingRelayUrl)?;
        let relay_url = relay_url.trim().trim_end_matches('/').to_string();
        if !is_http_url(&relay_url) {
            return Err(ConfigError::BadRelayUrl(relay_url));
        }

        let data_dir = env_path(ENV_DATA_DIR, DEFAULT_DATA_DIR);
        let cache_dir = env_path(ENV_CACHE_DIR, DEFAULT_CACHE_DIR);

        let inference = match std::env::var(ENV_INFERENCE_ENDPOINT)
            .ok()
            .filter(|s| !s.trim().is_empty())
        {
            Some(endpoint) => {
                let endpoint = endpoint.trim().to_string();
                validate_inference_endpoint(&endpoint)
                    .map_err(ConfigError::BadInferenceEndpoint)?;
                let api_key = std::env::var(ENV_INFERENCE_API_KEY)
                    .ok()
                    .filter(|s| !s.trim().is_empty());
                let model = std::env::var(ENV_INFERENCE_MODEL)
                    .ok()
                    .map(|s| s.trim().to_string())
                    .filter(|s| !s.is_empty())
                    .ok_or(ConfigError::MissingInferenceModel)?;
                Some(InferenceConfig {
                    endpoint,
                    api_key,
                    model,
                })
            }
            None => None,
        };

        let bootstrap_addr = std::env::var(ENV_BOOTSTRAP_ADDR)
            .ok()
            .filter(|s| !s.trim().is_empty())
            .unwrap_or_else(|| DEFAULT_BOOTSTRAP_ADDR.to_string());
        validate_loopback(&bootstrap_addr)?;

        let poll_interval = match std::env::var(ENV_POLL_INTERVAL_SECS)
            .ok()
            .filter(|s| !s.trim().is_empty())
        {
            Some(s) => {
                let secs: u64 = s
                    .trim()
                    .parse()
                    .map_err(|_| ConfigError::BadPollInterval(s.clone()))?;
                if secs == 0 {
                    return Err(ConfigError::BadPollInterval(s));
                }
                Duration::from_secs(secs)
            }
            None => Duration::from_secs(DEFAULT_POLL_INTERVAL_SECS),
        };

        let label = std::env::var(ENV_LABEL)
            .ok()
            .filter(|s| !s.trim().is_empty())
            .unwrap_or_else(|| DEFAULT_LABEL.to_string());

        Ok(Self {
            relay_url,
            data_dir,
            cache_dir,
            inference,
            bootstrap_addr,
            poll_interval,
            label,
        })
    }
}

fn env_path(var: &str, default: &str) -> PathBuf {
    std::env::var(var)
        .ok()
        .filter(|s| !s.trim().is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(default))
}

fn is_http_url(url: &str) -> bool {
    url.starts_with("http://") || url.starts_with("https://")
}

/// Require the bootstrap address to bind a loopback interface. The bootstrap page
/// is *bootstrap-only* (identity code + health) and must never be reachable off
/// the host — operational admin arrives over the mailbox, not this port — so a
/// non-loopback bind is a hard configuration error, not a warning.
fn validate_loopback(addr: &str) -> Result<(), ConfigError> {
    let mut resolved = addr
        .to_socket_addrs()
        .map_err(|e| ConfigError::BadBootstrapAddr(format!("{addr}: {e}")))?
        .peekable();
    if resolved.peek().is_none() {
        return Err(ConfigError::BadBootstrapAddr(addr.to_string()));
    }
    for socket in resolved {
        if !socket.ip().is_loopback() {
            return Err(ConfigError::NonLoopbackBootstrap(addr.to_string()));
        }
    }
    Ok(())
}

/// The design §8 hard-constraint hook. The node speaks generic OpenAI-compatible
/// chat completions, but not every such endpoint preserves the zero-retention
/// property the trust model depends on. A **Batch Inference API** retains its
/// input/output files server-side (~30 days), so pointing the node at one would
/// leak plaintext beyond the trust boundary. Reject anything that looks like a
/// batch path. This is a heuristic guard, not a proof — the operator remains
/// responsible for choosing a synchronous, zero-retention endpoint — but it
/// catches the obvious misconfiguration at boot instead of at first inference.
pub fn validate_inference_endpoint(endpoint: &str) -> Result<(), String> {
    let endpoint = endpoint.trim();
    if endpoint.is_empty() {
        return Err("endpoint is empty".to_string());
    }
    if !is_http_url(endpoint) {
        return Err(format!("must be an http(s) URL, got: {endpoint}"));
    }
    if endpoint.to_ascii_lowercase().contains("/batch") {
        return Err(format!(
            "looks like a Batch API path ({endpoint}); the node requires a synchronous, \
             zero-retention endpoint — batch outputs are retained server-side"
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn synchronous_endpoint_is_accepted() {
        assert!(validate_inference_endpoint("https://inference.internal/v1").is_ok());
        assert!(validate_inference_endpoint("http://127.0.0.1:11434/v1").is_ok());
    }

    #[test]
    fn batch_endpoint_is_rejected() {
        // The design §8 hard constraint: batch APIs retain files server-side.
        assert!(validate_inference_endpoint("https://api.example/v1/batches").is_err());
        assert!(validate_inference_endpoint("https://api.example/v1/batch").is_err());
    }

    #[test]
    fn non_http_endpoint_is_rejected() {
        assert!(validate_inference_endpoint("ftp://example/v1").is_err());
        assert!(validate_inference_endpoint("").is_err());
    }

    #[test]
    fn loopback_addresses_pass_non_loopback_fails() {
        assert!(validate_loopback("127.0.0.1:7071").is_ok());
        assert!(validate_loopback("[::1]:7071").is_ok());
        // A wildcard bind would expose the bootstrap page off-host.
        assert!(matches!(
            validate_loopback("0.0.0.0:7071"),
            Err(ConfigError::NonLoopbackBootstrap(_))
        ));
    }
}
