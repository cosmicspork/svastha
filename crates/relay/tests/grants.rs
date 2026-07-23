//! Integration tests for grants (relay-level read authorization) and the
//! `/v0/shared/*` endpoints that read through them. Same in-process harness as
//! `blobs.rs`.

use std::sync::Arc;

use axum::http::StatusCode;
use svastha_core::keys::Identity;
use svastha_relay::app;
use svastha_relay::grants::FsGrantStore;
use svastha_relay::mailbox::MemoryMailboxStore;
use svastha_relay::share::MemoryShareStore;
use svastha_relay::store::MemoryStore;
use tower::ServiceExt;

mod common;
use common::{body_bytes, now, router, signed, SKEW};

fn hex_pk(id: &Identity) -> String {
    hex::encode(id.verifying_key().to_bytes())
}

#[tokio::test]
async fn grant_lifecycle_and_idempotency() {
    let app = router();
    let alice = Identity::from_seed(b"alice");
    let bob = Identity::from_seed(b"bob");

    // Granting twice is a no-op success, not an error. Distinct timestamps
    // because the replay guard rejects a byte-identical re-send; a real client
    // re-grants later with a fresh timestamp, which is what `now() + i` models.
    for i in 0..2 {
        let put = app
            .clone()
            .oneshot(signed(
                &alice,
                "PUT",
                &format!("/v0/grants/{}", hex_pk(&bob)),
                b"",
                now() + i,
            ))
            .await
            .unwrap();
        assert_eq!(put.status(), StatusCode::NO_CONTENT);
    }

    let list = app
        .clone()
        .oneshot(signed(&alice, "GET", "/v0/grants", b"", now()))
        .await
        .unwrap();
    let json: serde_json::Value = serde_json::from_slice(&body_bytes(list).await).unwrap();
    assert_eq!(json["grantees"], serde_json::json!([hex_pk(&bob)]));

    let del = app
        .clone()
        .oneshot(signed(
            &alice,
            "DELETE",
            &format!("/v0/grants/{}", hex_pk(&bob)),
            b"",
            now(),
        ))
        .await
        .unwrap();
    assert_eq!(del.status(), StatusCode::NO_CONTENT);

    // Revoking an already-revoked (or never-granted) pair is 404. A fresh
    // timestamp so it is a distinct request, not a replay of `del` above.
    let del_again = app
        .oneshot(signed(
            &alice,
            "DELETE",
            &format!("/v0/grants/{}", hex_pk(&bob)),
            b"",
            now() + 1,
        ))
        .await
        .unwrap();
    assert_eq!(del_again.status(), StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn malformed_grantee_hex_is_bad_request() {
    let alice = Identity::from_seed(b"alice");
    let resp = router()
        .oneshot(signed(&alice, "PUT", "/v0/grants/not-hex", b"", now()))
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn uppercase_hex_is_rejected() {
    let alice = Identity::from_seed(b"alice");
    let bob = Identity::from_seed(b"bob");
    let upper = hex_pk(&bob).to_uppercase();
    let resp = router()
        .oneshot(signed(
            &alice,
            "PUT",
            &format!("/v0/grants/{upper}"),
            b"",
            now(),
        ))
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn shared_blobs_404_without_grant_then_works_then_404_after_revoke() {
    let app = router();
    let alice = Identity::from_seed(b"alice");
    let bob = Identity::from_seed(b"bob");
    let owner = hex_pk(&alice);

    // Alice stores a blob of her own.
    let put_blob = app
        .clone()
        .oneshot(signed(
            &alice,
            "PUT",
            "/v0/blobs/rec1",
            b"alice ciphertext",
            now(),
        ))
        .await
        .unwrap();
    assert_eq!(put_blob.status(), StatusCode::NO_CONTENT);

    // Bob has no grant from Alice yet: both the list and the blob 404 — the
    // same code as "nothing there", so Bob can't distinguish "not shared with
    // you" from "empty vault" by probing.
    let list_before = app
        .clone()
        .oneshot(signed(
            &bob,
            "GET",
            &format!("/v0/shared/{owner}/blobs"),
            b"",
            now(),
        ))
        .await
        .unwrap();
    assert_eq!(list_before.status(), StatusCode::NOT_FOUND);

    let get_before = app
        .clone()
        .oneshot(signed(
            &bob,
            "GET",
            &format!("/v0/shared/{owner}/blobs/rec1"),
            b"",
            now(),
        ))
        .await
        .unwrap();
    assert_eq!(get_before.status(), StatusCode::NOT_FOUND);

    // Alice grants Bob read access.
    let grant = app
        .clone()
        .oneshot(signed(
            &alice,
            "PUT",
            &format!("/v0/grants/{}", hex_pk(&bob)),
            b"",
            now(),
        ))
        .await
        .unwrap();
    assert_eq!(grant.status(), StatusCode::NO_CONTENT);

    let list_after = app
        .clone()
        .oneshot(signed(
            &bob,
            "GET",
            &format!("/v0/shared/{owner}/blobs"),
            b"",
            now(),
        ))
        .await
        .unwrap();
    assert_eq!(list_after.status(), StatusCode::OK);
    let json: serde_json::Value = serde_json::from_slice(&body_bytes(list_after).await).unwrap();
    assert_eq!(json["ids"], serde_json::json!(["rec1"]));

    let get_after = app
        .clone()
        .oneshot(signed(
            &bob,
            "GET",
            &format!("/v0/shared/{owner}/blobs/rec1"),
            b"",
            now(),
        ))
        .await
        .unwrap();
    assert_eq!(get_after.status(), StatusCode::OK);
    assert_eq!(body_bytes(get_after).await, b"alice ciphertext");

    // Alice revokes; Bob is locked out again, same 404 as before the grant.
    let revoke = app
        .clone()
        .oneshot(signed(
            &alice,
            "DELETE",
            &format!("/v0/grants/{}", hex_pk(&bob)),
            b"",
            now(),
        ))
        .await
        .unwrap();
    assert_eq!(revoke.status(), StatusCode::NO_CONTENT);

    let get_revoked = app
        .oneshot(signed(
            &bob,
            "GET",
            &format!("/v0/shared/{owner}/blobs/rec1"),
            b"",
            now(),
        ))
        .await
        .unwrap();
    assert_eq!(get_revoked.status(), StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn shared_paths_reject_writes_with_405() {
    // No PUT/DELETE routes exist under /v0/shared/* — verify axum's own
    // method routing rejects them rather than silently 404ing or dispatching
    // to the wrong handler.
    let app = router();
    let alice = Identity::from_seed(b"alice");
    let bob = Identity::from_seed(b"bob");
    let owner = hex_pk(&alice);

    for (method, path) in [
        ("PUT", format!("/v0/shared/{owner}/blobs")),
        ("DELETE", format!("/v0/shared/{owner}/blobs")),
        ("PUT", format!("/v0/shared/{owner}/blobs/rec1")),
        ("DELETE", format!("/v0/shared/{owner}/blobs/rec1")),
        ("PUT", "/v0/shared".to_string()),
    ] {
        let resp = app
            .clone()
            .oneshot(signed(&bob, method, &path, b"", now()))
            .await
            .unwrap();
        assert_eq!(
            resp.status(),
            StatusCode::METHOD_NOT_ALLOWED,
            "{method} {path}"
        );
    }
}

#[tokio::test]
async fn dual_direction_listing() {
    let app = router();
    let alice = Identity::from_seed(b"alice");
    let bob = Identity::from_seed(b"bob");
    let carol = Identity::from_seed(b"carol");

    // Alice grants both Bob and Carol; Bob is also granted by Carol.
    for (owner, grantee) in [(&alice, &bob), (&alice, &carol), (&carol, &bob)] {
        let resp = app
            .clone()
            .oneshot(signed(
                owner,
                "PUT",
                &format!("/v0/grants/{}", hex_pk(grantee)),
                b"",
                now(),
            ))
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::NO_CONTENT);
    }

    let alice_grantees = app
        .clone()
        .oneshot(signed(&alice, "GET", "/v0/grants", b"", now()))
        .await
        .unwrap();
    let json: serde_json::Value =
        serde_json::from_slice(&body_bytes(alice_grantees).await).unwrap();
    let mut grantees: Vec<String> = json["grantees"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_str().unwrap().to_string())
        .collect();
    grantees.sort();
    let mut expected = vec![hex_pk(&bob), hex_pk(&carol)];
    expected.sort();
    assert_eq!(grantees, expected);

    // Bob's "shared with me" lists both Alice and Carol as granters.
    let bob_shared = app
        .oneshot(signed(&bob, "GET", "/v0/shared", b"", now()))
        .await
        .unwrap();
    let json: serde_json::Value = serde_json::from_slice(&body_bytes(bob_shared).await).unwrap();
    let mut owners: Vec<String> = json["owners"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_str().unwrap().to_string())
        .collect();
    owners.sort();
    let mut expected = vec![hex_pk(&alice), hex_pk(&carol)];
    expected.sort();
    assert_eq!(owners, expected);
}

/// Store `ev-1`, `att-1`, and `cur-1` under Alice, and return an app plus the
/// two identities — the fixture the scope tests share.
async fn alice_with_three_blobs() -> (axum::Router, Identity, Identity) {
    let app = router();
    let alice = Identity::from_seed(b"alice");
    let bob = Identity::from_seed(b"bob");
    for (i, id) in ["ev-1", "att-1", "cur-1"].iter().enumerate() {
        let put = app
            .clone()
            .oneshot(signed(
                &alice,
                "PUT",
                &format!("/v0/blobs/{id}"),
                b"sealed",
                now() + i as u64,
            ))
            .await
            .unwrap();
        assert_eq!(put.status(), StatusCode::NO_CONTENT);
    }
    (app, alice, bob)
}

async fn shared_ids(app: &axum::Router, caller: &Identity, owner: &str, ts: u64) -> Vec<String> {
    let resp = app
        .clone()
        .oneshot(signed(
            caller,
            "GET",
            &format!("/v0/shared/{owner}/blobs"),
            b"",
            ts,
        ))
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let json: serde_json::Value = serde_json::from_slice(&body_bytes(resp).await).unwrap();
    let mut ids: Vec<String> = json["ids"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_str().unwrap().to_string())
        .collect();
    ids.sort();
    ids
}

async fn shared_fetch_status(
    app: &axum::Router,
    caller: &Identity,
    owner: &str,
    id: &str,
    ts: u64,
) -> StatusCode {
    app.clone()
        .oneshot(signed(
            caller,
            "GET",
            &format!("/v0/shared/{owner}/blobs/{id}"),
            b"",
            ts,
        ))
        .await
        .unwrap()
        .status()
}

#[tokio::test]
async fn prefix_allowlist_scopes_listing_and_fetch() {
    let (app, alice, bob) = alice_with_three_blobs().await;
    let owner = hex_pk(&alice);

    // Alice grants Bob a prefix-scoped grant: only ev- and att- are readable.
    let grant = app
        .clone()
        .oneshot(signed(
            &alice,
            "PUT",
            &format!("/v0/grants/{}", hex_pk(&bob)),
            br#"{"prefixes":["ev-","att-"]}"#,
            now(),
        ))
        .await
        .unwrap();
    assert_eq!(grant.status(), StatusCode::NO_CONTENT);

    // The listing hides cur-1 entirely — Bob never learns it exists.
    assert_eq!(
        shared_ids(&app, &bob, &owner, now()).await,
        vec!["att-1".to_string(), "ev-1".to_string()]
    );

    // Admitted prefixes fetch; the excluded one 404s exactly like a missing
    // blob, so the excluded namespace is indistinguishable from an empty one.
    assert_eq!(
        shared_fetch_status(&app, &bob, &owner, "ev-1", now()).await,
        StatusCode::OK
    );
    assert_eq!(
        shared_fetch_status(&app, &bob, &owner, "att-1", now()).await,
        StatusCode::OK
    );
    assert_eq!(
        shared_fetch_status(&app, &bob, &owner, "cur-1", now()).await,
        StatusCode::NOT_FOUND
    );
}

#[tokio::test]
async fn expired_grant_behaves_as_no_grant() {
    let (app, alice, bob) = alice_with_three_blobs().await;
    let owner = hex_pk(&alice);
    let base = now();

    // A grant that expires one second before the request clock. Past expiry, it
    // must be indistinguishable from no grant at all: listing and fetch 404.
    let expired_body = format!(r#"{{"expires_at":{}}}"#, base - 1);
    let grant = app
        .clone()
        .oneshot(signed(
            &alice,
            "PUT",
            &format!("/v0/grants/{}", hex_pk(&bob)),
            expired_body.as_bytes(),
            base,
        ))
        .await
        .unwrap();
    assert_eq!(grant.status(), StatusCode::NO_CONTENT);

    let list = app
        .clone()
        .oneshot(signed(
            &bob,
            "GET",
            &format!("/v0/shared/{owner}/blobs"),
            b"",
            base + 1,
        ))
        .await
        .unwrap();
    assert_eq!(list.status(), StatusCode::NOT_FOUND);
    assert_eq!(
        shared_fetch_status(&app, &bob, &owner, "ev-1", base + 1).await,
        StatusCode::NOT_FOUND
    );

    // Re-issue with an expiry comfortably in the future (upsert): it now works.
    let future_body = format!(r#"{{"expires_at":{}}}"#, base + 3600);
    let regrant = app
        .clone()
        .oneshot(signed(
            &alice,
            "PUT",
            &format!("/v0/grants/{}", hex_pk(&bob)),
            future_body.as_bytes(),
            base + 2,
        ))
        .await
        .unwrap();
    assert_eq!(regrant.status(), StatusCode::NO_CONTENT);

    // No prefix scope, so all three blobs are visible before the expiry.
    assert_eq!(
        shared_ids(&app, &bob, &owner, base + 3).await,
        vec!["att-1".to_string(), "cur-1".to_string(), "ev-1".to_string()]
    );
    assert_eq!(
        shared_fetch_status(&app, &bob, &owner, "ev-1", base + 3).await,
        StatusCode::OK
    );
}

#[tokio::test]
async fn legacy_unscoped_grant_reads_everything() {
    // An empty-body PUT is the legacy (pre-scoping) request shape: full read, no
    // expiry, unchanged behavior.
    let (app, alice, bob) = alice_with_three_blobs().await;
    let owner = hex_pk(&alice);

    let grant = app
        .clone()
        .oneshot(signed(
            &alice,
            "PUT",
            &format!("/v0/grants/{}", hex_pk(&bob)),
            b"",
            now(),
        ))
        .await
        .unwrap();
    assert_eq!(grant.status(), StatusCode::NO_CONTENT);

    assert_eq!(
        shared_ids(&app, &bob, &owner, now()).await,
        vec!["att-1".to_string(), "cur-1".to_string(), "ev-1".to_string()]
    );
    for id in ["ev-1", "att-1", "cur-1"] {
        assert_eq!(
            shared_fetch_status(&app, &bob, &owner, id, now()).await,
            StatusCode::OK,
            "{id}"
        );
    }
}

#[tokio::test]
async fn upsert_rescopes_an_existing_grant() {
    let (app, alice, bob) = alice_with_three_blobs().await;
    let owner = hex_pk(&alice);
    let base = now();

    // Start with a full (unscoped) grant: att-1 is readable.
    let full = app
        .clone()
        .oneshot(signed(
            &alice,
            "PUT",
            &format!("/v0/grants/{}", hex_pk(&bob)),
            b"",
            base,
        ))
        .await
        .unwrap();
    assert_eq!(full.status(), StatusCode::NO_CONTENT);
    assert_eq!(
        shared_fetch_status(&app, &bob, &owner, "att-1", base + 1).await,
        StatusCode::OK
    );

    // Re-PUT the same grantee with a narrower scope (ev- only). The upsert
    // replaces the scope in place — att-1 is now invisible.
    let rescope = app
        .clone()
        .oneshot(signed(
            &alice,
            "PUT",
            &format!("/v0/grants/{}", hex_pk(&bob)),
            br#"{"prefixes":["ev-"]}"#,
            base + 2,
        ))
        .await
        .unwrap();
    assert_eq!(rescope.status(), StatusCode::NO_CONTENT);
    assert_eq!(
        shared_ids(&app, &bob, &owner, base + 3).await,
        vec!["ev-1".to_string()]
    );
    assert_eq!(
        shared_fetch_status(&app, &bob, &owner, "att-1", base + 3).await,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        shared_fetch_status(&app, &bob, &owner, "ev-1", base + 3).await,
        StatusCode::OK
    );
}

#[tokio::test]
async fn malformed_grant_body_is_bad_request() {
    let app = router();
    let alice = Identity::from_seed(b"alice");
    let bob = Identity::from_seed(b"bob");
    let resp = app
        .oneshot(signed(
            &alice,
            "PUT",
            &format!("/v0/grants/{}", hex_pk(&bob)),
            b"not json",
            now(),
        ))
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn fs_grant_store_persists_across_router_rebuild() {
    let dir = tempfile::tempdir().unwrap();
    let alice = Identity::from_seed(b"alice");
    let bob = Identity::from_seed(b"bob");

    let build = |dir: &std::path::Path| {
        app(
            Arc::new(MemoryStore::new()),
            Arc::new(FsGrantStore::new(dir).unwrap()),
            Arc::new(MemoryMailboxStore::new()),
            Arc::new(MemoryShareStore::new()),
            SKEW,
            None,
        )
    };

    let first = build(dir.path());
    let grant = first
        .oneshot(signed(
            &alice,
            "PUT",
            &format!("/v0/grants/{}", hex_pk(&bob)),
            b"",
            now(),
        ))
        .await
        .unwrap();
    assert_eq!(grant.status(), StatusCode::NO_CONTENT);

    // A fresh router over the same directory still sees the grant.
    let second = build(dir.path());
    let check = second
        .oneshot(signed(&alice, "GET", "/v0/grants", b"", now()))
        .await
        .unwrap();
    let json: serde_json::Value = serde_json::from_slice(&body_bytes(check).await).unwrap();
    assert_eq!(json["grantees"], serde_json::json!([hex_pk(&bob)]));
}
