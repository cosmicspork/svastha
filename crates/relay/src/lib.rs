//! Svastha relay: a zero-knowledge store-and-forward server for encrypted blobs.
//!
//! The relay holds no keys and never decrypts. It authenticates every blob
//! request by an Ed25519 signature (the contract lives in `svastha_core::relay`),
//! scopes storage to the authenticated owner, and stores opaque ciphertext it
//! cannot read. See `docs/ARCHITECTURE.md` and `spec/README.md`.
//!
//! [`app`] builds the router for a given [`store::BlobStore`]; the binary
//! ([`main`](../main.rs)) wires it to an in-memory store and `axum::serve`.

pub mod auth;
pub mod routes;
pub mod store;

use std::sync::Arc;

use axum::{
    middleware,
    routing::{get, put},
    Router,
};

use store::BlobStore;

/// Shared handler state: the blob store and the auth freshness window.
#[derive(Clone)]
pub struct AppState {
    pub store: Arc<dyn BlobStore>,
    pub max_skew_secs: u64,
}

/// Build the relay router. `max_skew_secs` is how far a request's signed
/// timestamp may differ from the relay's clock (replay window).
pub fn app(store: Arc<dyn BlobStore>, max_skew_secs: u64) -> Router {
    let state = AppState {
        store,
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
        .route_layer(middleware::from_fn_with_state(
            state.clone(),
            auth::require_auth,
        ));

    Router::new()
        .route("/health", get(routes::health))
        .route("/v0/info", get(routes::info))
        .merge(authed)
        .with_state(state)
}
