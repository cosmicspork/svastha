//! The svastha-node binary: read boot config from the environment, then run the
//! substrate (enrolment, sync, curation-aware index). Configuration:
//!
//! - `SVASTHA_RELAY_URL` — **required**; the relay base URL (never assumed).
//! - `SVASTHA_NODE_DATA_DIR` — durable dir for the node identity (default
//!   `svastha-node/data`).
//! - `SVASTHA_NODE_CACHE_DIR` — ephemeral decrypted-plaintext dir (default
//!   `svastha-node/cache`).
//! - `SVASTHA_NODE_INFERENCE_ENDPOINT` — OpenAI-compatible chat-completions base;
//!   setting it enables OCR (D2). `SVASTHA_NODE_INFERENCE_MODEL` is then required;
//!   `SVASTHA_NODE_INFERENCE_API_KEY` is optional (a bearer token, never logged).
//! - `SVASTHA_NODE_BOOTSTRAP_ADDR` — loopback-only bootstrap page (default
//!   `127.0.0.1:7071`).
//! - `SVASTHA_NODE_POLL_INTERVAL_SECS` — SSE-down fallback cadence (default 60).
//! - `SVASTHA_NODE_LABEL` — label in the identity code (default `svastha-node`).
//! - `RUST_LOG` — tracing filter (default `svastha_node=info`).

use std::process::ExitCode;

use svastha_node::logtail::{LogBuffer, LogTee};
use svastha_node::{run, Config};
use tracing_subscriber::EnvFilter;

fn main() -> ExitCode {
    // Tee tracing to stderr and a bounded in-memory ring buffer, so the `log_tail`
    // admin command can return recent lines with no log file and no inbound port.
    // The node's logs are content-free by construction (see `logtail`), so a tail
    // of them leaks nothing.
    let logs = LogBuffer::new();
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| EnvFilter::new("svastha_node=info")),
        )
        // No ANSI escapes, so the buffered lines are clean text for the reply.
        .with_ansi(false)
        .with_writer(LogTee::new(logs.clone()))
        .init();

    let config = match Config::from_env() {
        Ok(config) => config,
        Err(e) => {
            // Fail fast and clearly on missing or invalid required config.
            tracing::error!(error = %e, "configuration error");
            return ExitCode::FAILURE;
        }
    };

    if let Err(e) = run(config, logs) {
        tracing::error!(error = format!("{e:#}"), "node exited");
        return ExitCode::FAILURE;
    }
    ExitCode::SUCCESS
}
