//! Per-request authentication. Every `/v0/blobs` request carries three hex
//! headers — the caller's Ed25519 public key, a Unix-seconds timestamp, and a
//! signature over the canonical request descriptor defined by the trust contract
//! (`svastha_core::relay`). The relay reconstructs that descriptor from the
//! actual request and verifies it; it holds no keys and depends on `core` only
//! for the verify primitive.

use std::time::{SystemTime, UNIX_EPOCH};

use axum::{
    body::{to_bytes, Body},
    extract::{Request, State},
    http::{HeaderMap, StatusCode},
    middleware::Next,
    response::Response,
};
use svastha_core::relay::{verify_request, AuthRequest};

use crate::AppState;

/// Maximum accepted request-body size (16 MiB). A blob larger than this is
/// rejected before signature verification.
pub const MAX_BODY: usize = 16 * 1024 * 1024;

/// The authenticated owner of a request: their Ed25519 public key. Inserted into
/// request extensions by [`require_auth`] and extracted by the handlers.
#[derive(Clone, Copy)]
pub struct Owner(pub [u8; 32]);

/// Auth middleware. Verifies the signed-request headers against the actual
/// request and, on success, tags the request with its [`Owner`].
pub async fn require_auth(
    State(state): State<AppState>,
    request: Request,
    next: Next,
) -> Result<Response, StatusCode> {
    let (mut parts, body) = request.into_parts();

    let public_key = hex_header::<32>(&parts.headers, "svastha-public-key")?;
    let signature = hex_header::<64>(&parts.headers, "svastha-signature")?;
    let timestamp: u64 = parts
        .headers
        .get("svastha-timestamp")
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.parse().ok())
        .ok_or(StatusCode::UNAUTHORIZED)?;

    // Replay window: the signed timestamp must be close to the relay's clock.
    if now_unix().abs_diff(timestamp) > state.max_skew_secs {
        return Err(StatusCode::UNAUTHORIZED);
    }

    // The signed path is the path plus query string, exactly as sent.
    // `AuthRequest::new` copies these, so borrow `parts` rather than allocate.
    let method = parts.method.as_str();
    let path = parts
        .uri
        .path_and_query()
        .map(|pq| pq.as_str())
        .unwrap_or_else(|| parts.uri.path());

    let bytes = to_bytes(body, MAX_BODY)
        .await
        .map_err(|_| StatusCode::PAYLOAD_TOO_LARGE)?;

    let auth = AuthRequest::new(method, path, &bytes, timestamp);
    if !verify_request(&public_key, &signature, &auth) {
        return Err(StatusCode::UNAUTHORIZED);
    }

    parts.extensions.insert(Owner(public_key));
    Ok(next
        .run(Request::from_parts(parts, Body::from(bytes)))
        .await)
}

/// Decode a fixed-length hex header, or `401` if it is missing or malformed.
fn hex_header<const N: usize>(headers: &HeaderMap, name: &str) -> Result<[u8; N], StatusCode> {
    headers
        .get(name)
        .and_then(|v| v.to_str().ok())
        .and_then(|s| hex::decode(s).ok())
        .and_then(|bytes| bytes.try_into().ok())
        .ok_or(StatusCode::UNAUTHORIZED)
}

fn now_unix() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}
