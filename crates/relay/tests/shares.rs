//! Integration tests for shares: sealed bundles fetched by an unguessable
//! bearer token, with a relay-clamped expiry and revocation. Same in-process
//! harness as `blobs.rs`. The read (`GET /v0/share/{token}`) is the one
//! unauthenticated endpoint; PUT and DELETE are owner-authenticated.

use std::sync::Arc;

use axum::body::Body;
use axum::http::{HeaderValue, Request, StatusCode};
use svastha_core::keys::Identity;
use svastha_relay::app;
use svastha_relay::grants::MemoryGrantStore;
use svastha_relay::mailbox::MemoryMailboxStore;
use svastha_relay::routes::{SHARE_EXPIRES_HEADER, SHARE_MAX_BODY, SHARE_MAX_TTL_SECS};
use svastha_relay::share::{FsShareStore, MemoryShareStore, ShareState, ShareStore};
use svastha_relay::store::MemoryStore;
use tower::ServiceExt;

mod common;
use common::{body_bytes, now, signed, SKEW};

/// A valid share token: blob-id charset, comfortably past the 22-char floor.
const TOKEN: &str = "share-abcdefghijklmnopqrstuvwxyz012345";

fn router_with_shares(shares: Arc<dyn ShareStore>) -> axum::Router {
    app(
        Arc::new(MemoryStore::new()),
        Arc::new(MemoryGrantStore::new()),
        Arc::new(MemoryMailboxStore::new()),
        shares,
        SKEW,
        None,
        None,
    )
}

fn router() -> axum::Router {
    router_with_shares(Arc::new(MemoryShareStore::new()))
}

fn share_path(token: &str) -> String {
    format!("/v0/share/{token}")
}

/// A `GET` needs no auth, so it is a plain request.
fn unauth_get(token: &str) -> Request<Body> {
    Request::builder()
        .method("GET")
        .uri(share_path(token))
        .body(Body::empty())
        .unwrap()
}

#[tokio::test]
async fn create_and_fetch_round_trip() {
    let app = router();
    let alice = Identity::from_seed(b"alice");
    let bundle = b"sealed share bundle";

    let put = app
        .clone()
        .oneshot(signed(&alice, "PUT", &share_path(TOKEN), bundle, now()))
        .await
        .unwrap();
    assert_eq!(put.status(), StatusCode::NO_CONTENT);

    // The recipient fetches by token alone — no identity, no auth headers.
    let get = app.oneshot(unauth_get(TOKEN)).await.unwrap();
    assert_eq!(get.status(), StatusCode::OK);
    assert_eq!(body_bytes(get).await, bundle);
}

#[tokio::test]
async fn fetch_after_expiry_is_gone_and_bytes_dropped() {
    let shares = Arc::new(MemoryShareStore::new());
    let app = router_with_shares(shares.clone());
    let alice = Identity::from_seed(b"alice");

    // A past expiry passes the clamp unchanged (it only caps the upper bound),
    // so this share is already expired the moment it lands.
    let mut put = signed(&alice, "PUT", &share_path(TOKEN), b"secret", now());
    put.headers_mut().insert(
        SHARE_EXPIRES_HEADER,
        HeaderValue::from_str(&(now() - 10).to_string()).unwrap(),
    );
    assert_eq!(
        app.clone().oneshot(put).await.unwrap().status(),
        StatusCode::NO_CONTENT
    );

    // First fetch detects the lapse: 410, and the bundle bytes are dropped.
    let first = app.clone().oneshot(unauth_get(TOKEN)).await.unwrap();
    assert_eq!(first.status(), StatusCode::GONE);
    assert!(body_bytes(first).await.is_empty());

    match shares.get(TOKEN).unwrap() {
        ShareState::Tombstone { .. } => {}
        _ => panic!("expired share should be tombstoned, bundle gone"),
    }

    // A later fetch still says 410, not 404 — the recipient learns it ended.
    let again = app.oneshot(unauth_get(TOKEN)).await.unwrap();
    assert_eq!(again.status(), StatusCode::GONE);
}

#[tokio::test]
async fn revoke_makes_fetch_gone() {
    let app = router();
    let alice = Identity::from_seed(b"alice");

    let put = app
        .clone()
        .oneshot(signed(&alice, "PUT", &share_path(TOKEN), b"secret", now()))
        .await
        .unwrap();
    assert_eq!(put.status(), StatusCode::NO_CONTENT);

    let del = app
        .clone()
        .oneshot(signed(&alice, "DELETE", &share_path(TOKEN), b"", now()))
        .await
        .unwrap();
    assert_eq!(del.status(), StatusCode::NO_CONTENT);

    let get = app.clone().oneshot(unauth_get(TOKEN)).await.unwrap();
    assert_eq!(get.status(), StatusCode::GONE);

    // Revoking again is idempotent for the owner. Fresh timestamp so it is a
    // distinct request, not a replay of `del` above (rejected by the nonce guard).
    let del_again = app
        .oneshot(signed(&alice, "DELETE", &share_path(TOKEN), b"", now() + 1))
        .await
        .unwrap();
    assert_eq!(del_again.status(), StatusCode::NO_CONTENT);
}

#[tokio::test]
async fn never_existed_is_not_found() {
    let app = router();
    let get = app
        .oneshot(unauth_get("share-never-existed-000000000000"))
        .await
        .unwrap();
    assert_eq!(get.status(), StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn wrong_owner_delete_is_not_found() {
    let app = router();
    let alice = Identity::from_seed(b"alice");
    let mallory = Identity::from_seed(b"mallory");

    let put = app
        .clone()
        .oneshot(signed(&alice, "PUT", &share_path(TOKEN), b"secret", now()))
        .await
        .unwrap();
    assert_eq!(put.status(), StatusCode::NO_CONTENT);

    // Not Mallory's share → 404, indistinguishable from "never existed".
    let del = app
        .clone()
        .oneshot(signed(&mallory, "DELETE", &share_path(TOKEN), b"", now()))
        .await
        .unwrap();
    assert_eq!(del.status(), StatusCode::NOT_FOUND);

    // The share is untouched: Alice's recipient can still fetch it.
    let get = app.oneshot(unauth_get(TOKEN)).await.unwrap();
    assert_eq!(get.status(), StatusCode::OK);
    assert_eq!(body_bytes(get).await, b"secret");
}

#[tokio::test]
async fn wrong_owner_put_over_live_share_is_not_found() {
    let app = router();
    let alice = Identity::from_seed(b"alice");
    let mallory = Identity::from_seed(b"mallory");

    let put = app
        .clone()
        .oneshot(signed(&alice, "PUT", &share_path(TOKEN), b"secret", now()))
        .await
        .unwrap();
    assert_eq!(put.status(), StatusCode::NO_CONTENT);

    // Mallory is authenticated but the token is bound to Alice: 404, same
    // non-leak posture as the wrong-owner DELETE.
    let hijack = app
        .clone()
        .oneshot(signed(
            &mallory,
            "PUT",
            &share_path(TOKEN),
            b"mallory bundle",
            now(),
        ))
        .await
        .unwrap();
    assert_eq!(hijack.status(), StatusCode::NOT_FOUND);

    // Alice's original bundle is untouched and still served.
    let get = app.oneshot(unauth_get(TOKEN)).await.unwrap();
    assert_eq!(get.status(), StatusCode::OK);
    assert_eq!(body_bytes(get).await, b"secret");
}

#[tokio::test]
async fn wrong_owner_put_over_tombstoned_share_is_not_found() {
    let app = router();
    let alice = Identity::from_seed(b"alice");
    let mallory = Identity::from_seed(b"mallory");

    let put = app
        .clone()
        .oneshot(signed(&alice, "PUT", &share_path(TOKEN), b"secret", now()))
        .await
        .unwrap();
    assert_eq!(put.status(), StatusCode::NO_CONTENT);
    let revoke = app
        .clone()
        .oneshot(signed(&alice, "DELETE", &share_path(TOKEN), b"", now()))
        .await
        .unwrap();
    assert_eq!(revoke.status(), StatusCode::NO_CONTENT);

    // The tombstone still binds the token to Alice — Mallory cannot squat on it.
    let squat = app
        .clone()
        .oneshot(signed(
            &mallory,
            "PUT",
            &share_path(TOKEN),
            b"mallory bundle",
            now(),
        ))
        .await
        .unwrap();
    assert_eq!(squat.status(), StatusCode::NOT_FOUND);

    // The token still answers 410 (revoked), not Mallory's content.
    let get = app.oneshot(unauth_get(TOKEN)).await.unwrap();
    assert_eq!(get.status(), StatusCode::GONE);
}

#[tokio::test]
async fn over_cap_put_is_rejected() {
    let app = router();
    let alice = Identity::from_seed(b"alice");

    let at_cap = vec![0u8; SHARE_MAX_BODY];
    let ok = app
        .clone()
        .oneshot(signed(&alice, "PUT", &share_path(TOKEN), &at_cap, now()))
        .await
        .unwrap();
    assert_eq!(ok.status(), StatusCode::NO_CONTENT);

    let over_cap = vec![0u8; SHARE_MAX_BODY + 1];
    let rejected = app
        .oneshot(signed(&alice, "PUT", &share_path(TOKEN), &over_cap, now()))
        .await
        .unwrap();
    assert_eq!(rejected.status(), StatusCode::PAYLOAD_TOO_LARGE);
}

#[tokio::test]
async fn expiry_is_clamped_to_thirty_days() {
    let shares = Arc::new(MemoryShareStore::new());
    let app = router_with_shares(shares.clone());
    let alice = Identity::from_seed(b"alice");

    // Ask for 60 days; the relay must clamp to the 30-day ceiling.
    let requested = now() + 60 * 24 * 60 * 60;
    let mut put = signed(&alice, "PUT", &share_path(TOKEN), b"secret", now());
    put.headers_mut().insert(
        SHARE_EXPIRES_HEADER,
        HeaderValue::from_str(&requested.to_string()).unwrap(),
    );
    assert_eq!(
        app.oneshot(put).await.unwrap().status(),
        StatusCode::NO_CONTENT
    );

    match shares.get(TOKEN).unwrap() {
        ShareState::Live { expires_at, .. } => {
            let ceiling = now() + SHARE_MAX_TTL_SECS;
            // Within a few seconds of the ceiling (test/handler clocks differ),
            // and well below the 60-day request.
            assert!(
                expires_at.abs_diff(ceiling) <= 5,
                "expires_at {expires_at} not clamped near ceiling {ceiling}"
            );
            assert!(expires_at < requested);
        }
        _ => panic!("expected a live share"),
    }
}

#[tokio::test]
async fn short_token_is_rejected() {
    let app = router();
    let alice = Identity::from_seed(b"alice");
    let short = "share-tooshort"; // 14 chars, below the 22-char floor

    let put = app
        .clone()
        .oneshot(signed(&alice, "PUT", &share_path(short), b"x", now()))
        .await
        .unwrap();
    assert_eq!(put.status(), StatusCode::BAD_REQUEST);

    let get = app.oneshot(unauth_get(short)).await.unwrap();
    assert_eq!(get.status(), StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn unauthenticated_put_and_delete_are_rejected() {
    let app = router();

    let put = app
        .clone()
        .oneshot(
            Request::builder()
                .method("PUT")
                .uri(share_path(TOKEN))
                .body(Body::from("secret"))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(put.status(), StatusCode::UNAUTHORIZED);

    let del = app
        .oneshot(
            Request::builder()
                .method("DELETE")
                .uri(share_path(TOKEN))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(del.status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn fs_share_store_persists_across_router_rebuild() {
    let dir = tempfile::tempdir().unwrap();
    let alice = Identity::from_seed(b"alice");

    let first = router_with_shares(Arc::new(FsShareStore::new(dir.path()).unwrap()));
    let put = first
        .oneshot(signed(
            &alice,
            "PUT",
            &share_path(TOKEN),
            b"durable bundle",
            now(),
        ))
        .await
        .unwrap();
    assert_eq!(put.status(), StatusCode::NO_CONTENT);

    // A fresh router over the same directory still serves the bundle.
    let second = router_with_shares(Arc::new(FsShareStore::new(dir.path()).unwrap()));
    let get = second.oneshot(unauth_get(TOKEN)).await.unwrap();
    assert_eq!(get.status(), StatusCode::OK);
    assert_eq!(body_bytes(get).await, b"durable bundle");
}

// --- GET /v0/shares: the caller's own live shares, cross-device listing ---

const TOKEN_A: &str = "share-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const TOKEN_B: &str = "share-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const TOKEN_MALLORY: &str = "share-mmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmm";

fn list_shares_tokens(body: &[u8]) -> Vec<String> {
    let parsed: serde_json::Value = serde_json::from_slice(body).unwrap();
    parsed["shares"]
        .as_array()
        .unwrap()
        .iter()
        .map(|s| s["token"].as_str().unwrap().to_string())
        .collect()
}

#[tokio::test]
async fn list_shares_shows_only_own_live_shares() {
    let app = router();
    let alice = Identity::from_seed(b"alice");
    let mallory = Identity::from_seed(b"mallory");

    for token in [TOKEN_A, TOKEN_B] {
        let put = app
            .clone()
            .oneshot(signed(&alice, "PUT", &share_path(token), b"bundle", now()))
            .await
            .unwrap();
        assert_eq!(put.status(), StatusCode::NO_CONTENT);
    }
    let put_mallory = app
        .clone()
        .oneshot(signed(
            &mallory,
            "PUT",
            &share_path(TOKEN_MALLORY),
            b"mallory bundle",
            now(),
        ))
        .await
        .unwrap();
    assert_eq!(put_mallory.status(), StatusCode::NO_CONTENT);

    let list = app
        .clone()
        .oneshot(signed(&alice, "GET", "/v0/shares", b"", now()))
        .await
        .unwrap();
    assert_eq!(list.status(), StatusCode::OK);
    let mut tokens = list_shares_tokens(&body_bytes(list).await);
    tokens.sort();
    assert_eq!(tokens, vec![TOKEN_A.to_string(), TOKEN_B.to_string()]);

    // Mallory's own listing shows only her share, never Alice's.
    let mallory_list = app
        .oneshot(signed(&mallory, "GET", "/v0/shares", b"", now()))
        .await
        .unwrap();
    assert_eq!(
        list_shares_tokens(&body_bytes(mallory_list).await),
        vec![TOKEN_MALLORY.to_string()]
    );
}

#[tokio::test]
async fn list_shares_excludes_expired() {
    let app = router();
    let alice = Identity::from_seed(b"alice");

    // Already past its expiry the moment it lands (the clamp only caps the
    // upper bound), and nobody has fetched it yet to trigger lazy tombstoning —
    // the listing must still treat it as gone.
    let mut put = signed(&alice, "PUT", &share_path(TOKEN_A), b"bundle", now());
    put.headers_mut().insert(
        SHARE_EXPIRES_HEADER,
        HeaderValue::from_str(&(now() - 10).to_string()).unwrap(),
    );
    assert_eq!(
        app.clone().oneshot(put).await.unwrap().status(),
        StatusCode::NO_CONTENT
    );

    let list = app
        .oneshot(signed(&alice, "GET", "/v0/shares", b"", now()))
        .await
        .unwrap();
    assert!(list_shares_tokens(&body_bytes(list).await).is_empty());
}

#[tokio::test]
async fn list_shares_excludes_revoked() {
    let app = router();
    let alice = Identity::from_seed(b"alice");

    let put = app
        .clone()
        .oneshot(signed(
            &alice,
            "PUT",
            &share_path(TOKEN_A),
            b"bundle",
            now(),
        ))
        .await
        .unwrap();
    assert_eq!(put.status(), StatusCode::NO_CONTENT);

    let del = app
        .clone()
        .oneshot(signed(&alice, "DELETE", &share_path(TOKEN_A), b"", now()))
        .await
        .unwrap();
    assert_eq!(del.status(), StatusCode::NO_CONTENT);

    let list = app
        .oneshot(signed(&alice, "GET", "/v0/shares", b"", now()))
        .await
        .unwrap();
    assert!(list_shares_tokens(&body_bytes(list).await).is_empty());
}

#[tokio::test]
async fn list_shares_requires_auth() {
    let app = router();
    let unauthed = app
        .oneshot(
            Request::builder()
                .method("GET")
                .uri("/v0/shares")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(unauthed.status(), StatusCode::UNAUTHORIZED);
}
