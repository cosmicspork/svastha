//! Shared test harness for the relay's integration tests: signed-request
//! building and a default in-memory router. Lives under `tests/common/` (not a
//! top-level `tests/*.rs` file) so Cargo treats it as a plain module, not its
//! own integration-test binary — each test file opts in with `mod common;`.

#![allow(dead_code)] // not every test file exercises every helper

use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use axum::body::{to_bytes, Body};
use axum::http::Request;
use svastha_core::keys::Identity;
use svastha_core::relay::{sign_request, AuthRequest};
use svastha_relay::app;
use svastha_relay::grants::MemoryGrantStore;
use svastha_relay::mailbox::MemoryMailboxStore;
use svastha_relay::share::MemoryShareStore;
use svastha_relay::store::MemoryStore;

pub const SKEW: u64 = 300;

pub fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs()
}

/// A router over fresh in-memory stores (blobs, grants, mailbox) — the default
/// harness for tests that don't need to inspect a store directly or rebuild the
/// router over the same backing storage.
pub fn router() -> axum::Router {
    app(
        Arc::new(MemoryStore::new()),
        Arc::new(MemoryGrantStore::new()),
        Arc::new(MemoryMailboxStore::new()),
        Arc::new(MemoryShareStore::new()),
        SKEW,
        None,
        None,
    )
}

/// Build a request and attach the three signed-auth headers for `signer`.
pub fn signed(
    signer: &Identity,
    method: &str,
    path: &str,
    body: &[u8],
    timestamp: u64,
) -> Request<Body> {
    let auth = AuthRequest::new(method, path, body, timestamp);
    let signature = sign_request(signer, &auth);
    Request::builder()
        .method(method)
        .uri(path)
        .header(
            "svastha-public-key",
            hex::encode(signer.verifying_key().to_bytes()),
        )
        .header("svastha-timestamp", timestamp.to_string())
        .header("svastha-signature", hex::encode(signature))
        .body(Body::from(body.to_vec()))
        .unwrap()
}

pub async fn body_bytes(response: axum::response::Response) -> Vec<u8> {
    to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap()
        .to_vec()
}
