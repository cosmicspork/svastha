//! Request handlers. The blob, grant, and mailbox handlers are reached only
//! behind the auth middleware, so they trust the [`Owner`] extension and scope
//! every operation to it — one identity can never see another's blobs, grants,
//! or mailbox items except where a grant explicitly says otherwise (the
//! `/v0/shared/*` handlers).

use std::time::{SystemTime, UNIX_EPOCH};

use axum::{
    body::Bytes,
    extract::{Path, State},
    http::{header, HeaderMap, HeaderName, StatusCode},
    response::{Html, IntoResponse, Response},
    Extension, Json,
};
use qrcode::{render::svg, QrCode};
use serde::Serialize;
use svastha_core::CONTRACT_VERSION;

use crate::auth::Owner;
use crate::share::{ShareState, TombstoneReason};
use crate::AppState;

/// Maximum mailbox item size: it carries one wrapped vault key plus a small
/// JSON envelope, never anything larger, so a low cap keeps the mailbox from
/// becoming a general-purpose (spammable) blob store.
pub const MAILBOX_MAX_BODY: usize = 4096;

/// Maximum sealed share-bundle size (8 MiB). Distinct from (and below) the
/// global [`crate::auth::MAX_BODY`] blob cap: a share is a re-encrypted subset
/// of a record built for one recipient, not a whole vault, so it gets its own,
/// tighter ceiling without touching the blob contract.
pub const SHARE_MAX_BODY: usize = 8 * 1024 * 1024;

/// Hard ceiling on a share's lifetime: the relay clamps any requested expiry to
/// at most this far in the future (30 days). The client picks a shorter default
/// (7 days); that is a client concern. The clamp bounds how long an
/// unauthenticated bearer link can keep working.
pub const SHARE_MAX_TTL_SECS: u64 = 30 * 24 * 60 * 60;

/// How long a tombstone (the marker left by expiry or revocation) is retained
/// before [`crate::share::ShareStore::sweep`] deletes it (90 days). Long enough
/// that a recipient hitting a stale link still gets `410 Gone` rather than a
/// confusing `404` well after the share ended.
pub const SHARE_TOMBSTONE_MAX_AGE_SECS: u64 = 90 * 24 * 60 * 60;

/// Request header carrying the owner's desired share expiry as Unix seconds. It
/// is advisory — the relay clamps it to [`SHARE_MAX_TTL_SECS`] and defaults to
/// that ceiling if the header is absent or unparseable.
pub const SHARE_EXPIRES_HEADER: &str = "svastha-share-expires";

/// A share token is a bearer secret, so beyond the blob-id charset it must be
/// long enough to be unguessable: ≥ 22 chars of the `[A-Za-z0-9._-]` alphabet
/// is ≈ 128 bits of entropy when the client fills it with a CSPRNG.
const MIN_SHARE_TOKEN_LEN: usize = 22;

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

// --- landing page: relay → device QR linking (unauthenticated) ---

/// The relay's self-describing landing page: states its zero-knowledge role
/// and shows a QR carrying its own public address, so a phone's native camera
/// app can open it directly — no in-app scanner, no new protocol, the QR just
/// encodes a URL (see `docs/ARCHITECTURE.md`'s Relay section and
/// `web/src/routes/Onboard.svelte` for the other half of the flow).
const LANDING_TEMPLATE: &str = include_str!("landing.html");

/// Serve the landing page. The relay's own address is derived from this
/// request's headers, never configured, so it's always correct for whatever
/// host or port the caller actually reached.
pub async fn landing(State(state): State<AppState>, headers: HeaderMap) -> Html<String> {
    let proto = headers
        .get("x-forwarded-proto")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("http");
    let host = headers.get(header::HOST).and_then(|v| v.to_str().ok());

    // `Host` is attacker-influenced (a raw HTTP client can send anything), and
    // it ends up both encoded into the QR and echoed as plain text below it
    // (see `render_qr_card`) — so this is never allowed to be missing, and the
    // text form is always HTML-escaped before being embedded.
    let qr_card = match host {
        Some(host) => {
            let base_url = format!("{proto}://{host}");
            let target = match &state.app_url {
                // Device → device linking (Settings' "Link another device")
                // lands the new device straight on restore with the relay
                // prefilled; see `web/src/routes/Onboard.svelte`.
                Some(app_url) => format!("{app_url}/#/onboard?relay={base_url}"),
                None => base_url,
            };
            render_qr_card(&target)
        }
        // No `Host` header (unusual, but not impossible): there is no address
        // to show, so skip the QR and say so in words rather than render a
        // broken or empty one.
        None => degenerate_card("this relay"),
    };

    let html = LANDING_TEMPLATE
        .replace("{qr_card}", &qr_card)
        .replace("{contract_version}", &CONTRACT_VERSION.to_string());
    Html(html)
}

/// Render `target` as an inline SVG QR on a white card, with the same address
/// repeated underneath as small selectable text (the page's own "or paste the
/// address by hand" instruction needs something to paste). QR encoding can
/// fail for a pathologically long `target` (an oversized `Host` header) —
/// degrade to the same no-QR fallback as a missing `Host` rather than panic.
fn render_qr_card(target: &str) -> String {
    match QrCode::new(target.as_bytes()) {
        Ok(code) => {
            let svg = code
                .render::<svg::Color>()
                .min_dimensions(220, 220)
                .dark_color(svg::Color("#1a231f"))
                .light_color(svg::Color("#ffffff"))
                .build();
            format!(
                r#"<div class="card">{svg}</div><p class="address">{}</p>"#,
                escape_html(target)
            )
        }
        Err(_) => degenerate_card(target),
    }
}

fn degenerate_card(text: &str) -> String {
    format!(r#"<p class="address">{}</p>"#, escape_html(text))
}

/// Minimal HTML-text escaping for the one dynamic value this page ever
/// reflects: the caller's own `Host` header, echoed back as the paste-by-hand
/// address. Defensive, not a formatting nicety — `Host` is attacker-supplied.
fn escape_html(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
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

// --- shares: sealed bundles fetched by an unguessable bearer token ---

/// A share token reuses the blob-id charset but must additionally be long enough
/// to be unguessable (see [`MIN_SHARE_TOKEN_LEN`]) — the read path is
/// unauthenticated, so the token *is* the credential.
fn valid_share_token(token: &str) -> bool {
    token.len() >= MIN_SHARE_TOKEN_LEN && valid_id(token)
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Upload (or replace) a sealed share bundle for the authenticated owner. The
/// body is the opaque ciphertext; the per-share key that decrypts it never
/// reaches the relay (it rides the link's URL fragment). The owner's desired
/// expiry arrives in the [`SHARE_EXPIRES_HEADER`] and is clamped to
/// [`SHARE_MAX_TTL_SECS`]. Create-or-replace, but only for the token's creating
/// owner: a second PUT by the same identity overwrites the bundle (and revives
/// a tombstoned token), while any other authenticated identity — say, a share
/// recipient who also holds a relay account — gets the same `404` as
/// [`delete_share`]'s wrong-owner branch, so it can neither hijack a live token
/// nor squat on a tombstoned one.
pub async fn put_share(
    State(state): State<AppState>,
    Extension(owner): Extension<Owner>,
    Path(token): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<StatusCode, StatusCode> {
    if !valid_share_token(&token) {
        return Err(StatusCode::BAD_REQUEST);
    }
    if body.len() > SHARE_MAX_BODY {
        return Err(StatusCode::PAYLOAD_TOO_LARGE);
    }
    // A token, once used, is bound to its creating owner — live or tombstoned.
    match state.shares.owner(&token) {
        Ok(Some((stored, _))) if stored != owner.0 => return Err(StatusCode::NOT_FOUND),
        Ok(_) => {}
        Err(_) => return Err(StatusCode::INTERNAL_SERVER_ERROR),
    }
    let now = now_secs();
    let ceiling = now.saturating_add(SHARE_MAX_TTL_SECS);
    let requested = headers
        .get(SHARE_EXPIRES_HEADER)
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.parse::<u64>().ok())
        .unwrap_or(ceiling);
    let expires_at = requested.min(ceiling);
    state
        .shares
        .put(&token, owner.0, body.to_vec(), now, expires_at)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(StatusCode::NO_CONTENT)
}

/// Fetch a share bundle by token. **This is the system's only unauthenticated
/// read**, deliberately: the recipient is a doctor with a link, not a Svastha
/// identity. Because the token is itself a ≥128-bit bearer secret, only someone
/// handed the link can probe it, so — unlike the grants' two-404 non-leak rule —
/// this endpoint distinguishes gone from never-existed to give a better error:
/// `200` live, `410 Gone` for an expired (detected and tombstoned lazily here)
/// or revoked share, `404` for a token that never existed. See `spec/README.md`.
pub async fn get_share(State(state): State<AppState>, Path(token): Path<String>) -> Response {
    if !valid_share_token(&token) {
        return StatusCode::BAD_REQUEST.into_response();
    }
    match state.shares.get(&token) {
        Ok(ShareState::Missing) => StatusCode::NOT_FOUND.into_response(),
        Ok(ShareState::Tombstone { .. }) => StatusCode::GONE.into_response(),
        Ok(ShareState::Live { expires_at, .. }) if expires_at <= now_secs() => {
            // Lazy expiry: drop the bundle bytes and leave a tombstone so this
            // and later fetches answer 410, not 404, and stop serving content.
            let _ = state
                .shares
                .tombstone(&token, TombstoneReason::Expired, now_secs());
            StatusCode::GONE.into_response()
        }
        Ok(ShareState::Live { sealed_bundle, .. }) => (
            [(header::CONTENT_TYPE, "application/octet-stream")],
            sealed_bundle,
        )
            .into_response(),
        Err(_) => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    }
}

/// Revoke a share: the authenticated caller must be the stored owner. A mismatch
/// answers `404`, the same as a token that never existed — a stranger who
/// somehow guessed the token learns nothing about whether it exists (the same
/// non-leak posture as the grants' unauthorized-access `404`). Revoking drops
/// the bundle bytes and leaves a `revoked` tombstone; revocation only stops
/// *future* fetches and cannot recall what was already pulled (the client says
/// so). `204` on success, `404` if the token never existed.
pub async fn delete_share(
    State(state): State<AppState>,
    Extension(owner): Extension<Owner>,
    Path(token): Path<String>,
) -> StatusCode {
    if !valid_share_token(&token) {
        return StatusCode::BAD_REQUEST;
    }
    match state.shares.owner(&token) {
        Ok(None) => StatusCode::NOT_FOUND,
        // Not the caller's share → indistinguishable from "never existed".
        Ok(Some((stored, _))) if stored != owner.0 => StatusCode::NOT_FOUND,
        Ok(Some((_, is_live))) => {
            if is_live {
                match state
                    .shares
                    .tombstone(&token, TombstoneReason::Revoked, now_secs())
                {
                    Ok(_) => StatusCode::NO_CONTENT,
                    Err(_) => StatusCode::INTERNAL_SERVER_ERROR,
                }
            } else {
                // Already tombstoned (expired or a prior revoke): revoke is idempotent.
                StatusCode::NO_CONTENT
            }
        }
        Err(_) => StatusCode::INTERNAL_SERVER_ERROR,
    }
}
