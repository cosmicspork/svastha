//! Integration tests for the relay, driven in-process via `tower::oneshot` (no
//! port binding, CI-safe). Requests are signed with the real client-side path
//! from `svastha_core::relay`, so these exercise the whole auth contract.

use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use axum::body::{to_bytes, Body};
use axum::http::{Request, StatusCode};
use svastha_core::keys::Identity;
use svastha_core::relay::{sign_request, AuthRequest};
use svastha_relay::{app, store::MemoryStore};
use tower::ServiceExt;

const SKEW: u64 = 300;

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs()
}

fn router() -> axum::Router {
    app(Arc::new(MemoryStore::new()), SKEW)
}

/// Build a request and attach the three signed-auth headers for `signer`.
fn signed(
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

async fn body_bytes(response: axum::response::Response) -> Vec<u8> {
    to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap()
        .to_vec()
}

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
    assert_eq!(json["contract_version"], 0);
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
