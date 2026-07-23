//! Integration tests for the relay, driven in-process via `tower::oneshot` (no
//! port binding, CI-safe). Requests are signed with the real client-side path
//! from `svastha_core::relay`, so these exercise the whole auth contract.

use std::sync::Arc;

use axum::body::Body;
use axum::http::{Request, StatusCode};
use svastha_core::keys::Identity;
use svastha_core::relay::{sign_request, AuthRequest};
use svastha_relay::app;
use svastha_relay::grants::MemoryGrantStore;
use svastha_relay::mailbox::MemoryMailboxStore;
use svastha_relay::share::MemoryShareStore;
use svastha_relay::store::FsStore;
use tower::ServiceExt;

mod common;
use common::{body_bytes, now, router, signed, SKEW};

#[tokio::test]
async fn health_and_info_need_no_auth() {
    let health = router()
        .oneshot(
            Request::builder()
                .uri("/health")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(health.status(), StatusCode::OK);
    assert_eq!(body_bytes(health).await, b"ok");

    let info = router()
        .oneshot(
            Request::builder()
                .uri("/v0/info")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(info.status(), StatusCode::OK);
    let json: serde_json::Value = serde_json::from_slice(&body_bytes(info).await).unwrap();
    assert_eq!(json["contract_version"], 1);
}

#[tokio::test]
async fn put_then_get_round_trip() {
    let app = router();
    let alice = Identity::from_seed(b"alice");
    let blob = b"sealed ciphertext";

    let put = app
        .clone()
        .oneshot(signed(&alice, "PUT", "/v0/blobs/rec1", blob, now()))
        .await
        .unwrap();
    assert_eq!(put.status(), StatusCode::NO_CONTENT);

    let get = app
        .oneshot(signed(&alice, "GET", "/v0/blobs/rec1", b"", now()))
        .await
        .unwrap();
    assert_eq!(get.status(), StatusCode::OK);
    assert_eq!(body_bytes(get).await, blob);
}

#[tokio::test]
async fn list_and_delete() {
    let app = router();
    let alice = Identity::from_seed(b"alice");

    for id in ["a", "b"] {
        let put = app
            .clone()
            .oneshot(signed(
                &alice,
                "PUT",
                &format!("/v0/blobs/{id}"),
                b"x",
                now(),
            ))
            .await
            .unwrap();
        assert_eq!(put.status(), StatusCode::NO_CONTENT);
    }

    let list = app
        .clone()
        .oneshot(signed(&alice, "GET", "/v0/blobs", b"", now()))
        .await
        .unwrap();
    let json: serde_json::Value = serde_json::from_slice(&body_bytes(list).await).unwrap();
    let mut ids: Vec<String> = json["ids"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_str().unwrap().to_string())
        .collect();
    ids.sort();
    assert_eq!(ids, vec!["a", "b"]);

    let del = app
        .clone()
        .oneshot(signed(&alice, "DELETE", "/v0/blobs/a", b"", now()))
        .await
        .unwrap();
    assert_eq!(del.status(), StatusCode::NO_CONTENT);

    let gone = app
        .oneshot(signed(&alice, "GET", "/v0/blobs/a", b"", now()))
        .await
        .unwrap();
    assert_eq!(gone.status(), StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn missing_auth_is_unauthorized() {
    let resp = router()
        .oneshot(
            Request::builder()
                .uri("/v0/blobs/rec1")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn tampered_request_is_unauthorized() {
    // Sign for one path, send to another: the rebuilt descriptor won't match.
    let alice = Identity::from_seed(b"alice");
    let auth = AuthRequest::new("GET", "/v0/blobs/rec1", b"", now());
    let signature = sign_request(&alice, &auth);
    let req = Request::builder()
        .method("GET")
        .uri("/v0/blobs/rec2") // different path than was signed
        .header(
            "svastha-public-key",
            hex::encode(alice.verifying_key().to_bytes()),
        )
        .header("svastha-timestamp", now().to_string())
        .header("svastha-signature", hex::encode(signature))
        .body(Body::empty())
        .unwrap();
    let resp = router().oneshot(req).await.unwrap();
    assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn stale_timestamp_is_unauthorized() {
    let alice = Identity::from_seed(b"alice");
    let stale = now() - SKEW - 60;
    let resp = router()
        .oneshot(signed(&alice, "GET", "/v0/blobs/rec1", b"", stale))
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn owners_are_isolated() {
    let app = router();
    let alice = Identity::from_seed(b"alice");
    let bob = Identity::from_seed(b"bob");

    let put = app
        .clone()
        .oneshot(signed(
            &alice,
            "PUT",
            "/v0/blobs/secret",
            b"alice data",
            now(),
        ))
        .await
        .unwrap();
    assert_eq!(put.status(), StatusCode::NO_CONTENT);

    // Bob authenticates fine but has no blob under that id.
    let get = app
        .oneshot(signed(&bob, "GET", "/v0/blobs/secret", b"", now()))
        .await
        .unwrap();
    assert_eq!(get.status(), StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn invalid_id_is_bad_request() {
    let alice = Identity::from_seed(b"alice");
    // '%2e%2e' decodes to '..', which the handler rejects.
    let resp = router()
        .oneshot(signed(&alice, "PUT", "/v0/blobs/%2e%2e", b"x", now()))
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn blob_above_axum_default_limit_round_trips() {
    // Sealed medical documents routinely exceed axum's implicit 2 MB default
    // body limit; the contract is MAX_BODY (16 MiB).
    let app = router();
    let alice = Identity::from_seed(b"alice");
    let blob = vec![0x5a; 3 * 1024 * 1024];

    let put = app
        .clone()
        .oneshot(signed(&alice, "PUT", "/v0/blobs/big", &blob, now()))
        .await
        .unwrap();
    assert_eq!(put.status(), StatusCode::NO_CONTENT);

    let get = app
        .oneshot(signed(&alice, "GET", "/v0/blobs/big", b"", now()))
        .await
        .unwrap();
    assert_eq!(get.status(), StatusCode::OK);
    assert_eq!(body_bytes(get).await, blob);
}

#[tokio::test]
async fn blob_above_max_body_is_rejected() {
    let alice = Identity::from_seed(b"alice");
    let blob = vec![0x5a; svastha_relay::auth::MAX_BODY + 1];

    let put = router()
        .oneshot(signed(&alice, "PUT", "/v0/blobs/huge", &blob, now()))
        .await
        .unwrap();
    assert_eq!(put.status(), StatusCode::PAYLOAD_TOO_LARGE);
}

#[tokio::test]
async fn filesystem_store_persists_across_restart() {
    let dir = tempfile::tempdir().unwrap();
    let alice = Identity::from_seed(b"alice");
    let blob = b"durable ciphertext";

    // First "process": store a blob through the HTTP layer. Grants and mailbox
    // are fresh in-memory stores each time — this test only cares about blob
    // durability.
    let first = app(
        Arc::new(FsStore::new(dir.path()).unwrap()),
        Arc::new(MemoryGrantStore::new()),
        Arc::new(MemoryMailboxStore::new()),
        Arc::new(MemoryShareStore::new()),
        SKEW,
        None,
    );
    let put = first
        .oneshot(signed(&alice, "PUT", "/v0/blobs/rec1", blob, now()))
        .await
        .unwrap();
    assert_eq!(put.status(), StatusCode::NO_CONTENT);

    // A fresh app over the same directory (a "restart") still serves it.
    let second = app(
        Arc::new(FsStore::new(dir.path()).unwrap()),
        Arc::new(MemoryGrantStore::new()),
        Arc::new(MemoryMailboxStore::new()),
        Arc::new(MemoryShareStore::new()),
        SKEW,
        None,
    );
    let get = second
        .oneshot(signed(&alice, "GET", "/v0/blobs/rec1", b"", now()))
        .await
        .unwrap();
    assert_eq!(get.status(), StatusCode::OK);
    assert_eq!(body_bytes(get).await, blob);
}

#[tokio::test]
async fn cors_preflight_is_allowed() {
    // A browser PUT with the custom Svastha-* headers triggers this preflight.
    let resp = router()
        .oneshot(
            Request::builder()
                .method("OPTIONS")
                .uri("/v0/blobs/rec1")
                .header("origin", "http://localhost:5173")
                .header("access-control-request-method", "PUT")
                .header("access-control-request-headers", "svastha-signature")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert!(resp.status().is_success());
    assert!(resp.headers().contains_key("access-control-allow-origin"));
}
