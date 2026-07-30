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
//! Inference is split into two independent **roles** — OCR (coding a page the
//! node transcribed itself)
//! and chat (RAG answers) — so an operator can point each at a different model
//! (a model tuned for structured extraction and one tuned for answering are
//! rarely the same model).
//! Each role resolves its endpoint/model/API key from role-specific env vars,
//! each **falling back to the shared base** (`SVASTHA_NODE_INFERENCE_*`), so a
//! single-model setup keeps working unchanged. A role is enabled when it resolves
//! both an endpoint and a model; a misconfiguration fails at boot rather than at
//! first inference. [`validate_inference_endpoint`] is the design §8
//! hard-constraint hook (synchronous, zero-retention endpoints only).

use std::net::ToSocketAddrs;
use std::path::PathBuf;
use std::time::Duration;

use crate::ocr_control::{OcrSettings, DEFAULT_MAX_PAGES_PER_PASS};

/// Required. The relay base URL, e.g. `https://relay.example`. Never defaulted:
/// the node reaches the relay outbound and must be told where it is.
pub const ENV_RELAY_URL: &str = "SVASTHA_RELAY_URL";
/// Durable directory. Holds the **only** durable state — the node identity seed.
pub const ENV_DATA_DIR: &str = "SVASTHA_NODE_DATA_DIR";
/// Ephemeral directory for decrypted plaintext (see [`crate::sync`]). Treated as
/// disposable: on restart, anything missing simply re-syncs.
pub const ENV_CACHE_DIR: &str = "SVASTHA_NODE_CACHE_DIR";
/// Optional OpenAI-compatible inference endpoint. When set, OCR (D2) is enabled
/// and this is the chat-completions base the node posts coding requests to; a
/// model id ([`ENV_INFERENCE_MODEL`]) is then required.
pub const ENV_INFERENCE_ENDPOINT: &str = "SVASTHA_NODE_INFERENCE_ENDPOINT";
/// Optional inference API key. Sent as an `Authorization: Bearer` header; never
/// logged.
pub const ENV_INFERENCE_API_KEY: &str = "SVASTHA_NODE_INFERENCE_API_KEY";
/// The chat-completions model id (a text model). **Required whenever an
/// endpoint resolves for a role** — an OpenAI-compatible request carries a
/// `model` field, and leaving it to an endpoint default is too surprising for a
/// pipeline that writes proposals into someone's medical record. This is the
/// shared base; a role-specific model (below) overrides it.
pub const ENV_INFERENCE_MODEL: &str = "SVASTHA_NODE_INFERENCE_MODEL";

// Per-role overrides. Each falls back to the shared base above when unset, so a
// single-model deployment needs only the base three vars. Set a role's model to
// run OCR and chat on different models (the common case: one endpoint, two model
// ids); set a role's endpoint/key too to split them across providers entirely.
/// OCR (page-coding) endpoint override; falls back to [`ENV_INFERENCE_ENDPOINT`].
pub const ENV_OCR_ENDPOINT: &str = "SVASTHA_NODE_OCR_INFERENCE_ENDPOINT";
/// OCR (page-coding) model override; falls back to [`ENV_INFERENCE_MODEL`].
pub const ENV_OCR_MODEL: &str = "SVASTHA_NODE_OCR_INFERENCE_MODEL";
/// OCR (page-coding) API-key override; falls back to [`ENV_INFERENCE_API_KEY`].
pub const ENV_OCR_API_KEY: &str = "SVASTHA_NODE_OCR_INFERENCE_API_KEY";
/// Chat (RAG) endpoint override; falls back to [`ENV_INFERENCE_ENDPOINT`].
pub const ENV_CHAT_ENDPOINT: &str = "SVASTHA_NODE_CHAT_INFERENCE_ENDPOINT";
/// Chat (RAG) model override; falls back to [`ENV_INFERENCE_MODEL`].
pub const ENV_CHAT_MODEL: &str = "SVASTHA_NODE_CHAT_INFERENCE_MODEL";
/// Chat (RAG) API-key override; falls back to [`ENV_INFERENCE_API_KEY`].
pub const ENV_CHAT_API_KEY: &str = "SVASTHA_NODE_CHAT_INFERENCE_API_KEY";
/// Optional boot default for page reading, applied to **every owner who has not
/// chosen for themselves** (see [`crate::ocr_control`]). Default: paused.
pub const ENV_OCR_PAUSED: &str = "SVASTHA_NODE_OCR_PAUSED";
/// Optional override for the per-pass page cap.
pub const ENV_OCR_MAX_PAGES: &str = "SVASTHA_NODE_OCR_MAX_PAGES_PER_PASS";
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
    #[error("{endpoint_var} is invalid: {detail}")]
    BadInferenceEndpoint {
        endpoint_var: &'static str,
        detail: String,
    },
    #[error("{model_var} (or {ENV_INFERENCE_MODEL}) is required for the {role} role once its endpoint resolves (an OpenAI-compatible request carries a model id)")]
    MissingInferenceModel {
        role: &'static str,
        model_var: &'static str,
    },
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
    /// Inference target for coding a transcribed page (D2) — a text model;
    /// validated if present. Resolves the OCR-role env vars over the shared base.
    pub ocr_inference: Option<InferenceConfig>,
    /// Text inference target for RAG chat (D3), validated if present. Resolves
    /// the chat-role env vars over the shared base.
    pub chat_inference: Option<InferenceConfig>,
    /// The reading gate's boot settings (default paused state and per-pass cap).
    /// Read here so [`crate::ocr_control`] takes them as parameters instead of
    /// reaching into the process env.
    pub ocr: OcrSettings,
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

        let ocr_inference = resolve_role(
            "OCR",
            ENV_OCR_ENDPOINT,
            ENV_OCR_MODEL,
            ENV_OCR_API_KEY,
            &env_nonempty,
        )?;
        let chat_inference = resolve_role(
            "chat",
            ENV_CHAT_ENDPOINT,
            ENV_CHAT_MODEL,
            ENV_CHAT_API_KEY,
            &env_nonempty,
        )?;

        let ocr = resolve_ocr(&env_nonempty);

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
            ocr_inference,
            chat_inference,
            ocr,
            bootstrap_addr,
            poll_interval,
            label,
        })
    }
}

/// A trimmed, non-empty environment variable, or `None`.
fn env_nonempty(var: &str) -> Option<String> {
    std::env::var(var)
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

/// Resolve one inference role (OCR or chat) from its role-specific env vars,
/// each falling back to the shared base (`SVASTHA_NODE_INFERENCE_*`). Returns
/// `None` when no endpoint resolves for the role (that role's pass simply does
/// not run), or an error when an endpoint resolves but is invalid or has no
/// model — the same fail-fast the single-config path used, now per role.
fn resolve_role(
    role: &'static str,
    endpoint_var: &'static str,
    model_var: &'static str,
    api_key_var: &'static str,
    lookup: &dyn Fn(&str) -> Option<String>,
) -> Result<Option<InferenceConfig>, ConfigError> {
    // Blame the actual source var in errors, so the fix is unambiguous whether
    // the value came from the role override or the shared base.
    let (endpoint, endpoint_src) = match lookup(endpoint_var) {
        Some(e) => (e, endpoint_var),
        None => match lookup(ENV_INFERENCE_ENDPOINT) {
            Some(e) => (e, ENV_INFERENCE_ENDPOINT),
            None => return Ok(None),
        },
    };
    validate_inference_endpoint(&endpoint).map_err(|detail| ConfigError::BadInferenceEndpoint {
        endpoint_var: endpoint_src,
        detail,
    })?;
    let api_key = lookup(api_key_var).or_else(|| lookup(ENV_INFERENCE_API_KEY));
    let model = lookup(model_var)
        .or_else(|| lookup(ENV_INFERENCE_MODEL))
        .ok_or(ConfigError::MissingInferenceModel { role, model_var })?;
    Ok(Some(InferenceConfig {
        endpoint,
        api_key,
        model,
    }))
}

/// Resolve the reading gate's boot settings. Takes a lookup fn for the same
/// reason [`resolve_role`] does: the values are then testable without touching
/// the process env, which cargo's parallel test threads share.
fn resolve_ocr(lookup: &dyn Fn(&str) -> Option<String>) -> OcrSettings {
    OcrSettings {
        default_paused: lookup(ENV_OCR_PAUSED)
            .as_deref()
            .and_then(parse_flag)
            .unwrap_or(true),
        max_pages_per_pass: lookup(ENV_OCR_MAX_PAGES)
            .as_deref()
            .and_then(parse_positive)
            .unwrap_or(DEFAULT_MAX_PAGES_PER_PASS),
    }
}

/// `1`/`true`/`yes`/`on` (any case) is true; `0`/`false`/`no`/`off` is false;
/// anything else is `None`, so a typo falls back to the safe default rather than
/// being read as "off".
fn parse_flag(value: &str) -> Option<bool> {
    match value.trim().to_ascii_lowercase().as_str() {
        "1" | "true" | "yes" | "on" => Some(true),
        "0" | "false" | "no" | "off" => Some(false),
        _ => None,
    }
}

/// A positive integer, or `None` — a zero or unparseable cap would mean "read
/// nothing" or panic, both worse than ignoring it.
fn parse_positive(value: &str) -> Option<usize> {
    value.trim().parse().ok().filter(|n| *n > 0)
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
        return Err("must be an http(s) URL".to_string());
    }
    if endpoint.to_ascii_lowercase().contains("/batch") {
        return Err(
            "looks like a Batch API path; the node requires a synchronous, \
             zero-retention endpoint — batch outputs are retained server-side"
                .to_string(),
        );
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
    fn endpoint_validation_errors_never_echo_url_credentials() {
        for endpoint in [
            "ftp://inference.internal/v1?api_key=sk-secret",
            "https://inference.internal/v1/batch?api_key=sk-secret",
        ] {
            let error = validate_inference_endpoint(endpoint).unwrap_err();
            assert!(
                !error.contains("sk-secret"),
                "admin replies and logs must not expose endpoint credentials: {error}"
            );
        }
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

    // --- per-role inference resolution ---
    //
    // `resolve_role` takes a lookup fn rather than reading `std::env` directly,
    // so these exercise the fallback logic without racing the process env (cargo
    // runs tests in parallel threads).

    fn lookup_from(pairs: &[(&'static str, &str)]) -> impl Fn(&str) -> Option<String> {
        let map: std::collections::HashMap<String, String> = pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect();
        move |k| map.get(k).cloned()
    }

    fn ocr(l: &dyn Fn(&str) -> Option<String>) -> Result<Option<InferenceConfig>, ConfigError> {
        resolve_role("OCR", ENV_OCR_ENDPOINT, ENV_OCR_MODEL, ENV_OCR_API_KEY, l)
    }
    fn chat(l: &dyn Fn(&str) -> Option<String>) -> Result<Option<InferenceConfig>, ConfigError> {
        resolve_role(
            "chat",
            ENV_CHAT_ENDPOINT,
            ENV_CHAT_MODEL,
            ENV_CHAT_API_KEY,
            l,
        )
    }

    #[test]
    fn both_roles_fall_back_to_the_shared_base() {
        // Only the base three vars set → both roles resolve identically, exactly
        // the pre-split single-model deployment.
        let l = lookup_from(&[
            (ENV_INFERENCE_ENDPOINT, "https://base/v1"),
            (ENV_INFERENCE_MODEL, "base-model"),
            (ENV_INFERENCE_API_KEY, "k"),
        ]);
        let o = ocr(&l).unwrap().unwrap();
        let c = chat(&l).unwrap().unwrap();
        assert_eq!(
            (o.endpoint.as_str(), o.model.as_str()),
            ("https://base/v1", "base-model")
        );
        assert_eq!(
            (c.endpoint.as_str(), c.model.as_str()),
            ("https://base/v1", "base-model")
        );
        assert_eq!(
            c.api_key.as_deref(),
            Some("k"),
            "key falls back to base too"
        );
    }

    #[test]
    fn a_role_model_override_wins_over_the_base_model() {
        // The headline case: one endpoint, an extraction model for OCR and a chat model
        // for RAG.
        let l = lookup_from(&[
            (ENV_INFERENCE_ENDPOINT, "https://base/v1"),
            (ENV_INFERENCE_MODEL, "extract-model"),
            (ENV_CHAT_MODEL, "chat-model"),
        ]);
        assert_eq!(ocr(&l).unwrap().unwrap().model, "extract-model");
        let c = chat(&l).unwrap().unwrap();
        assert_eq!(c.model, "chat-model");
        assert_eq!(c.endpoint, "https://base/v1", "endpoint still shared");
    }

    #[test]
    fn a_role_endpoint_override_splits_it_from_the_base() {
        let l = lookup_from(&[
            (ENV_INFERENCE_ENDPOINT, "https://base/v1"),
            (ENV_INFERENCE_MODEL, "base-model"),
            (ENV_CHAT_ENDPOINT, "https://chat-host/v1"),
            (ENV_CHAT_MODEL, "chat-model"),
        ]);
        assert_eq!(ocr(&l).unwrap().unwrap().endpoint, "https://base/v1");
        assert_eq!(chat(&l).unwrap().unwrap().endpoint, "https://chat-host/v1");
    }

    #[test]
    fn a_role_with_no_endpoint_anywhere_is_disabled() {
        let l = lookup_from(&[(ENV_INFERENCE_MODEL, "m")]);
        assert!(ocr(&l).unwrap().is_none());
        assert!(chat(&l).unwrap().is_none());
    }

    #[test]
    fn an_endpoint_with_no_model_is_a_boot_error() {
        let l = lookup_from(&[(ENV_INFERENCE_ENDPOINT, "https://base/v1")]);
        assert!(matches!(
            chat(&l),
            Err(ConfigError::MissingInferenceModel { role: "chat", .. })
        ));
    }

    // --- the reading gate's boot settings ---

    #[test]
    fn the_reading_gate_defaults_to_paused_with_the_standard_cap() {
        let l = lookup_from(&[]);
        let ocr = resolve_ocr(&l);
        assert!(ocr.default_paused);
        assert_eq!(ocr.max_pages_per_pass, DEFAULT_MAX_PAGES_PER_PASS);
    }

    #[test]
    fn an_operator_can_opt_the_deployment_in() {
        let l = lookup_from(&[(ENV_OCR_PAUSED, "false"), (ENV_OCR_MAX_PAGES, "5")]);
        let ocr = resolve_ocr(&l);
        assert!(!ocr.default_paused);
        assert_eq!(ocr.max_pages_per_pass, 5);
    }

    #[test]
    fn nonsense_values_fall_back_to_the_safe_defaults() {
        let l = lookup_from(&[(ENV_OCR_PAUSED, "maybe"), (ENV_OCR_MAX_PAGES, "0")]);
        let ocr = resolve_ocr(&l);
        assert!(ocr.default_paused, "a typo must not be read as 'off'");
        assert_eq!(ocr.max_pages_per_pass, DEFAULT_MAX_PAGES_PER_PASS);
    }

    #[test]
    fn a_batch_role_endpoint_is_rejected_at_resolve() {
        let l = lookup_from(&[
            (ENV_OCR_ENDPOINT, "https://api/v1/batch"),
            (ENV_OCR_MODEL, "m"),
        ]);
        assert!(matches!(
            ocr(&l),
            Err(ConfigError::BadInferenceEndpoint { endpoint_var, .. }) if endpoint_var == ENV_OCR_ENDPOINT
        ));
    }
}
