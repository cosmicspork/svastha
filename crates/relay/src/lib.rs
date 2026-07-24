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
//! It also holds [`share::ShareStore`]: sealed bundles an owner uploads for a
//! doctor (or anyone) to fetch by an unguessable bearer token, with a
//! relay-clamped expiry and revocation. The bundle is opaque ciphertext like
//! everything else — the per-share key rides the link's URL fragment and never
//! reaches the relay. `GET /v0/share/{token}` is the one unauthenticated read.
//! `GET /v0/shares` (owner-authed) lists the caller's own live tokens with
//! timing only, so a share made on one device can be managed from another
//! without ever syncing share records through the vault.
//!
//! Two more pieces are runtime-only (no stored state): [`pokes::PokeHub`], the
//! payload-free SSE push channel that tells a connected client when to pull
//! (`GET /v0/events`), and [`nonce::NonceStore`], the auth replay guard. Both
//! are constructed inside [`app`] rather than passed in, because neither has a
//! durable backend — a poke is meaningless to a closed connection, and the
//! nonce window is deliberately cleared by a restart (see [`nonce`]).
//!
//! When the operator supplies a VAPID keypair, the poke bus gains a second
//! transport: [`push::PushService`] fans the same payload-free poke out via Web
//! Push (`PUT`/`DELETE /v0/push`) so it reaches a locked phone whose PWA is
//! closed. Its subscription store *is* durable routing metadata (the same class
//! as a grant edge), but the transport is optional — with no key it is `None`
//! and the feature is simply off. See [`push`].
//!
//! [`app`] builds the router for a given set of stores; the binary
//! ([`main`](../main.rs)) wires it to in-memory (or filesystem) stores and
//! `axum::serve`.

pub mod auth;
pub mod grants;
pub mod mailbox;
pub mod nonce;
pub mod pokes;
pub mod push;
pub mod routes;
pub mod share;
pub mod store;

use std::sync::Arc;

use axum::{
    extract::DefaultBodyLimit,
    middleware,
    routing::{get, put},
    Router,
};
use tower_http::cors::CorsLayer;

use grants::GrantStore;
use mailbox::MailboxStore;
use nonce::NonceStore;
use pokes::PokeHub;
use push::PushService;
use share::ShareStore;
use store::BlobStore;

/// Shared handler state: the stores, the auth freshness window, the replay
/// guard, and the push-channel hub.
#[derive(Clone)]
pub struct AppState {
    pub store: Arc<dyn BlobStore>,
    pub grants: Arc<dyn GrantStore>,
    pub mailbox: Arc<dyn MailboxStore>,
    pub shares: Arc<dyn ShareStore>,
    pub max_skew_secs: u64,
    /// Auth replay guard: remembers recently-seen request signatures within the
    /// freshness window and rejects a repeat. In-memory only (see [`nonce`]).
    pub nonces: Arc<NonceStore>,
    /// Push-channel fan-out: payload-free pokes to an identity's open SSE
    /// streams (`GET /v0/events`). Lossy by design (see [`pokes`]).
    pub pokes: Arc<PokeHub>,
    /// Web Push transport: the *second* leg of the poke bus, delivering the same
    /// payload-free poke to a locked phone via VAPID-signed Web Push. `None` when
    /// the operator supplied no VAPID key — push is optional, and its absence
    /// leaves every other endpoint untouched (the `/v0/push*` routes answer
    /// `503`). See [`push`].
    pub push: Option<Arc<PushService>>,
    /// The web app's own origin (e.g. `https://app.example.com`), if this
    /// relay is paired with a known app deployment. When set, the landing
    /// page's QR (`routes::landing`) encodes a device-link onboarding URL
    /// instead of just the relay's own address — see
    /// `web/src/routes/Onboard.svelte`. Trimmed of any trailing `/` once at
    /// startup (`SVASTHA_APP_URL` in `main.rs`) so handlers never re-trim it.
    pub app_url: Option<String>,
}

/// Build the relay router. `max_skew_secs` is how far a request's signed
/// timestamp may differ from the relay's clock (replay window). `app_url` is
/// the optional paired web app origin described on [`AppState::app_url`].
pub fn app(
    store: Arc<dyn BlobStore>,
    grants: Arc<dyn GrantStore>,
    mailbox: Arc<dyn MailboxStore>,
    shares: Arc<dyn ShareStore>,
    max_skew_secs: u64,
    app_url: Option<String>,
    push: Option<Arc<PushService>>,
) -> Router {
    let state = AppState {
        store,
        grants,
        mailbox,
        shares,
        max_skew_secs,
        // Runtime-only state: no backend to pass in, constructed fresh here
        // (see the module docs on why neither is persisted).
        nonces: Arc::new(NonceStore::new()),
        pokes: Arc::new(PokeHub::new()),
        app_url,
        push,
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
        // Long-lived authenticated SSE stream of payload-free pokes. Uses the
        // same per-request Ed25519 auth as every other row — clients open it
        // with fetch-streaming (not native EventSource, which cannot set the
        // auth headers), so nothing special is needed here.
        .route("/v0/events", get(routes::events))
        // Web Push subscription registration (the second poke transport) and the
        // VAPID public key clients subscribe with. Authenticated like every other
        // row; each answers `503` when the relay was started without a VAPID key.
        .route(
            "/v0/push",
            put(routes::put_push).delete(routes::delete_push),
        )
        .route("/v0/push/key", get(routes::get_vapid_key))
        // Uploading and revoking a share are owner-authenticated; the read
        // (`GET`, below) is not, so it lives on the public router instead.
        .route(
            "/v0/share/{token}",
            put(routes::put_share).delete(routes::delete_share),
        )
        // The caller's own live shares (token + timing only) — cross-device share
        // management asks the relay for what it already knows.
        .route("/v0/shares", get(routes::list_shares))
        .route_layer(middleware::from_fn_with_state(
            state.clone(),
            auth::require_auth,
        ));

    Router::new()
        .route("/", get(routes::landing))
        .route("/health", get(routes::health))
        .route("/v0/info", get(routes::info))
        // The one unauthenticated read: a doctor with the link fetches the
        // sealed bundle by its bearer token. Merged with the authed PUT/DELETE
        // on the same path (disjoint methods), so only the read skips auth.
        .route("/v0/share/{token}", get(routes::get_share))
        .merge(authed)
        .with_state(state)
        // Without this, axum's implicit 2 MB default caps request bodies before
        // `auth::require_auth` ever reads them, and blobs between 2 MB and
        // `MAX_BODY` are rejected 413 despite the 16 MiB contract.
        .layer(DefaultBodyLimit::max(auth::MAX_BODY))
        // Outermost, so even rejections (401) carry CORS headers and the browser
        // can read them. Any origin is safe: auth is a per-request signature with
        // no cookies, so a hostile origin gains nothing.
        .layer(CorsLayer::permissive())
}
