//! Request handlers. The blob, grant, and mailbox handlers are reached only
//! behind the auth middleware, so they trust the [`Owner`] extension and scope
//! every operation to it — one identity can never see another's blobs, grants,
//! or mailbox items except where a grant explicitly says otherwise (the
//! `/v0/shared/*` handlers).

use std::convert::Infallible;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use axum::{
    body::Bytes,
    extract::{Path, Query, State},
    http::{header, HeaderMap, HeaderName, HeaderValue, StatusCode},
    response::{
        sse::{Event, KeepAlive, Sse},
        Html, IntoResponse, Response,
    },
    Extension, Json,
};
use qrcode::{render::svg, QrCode};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use svastha_core::CONTRACT_VERSION;
use tokio_stream::{wrappers::BroadcastStream, Stream, StreamExt};

use crate::auth::Owner;
use crate::grants::Grant;
use crate::pokes::Poke;
use crate::push::{subscription_key, Subscription};
use crate::share::{ShareState, TombstoneReason};
use crate::store::BlobStore;
use crate::AppState;

/// SSE heartbeat interval. A comment line every this often keeps the long-lived
/// stream from being idled out by an intermediary — load balancers and reverse
/// proxies commonly close a connection after ~60s of silence, so a keepalive
/// comfortably inside that closes the gap. Operators terminating TLS in front of
/// the relay should set the proxy read/idle timeout above this interval (see the
/// relay README). Heartbeats are payload-free comments, never content.
const SSE_HEARTBEAT: Duration = Duration::from_secs(30);

/// Maximum mailbox item size: it carries one wrapped vault key plus a small
/// JSON envelope, never anything larger, so a low cap keeps the mailbox from
/// becoming a general-purpose (spammable) blob store.
pub const MAILBOX_MAX_BODY: usize = 4096;

/// Maximum sealed share-bundle size (8 MiB). Distinct from (and below) the
/// global [`crate::auth::MAX_BODY`] blob cap: a share is a re-encrypted subset
/// of a record built for one recipient, not a whole vault, so it gets its own,
/// tighter ceiling without touching the blob contract.
pub const SHARE_MAX_BODY: usize = 8 * 1024 * 1024;

/// Byte budget for one framed listing page (`?include=body`, see
/// [`framed_page`]). Distinct in kind from the caps above: those bound what a
/// client may *send*, this bounds how much the relay accumulates in memory
/// before answering one listing — 8 MiB keeps a batched page's cost in the same
/// range as a single large blob fetch.
pub const BATCH_BYTE_BUDGET: usize = 8 * 1024 * 1024;

/// Response header carrying a framed page's continuation cursor. A pure
/// sequence of frames has nowhere to put a JSON sibling field, so the same
/// opaque token the JSON listing returns as `next` travels in a header here.
/// Lowercase because [`HeaderName::from_static`] accepts nothing else.
pub const NEXT_HEADER: &str = "svastha-next";

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

/// Upper bounds on a grant's prefix allowlist, so a `PUT /v0/grants/{grantee}`
/// body cannot bloat the stored routing metadata. A blob id is at most 128 chars
/// (see [`valid_id`]), so a prefix never usefully exceeds that; the count cap is
/// generous for the handful of namespaces (`ev-`, `att-`, `doc-`, `cur-`) a real
/// grant scopes to. Neither bounds security — they only keep the metadata small.
const MAX_GRANT_PREFIXES: usize = 16;
const MAX_GRANT_PREFIX_LEN: usize = 128;

/// Maximum accepted `PUT`/`DELETE /v0/push` body. A Web Push subscription is a
/// small JSON object (endpoint URL plus two short base64url keys); a low cap
/// keeps the subscription store from being used as a general-purpose scratch
/// space and bounds the parse cost.
const MAX_PUSH_BODY: usize = 4096;

/// Page size used when a listing request opts into pagination (`?limit=` or
/// `?cursor=`) without specifying an explicit `limit` — a client that only
/// carries a `next` cursor forward without repeating `limit` still gets a
/// sane page rather than one huge one.
const DEFAULT_PAGE_SIZE: usize = 200;

/// Ceiling a requested `limit` is clamped to, so an oversized page request
/// cannot make one listing call as expensive as the unpaginated one it exists
/// to avoid. Clamped, not rejected — the same posture as the share expiry
/// clamp — so a client that asks for too much still gets a usable answer.
const MAX_PAGE_SIZE: usize = 1000;

/// A cursor is opaque and unvalidated beyond this length cap: it is only ever
/// compared as a sort boundary against blob ids (at most 128 chars, see
/// [`valid_id`]), so nothing legitimate is ever near this long — the cap only
/// bounds the cost of a hostile query string.
const MAX_CURSOR_LEN: usize = 256;

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

// --- push channel: payload-free SSE pokes (authenticated) ---

/// Long-lived `text/event-stream` of payload-free pokes for the authenticated
/// caller. Each poke is a "go pull" hint — an SSE `event:` naming which pull to
/// run (`blobs` or `mailbox`), never a blob id, count, owner, or any content.
/// The pull path stays the single source of truth, so this channel is lossy by
/// design: a client that misses a poke (disconnected, or lagging past the
/// buffer) simply finds the change on its next pull, at no correctness cost.
///
/// Subscription happens here, before the response is returned, so a poke that
/// races the connection handshake is delivered rather than lost between them.
pub async fn events(
    State(state): State<AppState>,
    Extension(owner): Extension<Owner>,
) -> Sse<impl Stream<Item = Result<Event, Infallible>>> {
    let stream = BroadcastStream::new(state.pokes.subscribe(&owner.0)).map(|result| {
        let event = match result {
            Ok(poke) => Event::default().event(poke.event_name()),
            // The stream fell behind and dropped pokes (past the channel
            // buffer). Lossy by design: emit one generic "pull everything" hint
            // rather than name a class, and the full pull reconciles regardless.
            Err(_) => Event::default().event("sync"),
        };
        // A single non-informative data byte so the event dispatches in a strict
        // SSE parser (an event with an empty data buffer is not dispatched); the
        // routing hint rides the event name, never the data.
        Ok(event.data("1"))
    });
    Sse::new(stream).keep_alive(KeepAlive::new().interval(SSE_HEARTBEAT))
}

/// Poke everyone who can read `owner`'s vault that a blob `id` changed: the
/// owner's own other devices (always — the owner reads their whole vault), plus
/// every grantee whose grant would actually let them *see* that id. A grantee is
/// skipped when its grant is expired or its prefix allowlist excludes `id`, so a
/// scoped-out grantee is not woken for a write it cannot read. Best-effort and
/// never fails the write — a missed poke is corrected by the next pull, and a
/// *spurious* poke to a scoped-out grantee would only cost a harmless empty pull,
/// so scoping here is a courtesy, not a correctness or leak boundary (a poke
/// carries no id — the grantee never learns which blob changed). Grant lookup
/// errors are swallowed for the same reason (the push channel is an
/// optimization, not a source of truth).
fn poke_vault_readers(state: &AppState, owner: &[u8; 32], id: &str) {
    poke_identity(state, owner, Poke::Blobs);
    let Ok(grantees) = state.grants.grantees_of(owner) else {
        return;
    };
    let now = now_secs();
    for grantee in grantees {
        match state.grants.get(owner, &grantee) {
            Ok(Some(grant)) if !grant.is_expired(now) && grant.admits(id) => {
                poke_identity(state, &grantee, Poke::Blobs);
            }
            _ => {}
        }
    }
}

/// Deliver a poke to an identity over *both* legs of the bus: the live SSE
/// streams (real-time, always) and — for an identity with registered Web Push
/// subscriptions and no live stream — Web Push (see [`crate::push`]). The Web
/// Push leg is a no-op when push is unconfigured, is collapsed to at most one
/// send per identity per window, and spawns its network I/O so it never blocks
/// the write that poked.
fn poke_identity(state: &AppState, identity: &[u8; 32], poke: Poke) {
    state.pokes.poke(identity, poke);
    if let Some(push) = state.push.as_ref() {
        push.notify(&state.pokes, *identity);
    }
}

// --- Web Push: subscription registration + VAPID key (authenticated) ---

#[derive(Serialize)]
pub struct VapidKey {
    /// The VAPID public key clients pass as `applicationServerKey` when they
    /// subscribe. Base64url, exactly as `web-push` and the browser expect.
    vapid_public_key: String,
}

/// Return the relay's VAPID public key so the PWA can subscribe with the right
/// `applicationServerKey`. Authenticated like every other `/v0/*` row (the key is
/// not secret, but keeping the endpoint behind the standard handshake avoids a
/// second auth scheme). `503` when the relay was started without a VAPID key —
/// push is optional, and its absence tells the client to stay SSE-only.
pub async fn get_vapid_key(State(state): State<AppState>) -> Response {
    match state.push.as_ref() {
        Some(push) => Json(VapidKey {
            vapid_public_key: push.public_key().to_string(),
        })
        .into_response(),
        None => StatusCode::SERVICE_UNAVAILABLE.into_response(),
    }
}

/// Register (or replace) a Web Push subscription for the authenticated identity.
/// The body is the standard Web Push subscription JSON the browser produces —
/// `{ "endpoint": ..., "keys": { "p256dh": ..., "auth": ... } }`. An identity may
/// hold several subscriptions (one per device/browser); each is keyed by a hash
/// of its endpoint, so re-registering the same device replaces its entry rather
/// than piling up duplicates. `503` when push is unconfigured.
pub async fn put_push(
    State(state): State<AppState>,
    Extension(owner): Extension<Owner>,
    body: Bytes,
) -> StatusCode {
    let Some(push) = state.push.as_ref() else {
        return StatusCode::SERVICE_UNAVAILABLE;
    };
    if body.len() > MAX_PUSH_BODY {
        return StatusCode::PAYLOAD_TOO_LARGE;
    }
    let sub: Subscription = match serde_json::from_slice(&body) {
        Ok(sub) => sub,
        Err(_) => return StatusCode::BAD_REQUEST,
    };
    if sub.endpoint.is_empty() || sub.keys.p256dh.is_empty() || sub.keys.auth.is_empty() {
        return StatusCode::BAD_REQUEST;
    }
    let key = subscription_key(&sub.endpoint);
    match push.store().put(&owner.0, &key, &sub) {
        Ok(()) => StatusCode::NO_CONTENT,
        Err(_) => StatusCode::INTERNAL_SERVER_ERROR,
    }
}

/// The minimal shape a `DELETE /v0/push` body needs: just the endpoint that
/// identifies which of the identity's subscriptions to drop.
#[derive(Deserialize)]
struct PushUnsubscribe {
    endpoint: String,
}

/// Remove a Web Push subscription for the authenticated identity. A body naming a
/// single `{ "endpoint": ... }` removes just that device's subscription; an
/// **empty body deliberately clears every subscription for the identity** (the
/// documented "unsubscribe this whole identity" affordance — e.g. a global "turn
/// off notifications"). Idempotent: `204` whether or not anything matched, so a
/// client can unsubscribe without first checking. `503` when push is unconfigured.
pub async fn delete_push(
    State(state): State<AppState>,
    Extension(owner): Extension<Owner>,
    body: Bytes,
) -> StatusCode {
    let Some(push) = state.push.as_ref() else {
        return StatusCode::SERVICE_UNAVAILABLE;
    };
    if body.len() > MAX_PUSH_BODY {
        return StatusCode::PAYLOAD_TOO_LARGE;
    }
    let result = if body.is_empty() {
        push.store().delete_all(&owner.0).map(|_| ())
    } else {
        let unsub: PushUnsubscribe = match serde_json::from_slice(&body) {
            Ok(u) => u,
            Err(_) => return StatusCode::BAD_REQUEST,
        };
        if unsub.endpoint.is_empty() {
            return StatusCode::BAD_REQUEST;
        }
        push.store()
            .delete(&owner.0, &subscription_key(&unsub.endpoint))
            .map(|_| ())
    };
    match result {
        Ok(()) => StatusCode::NO_CONTENT,
        Err(_) => StatusCode::INTERNAL_SERVER_ERROR,
    }
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
    // Blobs changed: poke the owner's other devices and any grantee whose scope
    // admits this id, so a connected client pulls promptly instead of waiting
    // for its timer.
    poke_vault_readers(&state, &owner.0, &id);
    Ok(StatusCode::NO_CONTENT)
}

/// Fetch a blob owned by the caller, as opaque octets. A `cur-` id additionally
/// gets a strong `ETag`/`If-None-Match` conditional-GET path (see
/// [`etag_response`]) — the mutable curation namespace is the one a client
/// re-fetches on every pull, so a cheap `304` for an unchanged record is worth
/// the AAD-free hash; every other namespace is content-addressed already (a
/// client never re-fetches an id it has) so an etag there would cost more than
/// it saves.
pub async fn get_blob(
    State(state): State<AppState>,
    Extension(owner): Extension<Owner>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> Response {
    if !valid_id(&id) {
        return StatusCode::BAD_REQUEST.into_response();
    }
    match state.store.get(&owner.0, &id) {
        Ok(Some(blob)) => etag_response(&id, blob, &headers),
        Ok(None) => StatusCode::NOT_FOUND.into_response(),
        Err(_) => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    }
}

#[derive(Serialize)]
pub struct BlobList {
    ids: Vec<String>,
    /// The cursor to resume from, present only when more ids remain past this
    /// page. Absent (not `null`) on an unpaginated listing and on the final
    /// page of a paginated one, so an existing client that never sends `limit`
    /// or `cursor` sees the exact same `{"ids":[...]}` shape as before.
    #[serde(skip_serializing_if = "Option::is_none")]
    next: Option<String>,
}

/// `?limit=`/`?cursor=`/`?include=` on a listing endpoint. All optional and
/// independent of each other; see [`paginate_ids`] for how an absent `limit`
/// alongside a present `cursor` is handled, and [`framed_page`] for `include`.
#[derive(Deserialize)]
pub struct ListQuery {
    limit: Option<usize>,
    cursor: Option<String>,
    include: Option<String>,
}

/// Whether this listing request opted into inline blob bodies. Only `body` is
/// meaningful; anything else reads as absent rather than `400`, the same
/// clamp-don't-reject posture as `limit` — an unrecognized value leaves the
/// caller with the ordinary JSON listing, which is always a usable answer.
fn wants_bodies(query: &ListQuery) -> bool {
    query.include.as_deref() == Some("body")
}

/// Page `ids` per `limit`/`cursor`, or return them untouched when neither is
/// present — the byte-compatible path every pre-existing caller takes.
///
/// **Ordering guarantee.** Paginating sorts `ids` lexicographically and treats
/// `cursor` as the last-seen id: a page holds the smallest `limit` ids strictly
/// greater than `cursor` (or from the start, if absent), and `next` is the
/// page's own last id, so resuming with it as the next `cursor` continues right
/// after. Blob ids are content-addressed (a hash, or a hash-derived `cur-` id),
/// so this ordering is stable under concurrent writes in the sense that matters
/// for a diffing sync client: a page never repeats or skips an id that existed
/// at the moment it was read, and a write landing lexicographically behind an
/// already-consumed cursor is simply picked up by that client's *next* full
/// pull (which starts a fresh walk from the empty cursor) — exactly the same
/// eventual-convergence property an unpaginated `GET` already has against a
/// store with no transactional listing.
///
/// The unpaginated path (`limit` and `cursor` both absent) is deliberately
/// **not** sorted, matching `BlobStore::list`'s own unspecified order, so an
/// existing caller sees byte-identical behavior to before pagination existed.
fn paginate_ids(
    mut ids: Vec<String>,
    limit: Option<usize>,
    cursor: Option<&str>,
) -> Result<(Vec<String>, Option<String>), StatusCode> {
    if limit.is_none() && cursor.is_none() {
        return Ok((ids, None));
    }
    if let Some(cursor) = cursor {
        if cursor.len() > MAX_CURSOR_LEN {
            return Err(StatusCode::BAD_REQUEST);
        }
    }
    let page_size = limit
        .map(|l| l.clamp(1, MAX_PAGE_SIZE))
        .unwrap_or(DEFAULT_PAGE_SIZE);
    ids.sort();
    // First index whose id sorts strictly after the cursor (or 0 when absent):
    // `ids` is sorted, so everything before it is `<= cursor` and already seen.
    let start = match cursor {
        Some(cursor) => ids.partition_point(|id| id.as_str() <= cursor),
        None => 0,
    };
    let remaining = &ids[start..];
    let page: Vec<String> = remaining.iter().take(page_size).cloned().collect();
    let next = (remaining.len() > page.len())
        .then(|| page.last().cloned())
        .flatten();
    Ok((page, next))
}

/// Serve one page of `owner`'s blobs as bodies, not just ids: the frames
/// `id_len u16 BE | id | blob_len u32 BE | blob` concatenated, with the
/// continuation cursor in the [`NEXT_HEADER`] response header. This exists to
/// collapse round trips — a cold device otherwise pays a signed (so
/// preflighted) request per blob to restore a vault — and changes nothing about
/// what the relay can see: it already lists every id and serves every body.
///
/// Two bounds apply at once. The caller's `limit` fixed how many ids `page`
/// holds; [`BATCH_BYTE_BUDGET`] caps how many of those actually ship. Whichever
/// binds first ends the page, so a page can be short of `limit` and a client
/// must walk by the cursor rather than by counting. The first frame is written
/// unconditionally, so a blob larger than the whole budget ships alone instead
/// of stalling the walk on a page that could never fit it.
///
/// The cursor is where the two bounds are reconciled: on an early stop, `next`
/// is the last id this response *accounted for* (`consumed - 1`, the last-seen-id
/// semantics [`paginate_ids`] defines), so the caller resumes at the first id
/// that did not ship. When the whole page ships, `next` is `paginate_ids`' own
/// value and the walk proceeds exactly as the JSON listing's would.
fn framed_page(
    store: &dyn BlobStore,
    owner: &[u8; 32],
    page: &[String],
    page_next: Option<String>,
) -> Result<Response, StatusCode> {
    let mut body: Vec<u8> = Vec::new();
    let mut consumed: usize = 0;
    for id in page {
        let size = store
            .size(owner, id)
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
        // Deleted between the listing and this read: still consumed, so the
        // cursor moves past it, but there is nothing to frame.
        let Some(size) = size else {
            consumed += 1;
            continue;
        };
        let frame_len = 2 + id.len() + 4 + size as usize;
        // Stat, then decide, then read: a blob that would overflow the
        // remaining budget is skipped without ever being buffered, so peak
        // memory for a page is the budget plus at most one oversized blob (the
        // unconditional-first-frame case below), never budget-plus-a-discard.
        if !body.is_empty() && body.len() + frame_len > BATCH_BYTE_BUDGET {
            break;
        }
        let blob = store
            .get(owner, id)
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
        // Deleted between the stat above and this read: same as the listing
        // race above, still consumed but nothing to frame.
        let Some(blob) = blob else {
            consumed += 1;
            continue;
        };
        // `size` and `get` are two separate calls, not a snapshot: a
        // concurrent `put` can replace the blob in between and grow it past
        // what the preflight above allowed. Recheck against the bytes that
        // actually came back before committing them — same rule, same
        // first-frame exemption — so a race can never push a page over
        // budget; the candidate is simply deferred to the next page instead.
        let frame_len = 2 + id.len() + 4 + blob.len();
        if !body.is_empty() && body.len() + frame_len > BATCH_BYTE_BUDGET {
            break;
        }
        body.extend_from_slice(&(id.len() as u16).to_be_bytes());
        body.extend_from_slice(id.as_bytes());
        body.extend_from_slice(&(blob.len() as u32).to_be_bytes());
        body.extend_from_slice(&blob);
        consumed += 1;
    }

    // `consumed >= 1` whenever the loop broke early: breaking requires a
    // non-empty buffer, which requires a frame already written.
    let next = if consumed < page.len() {
        Some(page[consumed - 1].clone())
    } else {
        page_next
    };
    let mut resp = ([(header::CONTENT_TYPE, "application/octet-stream")], body).into_response();
    if let Some(next) = next {
        // Every caller filters ids through `valid_id` (see
        // `drop_unwritable_ids`) before they ever reach here, so `next` is
        // normally header-safe already. This is defense in depth for that
        // invariant, not the primary guard: if it ever fails anyway (a filter
        // call site missed, a future id source), degrade instead of panicking
        // on data the relay does not fully control — drop the cursor and let
        // the walk end here rather than resume with a value that can't be
        // sent.
        if let Ok(value) = HeaderValue::from_str(&next) {
            resp.headers_mut()
                .insert(HeaderName::from_static(NEXT_HEADER), value);
        }
    }
    Ok(resp)
}

/// Drop ids a write could never have produced. `BlobStore::list` (`FsStore`
/// especially — `read_dir` + `to_string_lossy`, see the relay README's
/// "Upgrading past 0.13.0") reflects whatever is on disk, which for a
/// pre-namespacing data directory can include mailbox residue or foreign
/// bytes, not just ids that came through `valid_id`-gated writes. Filtering
/// here, before pagination or a grant's prefix scope ever sees the list,
/// keeps such an entry from occupying a page, becoming a cursor, or stalling
/// the walk at whatever position it sorts to — it simply isn't part of the
/// vault as far as any listing is concerned.
fn drop_unwritable_ids(ids: Vec<String>) -> Vec<String> {
    ids.into_iter().filter(|id| valid_id(id)).collect()
}

/// List the ids the caller has stored. See [`paginate_ids`] for the optional
/// `limit`/`cursor` params' semantics, and [`framed_page`] for the optional
/// `include=body` batched form.
pub async fn list_blobs(
    State(state): State<AppState>,
    Extension(owner): Extension<Owner>,
    Query(query): Query<ListQuery>,
) -> Result<Response, StatusCode> {
    let ids = drop_unwritable_ids(
        state
            .store
            .list(&owner.0)
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?,
    );
    if wants_bodies(&query) {
        // A framed page is always paginated: byte-compatibility only constrains
        // the JSON shape, and an unbounded body page is the very thing the byte
        // budget exists to prevent.
        let limit = Some(query.limit.unwrap_or(DEFAULT_PAGE_SIZE));
        let (page, next) = paginate_ids(ids, limit, query.cursor.as_deref())?;
        return framed_page(&*state.store, &owner.0, &page, next);
    }
    let (ids, next) = paginate_ids(ids, query.limit, query.cursor.as_deref())?;
    Ok(Json(BlobList { ids, next }).into_response())
}

/// A strong validator over a blob's exact bytes: cheap and free of any AAD or
/// key material (the relay never opens the blob), and stable across identical
/// re-writes (rewriting `cur-` with unchanged content, which a client's LWW
/// re-push after losing a merge can do, reproduces the same etag). Formatted as
/// an HTTP quoted entity-tag.
fn strong_etag(bytes: &[u8]) -> String {
    format!("\"{}\"", hex::encode(Sha256::digest(bytes)))
}

/// Whether `headers` carries an `If-None-Match` that matches `etag` — a
/// comma-separated list per RFC 7232, `*` matching unconditionally. Weak
/// validators (`W/"..."`) never match, since every etag this relay issues is
/// strong.
fn if_none_match_hits(headers: &HeaderMap, etag: &str) -> bool {
    let Some(value) = headers
        .get(header::IF_NONE_MATCH)
        .and_then(|v| v.to_str().ok())
    else {
        return false;
    };
    value
        .split(',')
        .map(str::trim)
        .any(|candidate| candidate == etag || candidate == "*")
}

/// Build the response for a fetched blob: a plain octet-stream body for every
/// namespace except the mutable `cur-` one, which additionally carries a
/// strong `ETag` and honors `If-None-Match` with a bodyless `304`. See
/// [`get_blob`] and [`get_shared_blob`] for why the etag path is scoped to
/// `cur-` alone, and `spec/README.md`'s "Curation etags" for why the listing
/// response does not also carry these validators.
fn etag_response(id: &str, blob: Vec<u8>, headers: &HeaderMap) -> Response {
    if !id.starts_with("cur-") {
        return ([(header::CONTENT_TYPE, "application/octet-stream")], blob).into_response();
    }
    let etag = strong_etag(&blob);
    let etag_header = etag.parse().expect("hex + quotes is a valid header value");
    if if_none_match_hits(headers, &etag) {
        let mut resp = StatusCode::NOT_MODIFIED.into_response();
        resp.headers_mut().insert(header::ETAG, etag_header);
        return resp;
    }
    let mut resp = ([(header::CONTENT_TYPE, "application/octet-stream")], blob).into_response();
    resp.headers_mut().insert(header::ETAG, etag_header);
    resp
}

pub async fn delete_blob(
    State(state): State<AppState>,
    Extension(owner): Extension<Owner>,
    Path(id): Path<String>,
) -> StatusCode {
    if !valid_id(&id) {
        return StatusCode::BAD_REQUEST;
    }
    match state.store.delete(&owner.0, &id) {
        Ok(true) => {
            // The blob set changed; poke readers the same as on a write.
            poke_vault_readers(&state, &owner.0, &id);
            StatusCode::NO_CONTENT
        }
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

/// Authorize `grantee` (another keyed identity) to read the caller's shared
/// blobs. Idempotent and an **upsert**: re-granting an existing grantee replaces
/// its scope, so this is also how an owner re-scopes a live grant in place.
///
/// The optional scope rides an optional JSON **body** — `{ "prefixes": [...],
/// "expires_at": <unix-secs> }`, both fields optional. An **empty body** is an
/// unscoped grant (full read, no expiry) — which is exactly what a legacy client
/// that never sends a body produces, so old and new callers coexist. Because the
/// auth preimage binds the body hash, the scope is covered by the caller's
/// signature for free; no separate binding is needed.
pub async fn put_grant(
    State(state): State<AppState>,
    Extension(owner): Extension<Owner>,
    Path(grantee_hex): Path<String>,
    body: Bytes,
) -> Result<StatusCode, StatusCode> {
    let grantee = valid_pubkey_hex(&grantee_hex).ok_or(StatusCode::BAD_REQUEST)?;
    // Empty body = unscoped grant (and the legacy no-body request shape).
    let grant: Grant = if body.is_empty() {
        Grant::default()
    } else {
        serde_json::from_slice(&body).map_err(|_| StatusCode::BAD_REQUEST)?
    };
    if grant.prefixes.len() > MAX_GRANT_PREFIXES
        || grant
            .prefixes
            .iter()
            .any(|p| p.len() > MAX_GRANT_PREFIX_LEN)
    {
        return Err(StatusCode::BAD_REQUEST);
    }
    state
        .grants
        .put(&owner.0, &grantee, &grant)
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
/// `404` for a missing (or expired) grant, exactly as for a missing blob below
/// — a caller probing an ungranted owner cannot distinguish "not shared with
/// you" from "nothing there" (see [`get_shared_blob`]'s doc comment), and this
/// holds regardless of what `limit`/`cursor` the caller sends: the grant check
/// runs *before* pagination, so a bogus cursor on an absent or expired grant
/// answers exactly the same `404` as no cursor at all — it can never leak a
/// distinguishing `400` from cursor validation the caller was never entitled to
/// reach. When the grant carries a prefix allowlist, the listing (and its
/// pagination) is over admitted ids only, so a scoped grantee pages through
/// its own scope and never learns an excluded id exists, let alone its
/// position in the walk. See [`paginate_ids`] for the `limit`/`cursor`
/// semantics themselves, and [`framed_page`] for the optional `include=body`
/// batched form — which composes the same way, since it runs after both the
/// grant check and the scope filter, so it can only ever carry bodies for ids
/// this caller could already have fetched one at a time.
pub async fn list_shared_blobs(
    State(state): State<AppState>,
    Extension(caller): Extension<Owner>,
    Path(owner_hex): Path<String>,
    Query(query): Query<ListQuery>,
) -> Result<Response, StatusCode> {
    let owner = valid_pubkey_hex(&owner_hex).ok_or(StatusCode::BAD_REQUEST)?;
    let grant = live_grant(&state, &owner, &caller.0)?;
    let ids: Vec<String> = drop_unwritable_ids(
        state
            .store
            .list(&owner)
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?,
    )
    .into_iter()
    .filter(|id| grant.admits(id))
    .collect();
    if wants_bodies(&query) {
        let limit = Some(query.limit.unwrap_or(DEFAULT_PAGE_SIZE));
        let (page, next) = paginate_ids(ids, limit, query.cursor.as_deref())?;
        return framed_page(&*state.store, &owner, &page, next);
    }
    let (ids, next) = paginate_ids(ids, query.limit, query.cursor.as_deref())?;
    Ok(Json(BlobList { ids, next }).into_response())
}

/// Fetch the caller's live grant on `owner`, or `Err(404)` when there is no
/// grant *or* it has expired. An expired grant is treated as absent so the
/// two-404 non-leak rule keeps holding: a probing caller cannot tell an expired
/// grant, a revoked one, and one that never existed apart. Returns the grant so
/// callers can apply its prefix allowlist.
fn live_grant(state: &AppState, owner: &[u8; 32], caller: &[u8; 32]) -> Result<Grant, StatusCode> {
    match state.grants.get(owner, caller) {
        Ok(Some(grant)) if !grant.is_expired(now_secs()) => Ok(grant),
        Ok(_) => Err(StatusCode::NOT_FOUND),
        Err(_) => Err(StatusCode::INTERNAL_SERVER_ERROR),
    }
}

/// Fetch a blob from `owner`'s vault, gated on a live grant from `owner` to the
/// caller. A missing grant, an **expired** grant, an id **outside the grant's
/// prefix allowlist**, and a missing blob all answer `404`: if any of them
/// answered differently, a caller could probe and learn something the relay is
/// supposed to keep opaque — whether an arbitrary key grants them access (the
/// sharing graph), or which ids exist outside their scope. One status code for
/// every "you can't have this" case keeps all of that unobservable. A `cur-` id
/// additionally gets the same `ETag`/`If-None-Match` conditional path as the
/// own-vault fetch (see [`etag_response`]) — the node's grant is the case this
/// exists for: it is a continuous grantee of `cur-` and would otherwise re-pull
/// every curation record's full body on every sync.
pub async fn get_shared_blob(
    State(state): State<AppState>,
    Extension(caller): Extension<Owner>,
    Path((owner_hex, id)): Path<(String, String)>,
    headers: HeaderMap,
) -> Response {
    let Some(owner) = valid_pubkey_hex(&owner_hex) else {
        return StatusCode::BAD_REQUEST.into_response();
    };
    if !valid_id(&id) {
        return StatusCode::BAD_REQUEST.into_response();
    }
    let grant = match live_grant(&state, &owner, &caller.0) {
        Ok(grant) => grant,
        Err(status) => return status.into_response(),
    };
    // An id outside the allowlist is invisible: same 404 as a missing blob, so
    // the excluded namespace is indistinguishable from an empty one.
    if !grant.admits(&id) {
        return StatusCode::NOT_FOUND.into_response();
    }
    match state.store.get(&owner, &id) {
        Ok(Some(blob)) => etag_response(&id, blob, &headers),
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
    // A deposit landed: poke the recipient (SSE + Web Push) to pull the mailbox.
    poke_identity(&state, &recipient, Poke::Mailbox);
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

#[derive(Serialize)]
pub struct ShareInfo {
    token: String,
    created_at: u64,
    expires_at: u64,
}

#[derive(Serialize)]
pub struct ShareList {
    shares: Vec<ShareInfo>,
}

/// List the caller's own **live** shares — token, created, and expiry timing,
/// never the sealed bundle bytes or anything content-derived. This is what lets
/// a second device discover and revoke a share it did not create, without
/// syncing share records through the vault: the relay already holds this as
/// routing metadata (the same class as a grant edge), so a device just asks for
/// it. A share whose `expires_at` has passed is filtered out here even if the
/// store hasn't yet lazily tombstoned it on a `GET /v0/share/{token}` — the
/// listing and the read path must agree on what's still live.
pub async fn list_shares(
    State(state): State<AppState>,
    Extension(owner): Extension<Owner>,
) -> Result<Json<ShareList>, StatusCode> {
    let now = now_secs();
    let shares = state
        .shares
        .list_by_owner(owner.0)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
        .into_iter()
        .filter(|(_, _, expires_at)| *expires_at > now)
        .map(|(token, created_at, expires_at)| ShareInfo {
            token,
            created_at,
            expires_at,
        })
        .collect();
    Ok(Json(ShareList { shares }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use std::io;
    use std::sync::Mutex;

    /// A `BlobStore` whose `size` is free but whose `get` is logged — lets a
    /// test assert that a blob rejected by the byte budget is never actually
    /// read, not merely that the final response is correct (the integration
    /// tests in `tests/blobs.rs` already cover that).
    struct CountingStore {
        blobs: HashMap<String, Vec<u8>>,
        get_calls: Mutex<Vec<String>>,
    }

    impl BlobStore for CountingStore {
        fn put(&self, _owner: &[u8; 32], _id: &str, _blob: Vec<u8>) -> io::Result<()> {
            unimplemented!("not exercised by framed_page")
        }

        fn get(&self, _owner: &[u8; 32], id: &str) -> io::Result<Option<Vec<u8>>> {
            self.get_calls.lock().unwrap().push(id.to_string());
            Ok(self.blobs.get(id).cloned())
        }

        fn size(&self, _owner: &[u8; 32], id: &str) -> io::Result<Option<u64>> {
            Ok(self.blobs.get(id).map(|b| b.len() as u64))
        }

        fn list(&self, _owner: &[u8; 32]) -> io::Result<Vec<String>> {
            unimplemented!("not exercised by framed_page")
        }

        fn delete(&self, _owner: &[u8; 32], _id: &str) -> io::Result<bool> {
            unimplemented!("not exercised by framed_page")
        }
    }

    #[test]
    fn framed_page_never_reads_a_blob_the_stat_shows_wont_fit() {
        let owner = [0u8; 32];
        let mut blobs = HashMap::new();
        blobs.insert("a".to_string(), vec![1u8; 1024]);
        // Alone this fits comfortably; after "a" it doesn't, and the budget
        // check must reject it by its stat size alone.
        blobs.insert("b".to_string(), vec![2u8; BATCH_BYTE_BUDGET]);
        let store = CountingStore {
            blobs,
            get_calls: Mutex::new(Vec::new()),
        };
        let page = vec!["a".to_string(), "b".to_string()];

        let resp = framed_page(&store, &owner, &page, None).unwrap();
        assert_eq!(resp.status(), StatusCode::OK);

        assert_eq!(
            store.get_calls.into_inner().unwrap(),
            vec!["a".to_string()],
            "the oversized second blob is rejected by its stat size and never buffered"
        );
    }

    #[test]
    fn framed_page_omits_the_cursor_header_instead_of_panicking_on_an_unencodable_id() {
        // Defense in depth: every caller filters ids through `valid_id` (see
        // `drop_unwritable_ids`) before a listing ever reaches `framed_page`,
        // so this should never fire in practice. Exercised directly here,
        // bypassing that filter, to prove the fallback itself degrades rather
        // than panics if it ever does.
        let owner = [0u8; 32];
        let bad_id = "\u{1}bad".to_string();
        let mut blobs = HashMap::new();
        blobs.insert(bad_id.clone(), b"junk".to_vec());
        let store = CountingStore {
            blobs,
            get_calls: Mutex::new(Vec::new()),
        };
        let page = vec![bad_id.clone()];

        // `page_next` mimics `paginate_ids` reporting more ids remain past
        // this page, with the bad id as the last one seen — the case that
        // used to reach the removed `.expect()`.
        let resp = framed_page(&store, &owner, &page, Some(bad_id)).unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        assert!(
            resp.headers().get(NEXT_HEADER).is_none(),
            "an unencodable cursor is omitted rather than panicking"
        );
    }

    /// A `BlobStore` whose `size` can disagree with what `get` actually
    /// returns — standing in for a concurrent `put` landing between the two
    /// calls, which `size`'s own contract says can happen (see
    /// `BlobStore::size`'s doc comment).
    struct RacyStore {
        reported_sizes: HashMap<String, u64>,
        blobs: HashMap<String, Vec<u8>>,
    }

    impl BlobStore for RacyStore {
        fn put(&self, _owner: &[u8; 32], _id: &str, _blob: Vec<u8>) -> io::Result<()> {
            unimplemented!("not exercised by framed_page")
        }

        fn get(&self, _owner: &[u8; 32], id: &str) -> io::Result<Option<Vec<u8>>> {
            Ok(self.blobs.get(id).cloned())
        }

        fn size(&self, _owner: &[u8; 32], id: &str) -> io::Result<Option<u64>> {
            Ok(self.reported_sizes.get(id).copied())
        }

        fn list(&self, _owner: &[u8; 32]) -> io::Result<Vec<String>> {
            unimplemented!("not exercised by framed_page")
        }

        fn delete(&self, _owner: &[u8; 32], _id: &str) -> io::Result<bool> {
            unimplemented!("not exercised by framed_page")
        }
    }

    #[test]
    fn framed_page_rechecks_the_real_size_after_a_racy_stat() {
        let owner = [0u8; 32];
        let a = vec![1u8; 1024];
        // "b"'s stat lies: it reports small enough to fit right after "a",
        // but the bytes `get` actually returns (as if a concurrent `put`
        // replaced it after the stat ran) would blow the remaining budget.
        let mut reported_sizes = HashMap::new();
        reported_sizes.insert("a".to_string(), a.len() as u64);
        reported_sizes.insert("b".to_string(), 1024);
        let mut blobs = HashMap::new();
        blobs.insert("a".to_string(), a.clone());
        blobs.insert("b".to_string(), vec![2u8; BATCH_BYTE_BUDGET]);
        let store = RacyStore {
            reported_sizes,
            blobs,
        };
        let page = vec!["a".to_string(), "b".to_string()];

        let resp = framed_page(&store, &owner, &page, None).unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        assert_eq!(
            resp.headers()
                .get(NEXT_HEADER)
                .map(|v| v.to_str().unwrap().to_string()),
            Some("a".to_string()),
            "the racy oversized blob is deferred to the next page rather \
             than appended past the budget its own stat promised"
        );
    }
}
