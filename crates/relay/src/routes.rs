//! Request handlers. The blob handlers are reached only behind the auth
//! middleware, so they trust the [`Owner`] extension and scope every operation to
//! it — one identity can never see another's blobs.

use axum::{
    body::Bytes,
    extract::{Path, State},
    http::{header, StatusCode},
    response::{IntoResponse, Response},
    Extension, Json,
};
use serde::Serialize;
use svastha_core::CONTRACT_VERSION;

use crate::auth::Owner;
use crate::AppState;

/// Liveness probe (unauthenticated).
pub async fn health() -> &'static str {
    "ok"
}

#[derive(Serialize)]
pub struct Info {
    contract_version: u32,
}

/// Contract-version negotiation (unauthenticated).
pub async fn info() -> Json<Info> {
    Json(Info {
        contract_version: CONTRACT_VERSION,
    })
}

/// Store (or replace) a blob for the authenticated owner.
pub async fn put_blob(
    State(state): State<AppState>,
    Extension(owner): Extension<Owner>,
    Path(id): Path<String>,
    body: Bytes,
) -> Result<StatusCode, StatusCode> {
    if !valid_id(&id) {
        return Err(StatusCode::BAD_REQUEST);
    }
    state
        .store
        .put(&owner.0, &id, body.to_vec())
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(StatusCode::NO_CONTENT)
}

/// Fetch a blob owned by the caller, as opaque octets.
pub async fn get_blob(
    State(state): State<AppState>,
    Extension(owner): Extension<Owner>,
    Path(id): Path<String>,
) -> Response {
    if !valid_id(&id) {
        return StatusCode::BAD_REQUEST.into_response();
    }
    match state.store.get(&owner.0, &id) {
        Ok(Some(blob)) => {
            ([(header::CONTENT_TYPE, "application/octet-stream")], blob).into_response()
        }
        Ok(None) => StatusCode::NOT_FOUND.into_response(),
        Err(_) => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    }
}

#[derive(Serialize)]
pub struct BlobList {
    ids: Vec<String>,
}

/// List the ids the caller has stored.
pub async fn list_blobs(
    State(state): State<AppState>,
    Extension(owner): Extension<Owner>,
) -> Result<Json<BlobList>, StatusCode> {
    let ids = state
        .store
        .list(&owner.0)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(Json(BlobList { ids }))
}

/// Delete a blob owned by the caller.
pub async fn delete_blob(
    State(state): State<AppState>,
    Extension(owner): Extension<Owner>,
    Path(id): Path<String>,
) -> StatusCode {
    if !valid_id(&id) {
        return StatusCode::BAD_REQUEST;
    }
    match state.store.delete(&owner.0, &id) {
        Ok(true) => StatusCode::NO_CONTENT,
        Ok(false) => StatusCode::NOT_FOUND,
        Err(_) => StatusCode::INTERNAL_SERVER_ERROR,
    }
}

/// A blob id is a short, filesystem-safe token — no path separators, never `.`
/// or `..` — so it is safe to use directly as a filename in the filesystem store
/// (and as a map key in the in-memory one).
fn valid_id(id: &str) -> bool {
    (1..=128).contains(&id.len())
        && id != "."
        && id != ".."
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
}
