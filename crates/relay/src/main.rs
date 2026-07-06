//! Svastha relay binary: wire [`svastha_relay::app`] to an in-memory store and
//! serve it. Configuration is via environment:
//!
//! - `SVASTHA_RELAY_ADDR` — listen address (default `127.0.0.1:8080`).
//! - `SVASTHA_RELAY_MAX_SKEW_SECS` — auth replay window (default `300`).
//! - `SVASTHA_RELAY_DATA_DIR` — durable blob, grant, and mailbox directory; if
//!   unset, all three are kept in memory and lost on restart.
//! - `SVASTHA_APP_URL` — the paired web app's own origin (e.g.
//!   `https://app.example.com`), unset by default. When set, the landing
//!   page's (`GET /`) QR encodes a device-link onboarding URL instead of just
//!   the relay's own address; see [`svastha_relay::AppState::app_url`].
//! - `RUST_LOG` — tracing filter (default `svastha_relay=info`).

use std::sync::Arc;

use svastha_relay::app;
use svastha_relay::grants::{FsGrantStore, GrantStore, MemoryGrantStore};
use svastha_relay::mailbox::{FsMailboxStore, MailboxStore, MemoryMailboxStore};
use svastha_relay::store::{BlobStore, FsStore, MemoryStore};
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
    // Trimmed once here so `routes::landing` never has to re-trim it per request.
    let app_url = std::env::var("SVASTHA_APP_URL")
        .ok()
        .map(|s| s.trim_end_matches('/').to_string())
        .filter(|s| !s.is_empty());

    let (store, grants, mailbox): (
        Arc<dyn BlobStore>,
        Arc<dyn GrantStore>,
        Arc<dyn MailboxStore>,
    ) = match std::env::var("SVASTHA_RELAY_DATA_DIR") {
        Ok(dir) => {
            let store = FsStore::new(&dir).expect("create data directory");
            let grants = FsGrantStore::new(&dir).expect("create data directory");
            let mailbox = FsMailboxStore::new(&dir).expect("create data directory");
            tracing::info!(data_dir = %dir, "durable filesystem store");
            (Arc::new(store), Arc::new(grants), Arc::new(mailbox))
        }
        Err(_) => {
            tracing::warn!(
                    "SVASTHA_RELAY_DATA_DIR unset; using in-memory store (blobs, grants, and mailbox lost on restart)"
                );
            (
                Arc::new(MemoryStore::new()),
                Arc::new(MemoryGrantStore::new()),
                Arc::new(MemoryMailboxStore::new()),
            )
        }
    };

    let app = app(store, grants, mailbox, max_skew_secs, app_url);

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
