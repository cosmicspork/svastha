//! Svastha relay binary: wire [`svastha_relay::app`] to an in-memory store and
//! serve it. Configuration is via environment:
//!
//! - `SVASTHA_RELAY_ADDR` — listen address (default `127.0.0.1:8080`).
//! - `SVASTHA_RELAY_MAX_SKEW_SECS` — auth replay window (default `300`).
//! - `SVASTHA_RELAY_DATA_DIR` — durable blob, grant, mailbox, and share
//!   directory; if unset, all are kept in memory and lost on restart.
//! - `SVASTHA_APP_URL` — the paired web app's own origin (e.g.
//!   `https://app.example.com`), unset by default. When set, the landing
//!   page's (`GET /`) QR encodes a device-link onboarding URL instead of just
//!   the relay's own address; see [`svastha_relay::AppState::app_url`].
//! - `SVASTHA_RELAY_VAPID_PRIVATE`, `SVASTHA_RELAY_VAPID_PUBLIC`,
//!   `SVASTHA_RELAY_VAPID_SUBJECT` — the VAPID keypair (base64url) and `sub`
//!   claim (a `mailto:`/`https:` operator contact) that enable Web Push. All
//!   three together turn the feature on; none leaves it off (and every other
//!   endpoint works). Supplying only some is a misconfiguration and aborts
//!   startup — push must be fully configured or fully absent, never half. See
//!   the README for how to generate a pair.
//! - `RUST_LOG` — tracing filter (default `svastha_relay=info`).

use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use svastha_relay::app;
use svastha_relay::grants::{FsGrantStore, GrantStore, MemoryGrantStore};
use svastha_relay::mailbox::{FsMailboxStore, MailboxStore, MemoryMailboxStore};
use svastha_relay::push::{FsPushStore, MemoryPushStore, PushService, PushStore, Vapid};
use svastha_relay::routes::SHARE_TOMBSTONE_MAX_AGE_SECS;
use svastha_relay::share::{FsShareStore, MemoryShareStore, ShareStore};
use svastha_relay::store::{BlobStore, FsStore, MemoryStore};
use tracing_subscriber::EnvFilter;

/// The five relay stores, each behind a trait object so the same wiring backs
/// both the in-memory and filesystem builds. The push (subscription) store is
/// durable routing metadata like the others; the Web Push *transport* over it is
/// only assembled when a VAPID key is configured (see [`vapid_from_env`]).
type Stores = (
    Arc<dyn BlobStore>,
    Arc<dyn GrantStore>,
    Arc<dyn MailboxStore>,
    Arc<dyn ShareStore>,
    Arc<dyn PushStore>,
);

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

    let (store, grants, mailbox, shares, push_store): Stores = match std::env::var(
        "SVASTHA_RELAY_DATA_DIR",
    ) {
        Ok(dir) => {
            let store = FsStore::new(&dir).expect("create data directory");
            let grants = FsGrantStore::new(&dir).expect("create data directory");
            let mailbox = FsMailboxStore::new(&dir).expect("create data directory");
            let shares = FsShareStore::new(&dir).expect("create data directory");
            let push_store = FsPushStore::new(&dir).expect("create data directory");
            tracing::info!(data_dir = %dir, "durable filesystem store");
            (
                Arc::new(store),
                Arc::new(grants),
                Arc::new(mailbox),
                Arc::new(shares),
                Arc::new(push_store),
            )
        }
        Err(_) => {
            tracing::warn!(
                    "SVASTHA_RELAY_DATA_DIR unset; using in-memory store (blobs, grants, mailbox, shares, and push subscriptions lost on restart)"
                );
            (
                Arc::new(MemoryStore::new()),
                Arc::new(MemoryGrantStore::new()),
                Arc::new(MemoryMailboxStore::new()),
                Arc::new(MemoryShareStore::new()),
                Arc::new(MemoryPushStore::new()),
            )
        }
    };

    // Web Push is optional: with a full VAPID keypair the poke bus gains its
    // second transport; with none it stays SSE-only and every other endpoint is
    // untouched. A partial config is a mistake we refuse to start on.
    let push = vapid_from_env().map(|vapid| {
        tracing::info!("web push enabled (VAPID key configured)");
        Arc::new(PushService::new(vapid, push_store))
    });
    if push.is_none() {
        tracing::info!("web push disabled (no VAPID key); SSE poke channel unaffected");
    }

    // The relay has no periodic-task machinery, so shares are swept once at
    // startup (lapsed shares tombstoned, aged-out tombstones dropped); expiry is
    // otherwise caught lazily on the read path. A durable relay that runs for
    // months still stays tidy across restarts.
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    if let Err(e) = shares.sweep(now, SHARE_TOMBSTONE_MAX_AGE_SECS) {
        tracing::warn!(error = %e, "share sweep on startup failed");
    }

    let app = app(store, grants, mailbox, shares, max_skew_secs, app_url, push);

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

/// Read the VAPID configuration from the environment. All three variables
/// present → `Some(Vapid)` (push on); all absent → `None` (push off). A partial
/// configuration is a deployment mistake — an operator who set a key but not its
/// subject would ship a relay that silently fails every push — so it panics
/// (fail fast) rather than starting a half-configured feature. Keys are never
/// generated implicitly at boot: an operator supplies them (see the README).
fn vapid_from_env() -> Option<Vapid> {
    let read = |name: &str| std::env::var(name).ok().filter(|s| !s.is_empty());
    let private_key = read("SVASTHA_RELAY_VAPID_PRIVATE");
    let public_key = read("SVASTHA_RELAY_VAPID_PUBLIC");
    let subject = read("SVASTHA_RELAY_VAPID_SUBJECT");
    match (private_key, public_key, subject) {
        (Some(private_key), Some(public_key), Some(subject)) => Some(Vapid {
            subject,
            public_key,
            private_key,
        }),
        (None, None, None) => None,
        _ => panic!(
            "incomplete VAPID configuration: set all of SVASTHA_RELAY_VAPID_PRIVATE, \
             SVASTHA_RELAY_VAPID_PUBLIC, and SVASTHA_RELAY_VAPID_SUBJECT to enable Web Push, \
             or none to disable it"
        ),
    }
}
