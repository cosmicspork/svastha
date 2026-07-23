//! The svastha-node binary: read boot config from the environment, then run the
//! substrate (enrolment, sync, curation-aware index). Configuration:
//!
//! - `SVASTHA_RELAY_URL` — **required**; the relay base URL (never assumed).
//! - `SVASTHA_NODE_DATA_DIR` — durable dir for the node identity (default
//!   `svastha-node/data`).
//! - `SVASTHA_NODE_CACHE_DIR` — ephemeral decrypted-plaintext dir (default
//!   `svastha-node/cache`).
//! - `SVASTHA_NODE_INFERENCE_ENDPOINT` / `SVASTHA_NODE_INFERENCE_API_KEY` —
//!   validated if present, unused until D2/D3.
//! - `SVASTHA_NODE_BOOTSTRAP_ADDR` — loopback-only bootstrap page (default
//!   `127.0.0.1:7071`).
//! - `SVASTHA_NODE_POLL_INTERVAL_SECS` — SSE-down fallback cadence (default 60).
//! - `SVASTHA_NODE_LABEL` — label in the identity code (default `svastha-node`).
//! - `RUST_LOG` — tracing filter (default `svastha_node=info`).

use std::process::ExitCode;

use svastha_node::{run, Config};
use tracing_subscriber::EnvFilter;

fn main() -> ExitCode {
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| EnvFilter::new("svastha_node=info")),
        )
        .init();

    let config = match Config::from_env() {
        Ok(config) => config,
        Err(e) => {
            // Fail fast and clearly on missing or invalid required config.
            tracing::error!(error = %e, "configuration error");
            return ExitCode::FAILURE;
        }
    };

    if let Err(e) = run(config) {
        tracing::error!(error = format!("{e:#}"), "node exited");
        return ExitCode::FAILURE;
    }
    ExitCode::SUCCESS
}
