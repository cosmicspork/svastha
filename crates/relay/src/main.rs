//! Svastha relay binary: wire [`svastha_relay::app`] to an in-memory store and
//! serve it. Configuration is via environment:
//!
//! - `SVASTHA_RELAY_ADDR` — listen address (default `127.0.0.1:8080`).
//! - `SVASTHA_RELAY_MAX_SKEW_SECS` — auth replay window (default `300`).
//! - `RUST_LOG` — tracing filter (default `svastha_relay=info`).

use std::sync::Arc;

use svastha_relay::{app, store::MemoryStore};
use tracing_subscriber::EnvFilter;

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| EnvFilter::new("svastha_relay=info")),
        )
        .init();

    let addr = std::env::var("SVASTHA_RELAY_ADDR").unwrap_or_else(|_| "127.0.0.1:8080".to_string());
    let max_skew_secs = std::env::var("SVASTHA_RELAY_MAX_SKEW_SECS")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(300);

    let app = app(Arc::new(MemoryStore::new()), max_skew_secs);

    let listener = tokio::net::TcpListener::bind(&addr)
        .await
        .expect("bind listen address");
    tracing::info!(
        addr = %addr,
        contract_version = svastha_core::CONTRACT_VERSION,
        "svastha relay listening"
    );
    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await
        .expect("server error");
}

async fn shutdown_signal() {
    let _ = tokio::signal::ctrl_c().await;
}
