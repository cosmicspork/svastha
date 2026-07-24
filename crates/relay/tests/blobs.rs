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
    assert_eq!(json["contract_version"], svastha_core::CONTRACT_VERSION);
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
        None,
    );
    let get = second
        .oneshot(signed(&alice, "GET", "/v0/blobs/rec1", b"", now()))
        .await
        .unwrap();
    assert_eq!(get.status(), StatusCode::OK);
    assert_eq!(body_bytes(get).await, blob);
}

// --- pagination: GET /v0/blobs?limit=&cursor= ---

async fn list_query(app: &axum::Router, alice: &Identity, query: &str) -> serde_json::Value {
    let resp = app
        .clone()
        .oneshot(signed(
            alice,
            "GET",
            &format!("/v0/blobs{query}"),
            b"",
            now(),
        ))
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK, "{query}");
    serde_json::from_slice(&body_bytes(resp).await).unwrap()
}

#[tokio::test]
async fn no_params_is_unpaginated_and_byte_compatible() {
    // No `limit`/`cursor` at all: the response has no `next` key, matching the
    // shape a pre-pagination client already expects (`{"ids":[...]}` only).
    let app = router();
    let alice = Identity::from_seed(b"alice");
    for (i, id) in ["a", "b", "c"].iter().enumerate() {
        let put = app
            .clone()
            .oneshot(signed(
                &alice,
                "PUT",
                &format!("/v0/blobs/{id}"),
                b"x",
                now() + i as u64,
            ))
            .await
            .unwrap();
        assert_eq!(put.status(), StatusCode::NO_CONTENT);
    }
    let json = list_query(&app, &alice, "").await;
    assert!(
        json.get("next").is_none(),
        "unpaginated response must carry no `next` key"
    );
    let mut ids: Vec<String> = json["ids"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_str().unwrap().to_string())
        .collect();
    ids.sort();
    assert_eq!(ids, vec!["a", "b", "c"]);
}

#[tokio::test]
async fn paginated_full_walk_equals_unpaginated_listing() {
    let app = router();
    let alice = Identity::from_seed(b"alice");
    let ids: Vec<String> = (0..37).map(|i| format!("ev-{i:03}")).collect();
    for (i, id) in ids.iter().enumerate() {
        let put = app
            .clone()
            .oneshot(signed(
                &alice,
                "PUT",
                &format!("/v0/blobs/{id}"),
                b"x",
                now() + i as u64,
            ))
            .await
            .unwrap();
        assert_eq!(put.status(), StatusCode::NO_CONTENT);
    }

    // Walk the whole listing 10 ids at a time, following `next` until absent.
    let mut walked = Vec::new();
    let mut cursor: Option<String> = None;
    let mut pages = 0;
    loop {
        let query = match &cursor {
            Some(c) => format!("?limit=10&cursor={c}"),
            None => "?limit=10".to_string(),
        };
        let json = list_query(&app, &alice, &query).await;
        let page: Vec<String> = json["ids"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_str().unwrap().to_string())
            .collect();
        assert!(
            !page.is_empty(),
            "a page before the walk ends is never empty"
        );
        assert!(page.len() <= 10);
        walked.extend(page);
        pages += 1;
        cursor = json["next"].as_str().map(str::to_string);
        if cursor.is_none() {
            break;
        }
        assert!(pages <= 10, "walk did not terminate");
    }

    assert_eq!(pages, 4, "37 ids at 10/page is 4 pages");
    let mut expected = ids.clone();
    expected.sort();
    assert_eq!(
        walked, expected,
        "the full walk equals the sorted unpaginated listing"
    );
}

#[tokio::test]
async fn pagination_is_stable_under_an_interleaved_write() {
    // A page fetched, then a new blob written whose id sorts *after* the
    // already-returned page, must still surface on the very next page — the
    // walk does not skip a write that lands ahead of the cursor.
    let app = router();
    let alice = Identity::from_seed(b"alice");
    for (i, id) in ["a-1", "a-2", "a-3"].iter().enumerate() {
        let put = app
            .clone()
            .oneshot(signed(
                &alice,
                "PUT",
                &format!("/v0/blobs/{id}"),
                b"x",
                now() + i as u64,
            ))
            .await
            .unwrap();
        assert_eq!(put.status(), StatusCode::NO_CONTENT);
    }

    let first = list_query(&app, &alice, "?limit=2").await;
    let first_page: Vec<String> = first["ids"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_str().unwrap().to_string())
        .collect();
    assert_eq!(first_page, vec!["a-1", "a-2"]);
    let cursor = first["next"].as_str().unwrap().to_string();

    // Write a new blob that sorts after the cursor (and after a-3) while the
    // walk is mid-flight.
    let put_new = app
        .clone()
        .oneshot(signed(&alice, "PUT", "/v0/blobs/a-4", b"x", now() + 10))
        .await
        .unwrap();
    assert_eq!(put_new.status(), StatusCode::NO_CONTENT);

    let second = list_query(&app, &alice, &format!("?limit=2&cursor={cursor}")).await;
    let second_page: Vec<String> = second["ids"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_str().unwrap().to_string())
        .collect();
    assert_eq!(
        second_page,
        vec!["a-3", "a-4"],
        "the interleaved write, sorting after the cursor, is picked up by the next page"
    );
    assert!(second["next"].as_str().is_none(), "walk complete");
}

#[tokio::test]
async fn limit_is_clamped_and_a_bad_cursor_length_is_bad_request() {
    let app = router();
    let alice = Identity::from_seed(b"alice");
    let put = app
        .clone()
        .oneshot(signed(&alice, "PUT", "/v0/blobs/only", b"x", now()))
        .await
        .unwrap();
    assert_eq!(put.status(), StatusCode::NO_CONTENT);

    // limit=0 is clamped up to 1, not rejected — still returns the one id.
    let json = list_query(&app, &alice, "?limit=0").await;
    assert_eq!(json["ids"], serde_json::json!(["only"]));

    // An oversized cursor is rejected rather than silently accepted.
    let huge_cursor = "x".repeat(300);
    let resp = app
        .oneshot(signed(
            &alice,
            "GET",
            &format!("/v0/blobs?cursor={huge_cursor}"),
            b"",
            now(),
        ))
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
}

/// Like `common::signed`, plus one extra request header — used here to carry
/// `If-None-Match`, which a real client sends alongside (not instead of) the
/// standard auth headers.
fn signed_with_header(
    signer: &Identity,
    method: &str,
    path: &str,
    body: &[u8],
    timestamp: u64,
    header_name: &str,
    header_value: &str,
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
        .header(header_name, header_value)
        .body(Body::from(body.to_vec()))
        .unwrap()
}

// --- curation etags: GET /v0/blobs/{id} for cur- ids ---

#[tokio::test]
async fn cur_blob_carries_an_etag_and_if_none_match_answers_304() {
    let app = router();
    let alice = Identity::from_seed(b"alice");

    let put = app
        .clone()
        .oneshot(signed(
            &alice,
            "PUT",
            "/v0/blobs/cur-abc",
            b"sealed curation v1",
            now(),
        ))
        .await
        .unwrap();
    assert_eq!(put.status(), StatusCode::NO_CONTENT);

    let get1 = app
        .clone()
        .oneshot(signed(&alice, "GET", "/v0/blobs/cur-abc", b"", now()))
        .await
        .unwrap();
    assert_eq!(get1.status(), StatusCode::OK);
    let etag = get1
        .headers()
        .get("etag")
        .expect("cur- GET carries an ETag")
        .to_str()
        .unwrap()
        .to_string();
    assert_eq!(body_bytes(get1).await, b"sealed curation v1");

    // Re-fetch with If-None-Match: unchanged content, so 304 with no body.
    let req = signed_with_header(
        &alice,
        "GET",
        "/v0/blobs/cur-abc",
        b"",
        now() + 1,
        "if-none-match",
        &etag,
    );
    let get2 = app.clone().oneshot(req).await.unwrap();
    assert_eq!(get2.status(), StatusCode::NOT_MODIFIED);
    assert_eq!(
        get2.headers().get("etag").unwrap().to_str().unwrap(),
        etag,
        "304 still carries the etag"
    );
    assert!(body_bytes(get2).await.is_empty(), "304 has no body");
}

#[tokio::test]
async fn cur_blob_write_changes_the_etag() {
    let app = router();
    let alice = Identity::from_seed(b"alice");

    app.clone()
        .oneshot(signed(&alice, "PUT", "/v0/blobs/cur-x", b"v1", now()))
        .await
        .unwrap();
    let get1 = app
        .clone()
        .oneshot(signed(&alice, "GET", "/v0/blobs/cur-x", b"", now()))
        .await
        .unwrap();
    let etag1 = get1
        .headers()
        .get("etag")
        .unwrap()
        .to_str()
        .unwrap()
        .to_string();

    // Overwrite with different content (an LWW re-push).
    app.clone()
        .oneshot(signed(&alice, "PUT", "/v0/blobs/cur-x", b"v2", now() + 1))
        .await
        .unwrap();
    let get2 = app
        .clone()
        .oneshot(signed(&alice, "GET", "/v0/blobs/cur-x", b"", now() + 2))
        .await
        .unwrap();
    let etag2 = get2
        .headers()
        .get("etag")
        .unwrap()
        .to_str()
        .unwrap()
        .to_string();
    assert_ne!(etag1, etag2, "changed content changes the etag");
    assert_eq!(body_bytes(get2).await, b"v2");
}

#[tokio::test]
async fn non_curation_blob_carries_no_etag() {
    // Etags are scoped to the mutable cur- namespace; an immutable ev- blob GET
    // is unaffected.
    let app = router();
    let alice = Identity::from_seed(b"alice");
    app.clone()
        .oneshot(signed(&alice, "PUT", "/v0/blobs/ev-1", b"x", now()))
        .await
        .unwrap();
    let get = app
        .oneshot(signed(&alice, "GET", "/v0/blobs/ev-1", b"", now()))
        .await
        .unwrap();
    assert_eq!(get.status(), StatusCode::OK);
    assert!(get.headers().get("etag").is_none());
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
