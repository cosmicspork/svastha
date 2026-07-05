//! Request handlers. The blob, grant, and mailbox handlers are reached only
//! behind the auth middleware, so they trust the [`Owner`] extension and scope
//! every operation to it — one identity can never see another's blobs, grants,
//! or mailbox items except where a grant explicitly says otherwise (the
//! `/v0/shared/*` handlers).

use axum::{
    body::Bytes,
    extract::{Path, State},
    http::{header, HeaderName, StatusCode},
    response::{IntoResponse, Response},
    Extension, Json,
};
use serde::Serialize;
use svastha_core::CONTRACT_VERSION;

use crate::auth::Owner;
use crate::AppState;

/// Maximum mailbox item size: it carries one wrapped vault key plus a small
/// JSON envelope, never anything larger, so a low cap keeps the mailbox from
/// becoming a general-purpose (spammable) blob store.
pub const MAILBOX_MAX_BODY: usize = 4096;

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

/// Parse a path segment as a 64-lowercase-hex-char public key (an owner,
/// grantee, or mailbox recipient). Anything else — wrong length, uppercase,
/// non-hex — is rejected so a malformed identity never reaches a store.
fn valid_pubkey_hex(s: &str) -> Option<[u8; 32]> {
    if s.len() != 64
        || !s
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return None;
    }
    hex::decode(s).ok()?.try_into().ok()
}

// --- grants: relay-level read authorization, pure routing metadata ---

/// Authorize `grantee` (the caller's partner) to read the caller's shared
/// blobs. Idempotent — granting an already-grantee is a no-op success.
pub async fn put_grant(
    State(state): State<AppState>,
    Extension(owner): Extension<Owner>,
    Path(grantee_hex): Path<String>,
) -> Result<StatusCode, StatusCode> {
    let grantee = valid_pubkey_hex(&grantee_hex).ok_or(StatusCode::BAD_REQUEST)?;
    state
        .grants
        .put(&owner.0, &grantee)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(StatusCode::NO_CONTENT)
}

/// Revoke a grant. Only stops future reads — it cannot retract anything the
/// grantee has already synced (see `docs/ARCHITECTURE.md`, "Vaults and grants");
/// the UI is responsible for saying so.
pub async fn delete_grant(
    State(state): State<AppState>,
    Extension(owner): Extension<Owner>,
    Path(grantee_hex): Path<String>,
) -> StatusCode {
    let Some(grantee) = valid_pubkey_hex(&grantee_hex) else {
        return StatusCode::BAD_REQUEST;
    };
    match state.grants.delete(&owner.0, &grantee) {
        Ok(true) => StatusCode::NO_CONTENT,
        Ok(false) => StatusCode::NOT_FOUND,
        Err(_) => StatusCode::INTERNAL_SERVER_ERROR,
    }
}

#[derive(Serialize)]
pub struct GranteeList {
    grantees: Vec<String>,
}

/// List everyone the caller has granted read access to.
pub async fn list_grants(
    State(state): State<AppState>,
    Extension(owner): Extension<Owner>,
) -> Result<Json<GranteeList>, StatusCode> {
    let grantees = state
        .grants
        .grantees_of(&owner.0)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(Json(GranteeList {
        grantees: grantees.iter().map(hex::encode).collect(),
    }))
}

// --- shared: reading a vault someone else granted the caller ---

#[derive(Serialize)]
pub struct OwnerList {
    owners: Vec<String>,
}

/// List everyone who has granted the caller read access to their vault.
pub async fn list_shared(
    State(state): State<AppState>,
    Extension(caller): Extension<Owner>,
) -> Result<Json<OwnerList>, StatusCode> {
    let owners = state
        .grants
        .granters_to(&caller.0)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(Json(OwnerList {
        owners: owners.iter().map(hex::encode).collect(),
    }))
}

/// List `owner`'s blob ids, gated on a live grant from `owner` to the caller.
/// `404` for a missing grant, exactly as for a missing blob below — a caller
/// probing an ungranted owner cannot distinguish "not shared with you" from
/// "nothing there" (see [`get_shared_blob`]'s doc comment).
pub async fn list_shared_blobs(
    State(state): State<AppState>,
    Extension(caller): Extension<Owner>,
    Path(owner_hex): Path<String>,
) -> Result<Json<BlobList>, StatusCode> {
    let owner = valid_pubkey_hex(&owner_hex).ok_or(StatusCode::BAD_REQUEST)?;
    if !state
        .grants
        .has(&owner, &caller.0)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
    {
        return Err(StatusCode::NOT_FOUND);
    }
    let ids = state
        .store
        .list(&owner)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(Json(BlobList { ids }))
}

/// Fetch a blob from `owner`'s vault, gated on a live grant from `owner` to the
/// caller. A missing grant and a missing blob both answer `404`: if "no grant"
/// answered differently (say, `403`), a caller could probe an arbitrary public
/// key and learn whether it grants them access, which leaks the sharing graph
/// — metadata the relay is supposed to keep opaque to everyone but the two
/// parties. One status code for both cases keeps that graph unobservable.
pub async fn get_shared_blob(
    State(state): State<AppState>,
    Extension(caller): Extension<Owner>,
    Path((owner_hex, id)): Path<(String, String)>,
) -> Response {
    let Some(owner) = valid_pubkey_hex(&owner_hex) else {
        return StatusCode::BAD_REQUEST.into_response();
    };
    if !valid_id(&id) {
        return StatusCode::BAD_REQUEST.into_response();
    }
    match state.grants.has(&owner, &caller.0) {
        Ok(true) => {}
        Ok(false) => return StatusCode::NOT_FOUND.into_response(),
        Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    }
    match state.store.get(&owner, &id) {
        Ok(Some(blob)) => {
            ([(header::CONTENT_TYPE, "application/octet-stream")], blob).into_response()
        }
        Ok(None) => StatusCode::NOT_FOUND.into_response(),
        Err(_) => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    }
}

// --- mailbox: a store-and-forward drop box for wrapped vault keys ---

/// Deposit an item for `recipient`. Any authed identity may deposit into any
/// mailbox — there is no grant check here, because the payload is opaque
/// ciphertext the recipient decides whether to trust (see the accept flow in
/// `web/src/lib/exchange.ts`), and depositing costs the sender nothing an
/// attacker would want (it cannot read or overwrite anyone else's item; ids
/// are scoped per recipient).
pub async fn put_mailbox(
    State(state): State<AppState>,
    Extension(from): Extension<Owner>,
    Path((recipient_hex, id)): Path<(String, String)>,
    body: Bytes,
) -> Result<StatusCode, StatusCode> {
    let recipient = valid_pubkey_hex(&recipient_hex).ok_or(StatusCode::BAD_REQUEST)?;
    if !valid_id(&id) {
        return Err(StatusCode::BAD_REQUEST);
    }
    if body.len() > MAILBOX_MAX_BODY {
        return Err(StatusCode::PAYLOAD_TOO_LARGE);
    }
    state
        .mailbox
        .put(&recipient, &id, from.0, body.to_vec())
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Serialize)]
pub struct MailboxItemSummary {
    id: String,
    from: String,
}

#[derive(Serialize)]
pub struct MailboxList {
    items: Vec<MailboxItemSummary>,
}

/// List the caller's mailbox items (no bodies — just enough to decide what to
/// fetch).
pub async fn list_mailbox(
    State(state): State<AppState>,
    Extension(caller): Extension<Owner>,
) -> Result<Json<MailboxList>, StatusCode> {
    let items = state
        .mailbox
        .list(&caller.0)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(Json(MailboxList {
        items: items
            .into_iter()
            .map(|(id, from)| MailboxItemSummary {
                id,
                from: hex::encode(from),
            })
            .collect(),
    }))
}

/// Fetch one of the caller's mailbox items. The depositor's identity travels
/// as the `svastha-from` response header — the relay attests who deposited it
/// (their signature verified through the auth middleware), which the client
/// then binds to the payload's claimed identity (see `web/src/lib/exchange.ts`).
pub async fn get_mailbox(
    State(state): State<AppState>,
    Extension(caller): Extension<Owner>,
    Path(id): Path<String>,
) -> Response {
    if !valid_id(&id) {
        return StatusCode::BAD_REQUEST.into_response();
    }
    match state.mailbox.get(&caller.0, &id) {
        Ok(Some((blob, from))) => {
            let headers = [
                (header::CONTENT_TYPE, "application/octet-stream".to_string()),
                (HeaderName::from_static("svastha-from"), hex::encode(from)),
            ];
            (headers, blob).into_response()
        }
        Ok(None) => StatusCode::NOT_FOUND.into_response(),
        Err(_) => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    }
}

/// Delete one of the caller's mailbox items (accept or decline both end with
/// this).
pub async fn delete_mailbox(
    State(state): State<AppState>,
    Extension(caller): Extension<Owner>,
    Path(id): Path<String>,
) -> StatusCode {
    if !valid_id(&id) {
        return StatusCode::BAD_REQUEST;
    }
    match state.mailbox.delete(&caller.0, &id) {
        Ok(true) => StatusCode::NO_CONTENT,
        Ok(false) => StatusCode::NOT_FOUND,
        Err(_) => StatusCode::INTERNAL_SERVER_ERROR,
    }
}
