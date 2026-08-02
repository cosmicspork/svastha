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
        .uri("/v0/blobs/rec2")
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

// --- batched fetch: ?include=body ---

/// Fetch one framed page: asserts the batched content type, returns the parsed
/// frames and the continuation cursor from the `svastha-next` header.
async fn fetch_framed(
    app: &axum::Router,
    signer: &Identity,
    path: &str,
    ts: u64,
) -> (Vec<(String, Vec<u8>)>, Option<String>) {
    let resp = app
        .clone()
        .oneshot(signed(signer, "GET", path, b"", ts))
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK, "{path}");
    assert_eq!(
        resp.headers().get("content-type").unwrap(),
        "application/octet-stream",
        "{path}"
    );
    let next = resp
        .headers()
        .get("svastha-next")
        .map(|v| v.to_str().unwrap().to_string());
    (common::parse_frames(&body_bytes(resp).await), next)
}

/// Fetch a listing raw — content type plus exact response bytes — for the
/// byte-identity comparisons below.
async fn fetch_raw(
    app: &axum::Router,
    signer: &Identity,
    path: &str,
    ts: u64,
) -> (String, Vec<u8>) {
    let resp = app
        .clone()
        .oneshot(signed(signer, "GET", path, b"", ts))
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK, "{path}");
    let content_type = resp
        .headers()
        .get("content-type")
        .unwrap()
        .to_str()
        .unwrap()
        .to_string();
    (content_type, body_bytes(resp).await)
}

async fn put_blobs(app: &axum::Router, signer: &Identity, blobs: &[(&str, Vec<u8>)]) {
    for (i, (id, body)) in blobs.iter().enumerate() {
        let put = app
            .clone()
            .oneshot(signed(
                signer,
                "PUT",
                &format!("/v0/blobs/{id}"),
                body,
                now() + i as u64,
            ))
            .await
            .unwrap();
        assert_eq!(put.status(), StatusCode::NO_CONTENT);
    }
}

#[tokio::test]
async fn include_body_full_walk_frames_round_trip() {
    let app = router();
    let alice = Identity::from_seed(b"alice");
    let blobs: Vec<(String, Vec<u8>)> = (0..5)
        .map(|i| (format!("ev-{i:03}"), format!("sealed {i}").into_bytes()))
        .collect();
    let put_args: Vec<(&str, Vec<u8>)> = blobs
        .iter()
        .map(|(id, body)| (id.as_str(), body.clone()))
        .collect();
    put_blobs(&app, &alice, &put_args).await;

    let mut walked: Vec<(String, Vec<u8>)> = Vec::new();
    let mut cursor: Option<String> = None;
    let mut pages = 0;
    loop {
        let query = match &cursor {
            Some(c) => format!("?include=body&limit=2&cursor={c}"),
            None => "?include=body&limit=2".to_string(),
        };
        let (frames, next) = fetch_framed(&app, &alice, &format!("/v0/blobs{query}"), now()).await;
        walked.extend(frames);
        pages += 1;
        assert!(pages <= 5, "walk did not terminate");
        cursor = next;
        if cursor.is_none() {
            break;
        }
    }

    assert_eq!(pages, 3, "5 ids at 2/page is 3 pages");
    assert_eq!(
        walked, blobs,
        "the framed walk yields every blob, in sorted id order, byte for byte"
    );
}

#[tokio::test]
async fn include_absent_or_unrecognized_is_byte_identical_json() {
    let app = router();
    let alice = Identity::from_seed(b"alice");
    put_blobs(
        &app,
        &alice,
        &[
            ("ev-1", b"a".to_vec()),
            ("ev-2", b"b".to_vec()),
            ("cur-1", b"c".to_vec()),
        ],
    )
    .await;

    let plain = fetch_raw(&app, &alice, "/v0/blobs", now() + 10).await;
    let unrecognized = fetch_raw(&app, &alice, "/v0/blobs?include=ids", now() + 10).await;
    assert_eq!(plain.0, "application/json");
    assert_eq!(
        plain, unrecognized,
        "an unrecognized include leaves the unpaginated listing untouched"
    );

    let paged = fetch_raw(&app, &alice, "/v0/blobs?limit=10", now() + 10).await;
    let paged_empty_include =
        fetch_raw(&app, &alice, "/v0/blobs?limit=10&include=", now() + 10).await;
    assert_eq!(paged.0, "application/json");
    assert_eq!(
        paged, paged_empty_include,
        "an empty include is treated as absent, not rejected"
    );
}

#[tokio::test]
async fn include_body_empty_vault_is_empty_octet_stream_with_no_next() {
    let app = router();
    let alice = Identity::from_seed(b"alice");
    let (frames, next) = fetch_framed(&app, &alice, "/v0/blobs?include=body", now()).await;
    assert!(frames.is_empty());
    assert!(next.is_none(), "an empty page ends the walk");
}

#[tokio::test]
async fn budget_truncated_page_sets_next_at_first_unsent_id() {
    // Three 3 MiB blobs: two fit inside the 8 MiB byte budget, the third does
    // not, so the page ends short of the requested limit of 10.
    let app = router();
    let alice = Identity::from_seed(b"alice");
    let big = vec![7u8; 3 * 1024 * 1024];
    put_blobs(
        &app,
        &alice,
        &[
            ("ev-a", big.clone()),
            ("ev-b", big.clone()),
            ("ev-c", big.clone()),
        ],
    )
    .await;

    let (frames, next) =
        fetch_framed(&app, &alice, "/v0/blobs?include=body&limit=10", now() + 10).await;
    let ids: Vec<&str> = frames.iter().map(|(id, _)| id.as_str()).collect();
    assert_eq!(ids, vec!["ev-a", "ev-b"], "the byte budget ended the page");
    assert_eq!(
        next.as_deref(),
        Some("ev-b"),
        "the cursor is the last id that shipped, so the walk resumes at the first that did not"
    );

    let (rest, done) = fetch_framed(
        &app,
        &alice,
        "/v0/blobs?include=body&limit=10&cursor=ev-b",
        now() + 11,
    )
    .await;
    assert_eq!(
        rest,
        vec![("ev-c".to_string(), big)],
        "resuming picks up exactly the blob the budget cut off"
    );
    assert!(done.is_none());
}

#[tokio::test]
async fn oversized_single_blob_ships_alone() {
    // A blob larger than the whole budget must still be served, on a page of
    // its own, or the walk could never get past it.
    let app = router();
    let alice = Identity::from_seed(b"alice");
    let small = vec![1u8; 1024];
    let huge = vec![2u8; 9 * 1024 * 1024];
    put_blobs(
        &app,
        &alice,
        &[
            ("ev-a", small.clone()),
            ("ev-b", huge.clone()),
            ("ev-c", small.clone()),
        ],
    )
    .await;

    let mut pages: Vec<Vec<String>> = Vec::new();
    let mut cursor: Option<String> = None;
    loop {
        let query = match &cursor {
            Some(c) => format!("?include=body&limit=10&cursor={c}"),
            None => "?include=body&limit=10".to_string(),
        };
        let (frames, next) =
            fetch_framed(&app, &alice, &format!("/v0/blobs{query}"), now() + 10).await;
        pages.push(frames.iter().map(|(id, _)| id.clone()).collect());
        for (id, blob) in &frames {
            let expected = if id == "ev-b" { &huge } else { &small };
            assert_eq!(blob, expected, "{id} arrived intact");
        }
        assert!(pages.len() <= 5, "walk did not terminate");
        cursor = next;
        if cursor.is_none() {
            break;
        }
    }

    assert_eq!(
        pages,
        vec![vec!["ev-a"], vec!["ev-b"], vec!["ev-c"]],
        "the oversized blob ships alone, and the small blobs on either side are not lost"
    );
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
    // Preflights are cacheable: without a max-age, every cross-origin write
    // pays an extra OPTIONS round trip (browsers default to ~5s).
    assert_eq!(
        resp.headers().get("access-control-max-age").unwrap(),
        "3600"
    );
}

/// Write a raw file straight into `owner`'s directory on `store_dir`,
/// bypassing `PUT` (and its `valid_id` gate entirely) to reproduce
/// legacy/foreign on-disk data — see the relay README's "Upgrading past
/// 0.13.0". A raw control byte sorts before every ASCII id, so it lands first
/// in every fresh sorted walk, and is valid UTF-8 (so `to_string_lossy`
/// reproduces it losslessly) but not a valid HTTP header value.
fn plant_unwritable_entry(store_dir: &std::path::Path, owner: &Identity) {
    let owner_hex = hex::encode(owner.verifying_key().to_bytes());
    let owner_dir = store_dir.join(&owner_hex);
    std::fs::create_dir_all(&owner_dir).unwrap();
    std::fs::write(owner_dir.join("\u{1}bad"), b"junk").unwrap();
}

#[tokio::test]
async fn a_bad_on_disk_entry_is_excluded_from_the_plain_listing() {
    let dir = tempfile::tempdir().unwrap();
    let alice = Identity::from_seed(b"alice");
    plant_unwritable_entry(dir.path(), &alice);

    let app = app(
        Arc::new(FsStore::new(dir.path()).unwrap()),
        Arc::new(MemoryGrantStore::new()),
        Arc::new(MemoryMailboxStore::new()),
        Arc::new(MemoryShareStore::new()),
        SKEW,
        None,
        None,
    );
    put_blobs(
        &app,
        &alice,
        &[("ev-1", b"a".to_vec()), ("ev-2", b"b".to_vec())],
    )
    .await;

    let json = list_query(&app, &alice, "").await;
    let mut ids: Vec<String> = json["ids"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_str().unwrap().to_string())
        .collect();
    ids.sort();
    assert_eq!(
        ids,
        vec!["ev-1", "ev-2"],
        "an id no write could have produced never surfaces in a listing"
    );
}

#[tokio::test]
async fn a_bad_on_disk_entry_never_stalls_the_framed_walk() {
    // Regression for a version of the fix that only made the cursor header
    // fallible: the invalid entry sorts first, so if it were still handed to
    // `paginate_ids`/`framed_page` at all, a client walking one id per page
    // would see the header omitted on page one and stop there forever,
    // permanently truncating sync before it ever reached "ev-1"/"ev-2". The
    // fix is to filter the id out before pagination, not just survive
    // encoding it.
    let dir = tempfile::tempdir().unwrap();
    let alice = Identity::from_seed(b"alice");
    plant_unwritable_entry(dir.path(), &alice);

    let app = app(
        Arc::new(FsStore::new(dir.path()).unwrap()),
        Arc::new(MemoryGrantStore::new()),
        Arc::new(MemoryMailboxStore::new()),
        Arc::new(MemoryShareStore::new()),
        SKEW,
        None,
        None,
    );
    put_blobs(
        &app,
        &alice,
        &[("ev-1", b"a".to_vec()), ("ev-2", b"b".to_vec())],
    )
    .await;

    let mut walked: Vec<String> = Vec::new();
    let mut cursor: Option<String> = None;
    let mut pages: u64 = 0;
    loop {
        let query = match &cursor {
            Some(c) => format!("?include=body&limit=1&cursor={c}"),
            None => "?include=body&limit=1".to_string(),
        };
        let (frames, next) = fetch_framed(
            &app,
            &alice,
            &format!("/v0/blobs{query}"),
            now() + 10 + pages,
        )
        .await;
        walked.extend(frames.into_iter().map(|(id, _)| id));
        pages += 1;
        assert!(pages <= 5, "walk did not terminate");
        cursor = next;
        if cursor.is_none() {
            break;
        }
    }

    assert_eq!(
        walked,
        vec!["ev-1", "ev-2"],
        "both valid ids are reached even though the bad entry sorts before them"
    );
}

#[tokio::test]
async fn cors_exposes_next_header() {
    // The batched walk is driven entirely by `svastha-next`, and a response
    // header a browser cannot read is invisible to the PWA — so pin the expose
    // posture here rather than let a future CORS tightening silently strand the
    // walk on its first page.
    let app = router();
    let alice = Identity::from_seed(b"alice");
    put_blobs(
        &app,
        &alice,
        &[("ev-a", b"a".to_vec()), ("ev-b", b"b".to_vec())],
    )
    .await;

    let resp = app
        .oneshot(signed(
            &alice,
            "GET",
            "/v0/blobs?include=body&limit=1",
            b"",
            now() + 10,
        ))
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    assert!(
        resp.headers().contains_key("svastha-next"),
        "a limit of 1 over two blobs leaves a continuation cursor"
    );
    let exposed = resp
        .headers()
        .get("access-control-expose-headers")
        .expect("responses carry an expose-headers list")
        .to_str()
        .unwrap()
        .to_lowercase();
    assert!(
        exposed == "*" || exposed.contains("svastha-next"),
        "svastha-next must be readable from a browser, got {exposed:?}"
    );
}
