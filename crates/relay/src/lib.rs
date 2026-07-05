//! Svastha relay: a zero-knowledge store-and-forward server for encrypted blobs.
//!
//! The relay holds no keys and never decrypts. It authenticates every blob
//! request by an Ed25519 signature (the contract lives in `svastha_core::relay`),
//! scopes storage to the authenticated owner, and stores opaque ciphertext it
//! cannot read. See `docs/ARCHITECTURE.md` and `spec/README.md`.
//!
//! Beyond blobs, the relay also carries two pieces of pure routing metadata for
//! household sharing: [`grants::GrantStore`] (who has authorized whom to read
//! their vault) and [`mailbox::MailboxStore`] (a store-and-forward drop box for
//! the wrapped vault key that makes a grant useful). Neither reveals vault
//! contents; see `docs/ARCHITECTURE.md`, "Vaults and grants".
//!
//! [`app`] builds the router for a given set of stores; the binary
//! ([`main`](../main.rs)) wires it to in-memory (or filesystem) stores and
//! `axum::serve`.

pub mod auth;
pub mod grants;
pub mod mailbox;
pub mod routes;
pub mod store;

use std::sync::Arc;

use axum::{
    middleware,
    routing::{get, put},
    Router,
};
use tower_http::cors::CorsLayer;

use grants::GrantStore;
use mailbox::MailboxStore;
use store::BlobStore;

/// Shared handler state: the stores and the auth freshness window.
#[derive(Clone)]
pub struct AppState {
    pub store: Arc<dyn BlobStore>,
    pub grants: Arc<dyn GrantStore>,
    pub mailbox: Arc<dyn MailboxStore>,
    pub max_skew_secs: u64,
}

/// Build the relay router. `max_skew_secs` is how far a request's signed
/// timestamp may differ from the relay's clock (replay window).
pub fn app(
    store: Arc<dyn BlobStore>,
    grants: Arc<dyn GrantStore>,
    mailbox: Arc<dyn MailboxStore>,
    max_skew_secs: u64,
) -> Router {
    let state = AppState {
        store,
        grants,
        mailbox,
        max_skew_secs,
    };

    // Full paths (no `nest`): the auth middleware reconstructs the request path
    // from the URI to re-derive the signed descriptor, and `nest` would rewrite
    // that URI to the prefix-stripped form the client never signed.
    let authed = Router::new()
        .route("/v0/blobs", get(routes::list_blobs))
        .route(
            "/v0/blobs/{id}",
            put(routes::put_blob)
                .get(routes::get_blob)
                .delete(routes::delete_blob),
        )
        .route("/v0/grants", get(routes::list_grants))
        .route(
            "/v0/grants/{grantee}",
            put(routes::put_grant).delete(routes::delete_grant),
        )
        .route("/v0/shared", get(routes::list_shared))
        .route("/v0/shared/{owner}/blobs", get(routes::list_shared_blobs))
        .route(
            "/v0/shared/{owner}/blobs/{id}",
            get(routes::get_shared_blob),
        )
        .route("/v0/mailbox", get(routes::list_mailbox))
        .route(
            "/v0/mailbox/{id}",
            get(routes::get_mailbox).delete(routes::delete_mailbox),
        )
        .route("/v0/mailbox/{recipient}/{id}", put(routes::put_mailbox))
        .route_layer(middleware::from_fn_with_state(
            state.clone(),
            auth::require_auth,
        ));

    Router::new()
        .route("/health", get(routes::health))
        .route("/v0/info", get(routes::info))
        .merge(authed)
        .with_state(state)
        // Outermost, so even rejections (401) carry CORS headers and the browser
        // can read them. Any origin is safe: auth is a per-request signature with
        // no cookies, so a hostile origin gains nothing.
        .layer(CorsLayer::permissive())
}
