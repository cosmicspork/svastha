//! Integration tests for the mailbox: a store-and-forward drop box for wrapped
//! vault keys. Same in-process harness as `blobs.rs`.

use std::sync::Arc;

use axum::http::StatusCode;
use svastha_core::keys::Identity;
use svastha_relay::app;
use svastha_relay::grants::MemoryGrantStore;
use svastha_relay::mailbox::FsMailboxStore;
use svastha_relay::share::MemoryShareStore;
use svastha_relay::store::MemoryStore;
use tower::ServiceExt;

mod common;
use common::{body_bytes, now, router, signed, SKEW};

fn hex_pk(id: &Identity) -> String {
    hex::encode(id.verifying_key().to_bytes())
}

#[tokio::test]
async fn deposit_list_get_delete_round_trip() {
    let app = router();
    let alice = Identity::from_seed(b"alice");
    let bob = Identity::from_seed(b"bob");
    let path = format!(
        "/v0/mailbox/{}/vaultkey-{}",
        hex_pk(&bob),
        &hex_pk(&alice)[..8]
    );

    let put = app
        .clone()
        .oneshot(signed(&alice, "PUT", &path, b"wrapped key bytes", now()))
        .await
        .unwrap();
    assert_eq!(put.status(), StatusCode::NO_CONTENT);

    let id = format!("vaultkey-{}", &hex_pk(&alice)[..8]);

    let list = app
        .clone()
        .oneshot(signed(&bob, "GET", "/v0/mailbox", b"", now()))
        .await
        .unwrap();
    assert_eq!(list.status(), StatusCode::OK);
    let json: serde_json::Value = serde_json::from_slice(&body_bytes(list).await).unwrap();
    assert_eq!(
        json["items"],
        serde_json::json!([{ "id": id, "from": hex_pk(&alice) }])
    );

    let get = app
        .clone()
        .oneshot(signed(
            &bob,
            "GET",
            &format!("/v0/mailbox/{id}"),
            b"",
            now(),
        ))
        .await
        .unwrap();
    assert_eq!(get.status(), StatusCode::OK);
    assert_eq!(
        get.headers().get("svastha-from").unwrap().to_str().unwrap(),
        hex_pk(&alice)
    );
    assert_eq!(body_bytes(get).await, b"wrapped key bytes");

    let del = app
        .clone()
        .oneshot(signed(
            &bob,
            "DELETE",
            &format!("/v0/mailbox/{id}"),
            b"",
            now(),
        ))
        .await
        .unwrap();
    assert_eq!(del.status(), StatusCode::NO_CONTENT);

    let gone = app
        .clone()
        .oneshot(signed(
            &bob,
            "GET",
            &format!("/v0/mailbox/{id}"),
            b"",
            now(),
        ))
        .await
        .unwrap();
    assert_eq!(gone.status(), StatusCode::NOT_FOUND);

    let del_again = app
        .oneshot(signed(
            &bob,
            "DELETE",
            &format!("/v0/mailbox/{id}"),
            b"",
            now(),
        ))
        .await
        .unwrap();
    assert_eq!(del_again.status(), StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn any_authed_identity_may_deposit() {
    // Depositing requires no grant: the payload is opaque and the recipient
    // decides whether to trust it.
    let app = router();
    let stranger = Identity::from_seed(b"stranger");
    let recipient = Identity::from_seed(b"recipient");

    let put = app
        .oneshot(signed(
            &stranger,
            "PUT",
            &format!("/v0/mailbox/{}/item-1", hex_pk(&recipient)),
            b"hello",
            now(),
        ))
        .await
        .unwrap();
    assert_eq!(put.status(), StatusCode::NO_CONTENT);
}

#[tokio::test]
async fn oversized_deposit_is_413() {
    let app = router();
    let alice = Identity::from_seed(b"alice");
    let bob = Identity::from_seed(b"bob");
    let path = format!("/v0/mailbox/{}/item-1", hex_pk(&bob));

    let at_cap = vec![0u8; 4096];
    let ok = app
        .clone()
        .oneshot(signed(&alice, "PUT", &path, &at_cap, now()))
        .await
        .unwrap();
    assert_eq!(ok.status(), StatusCode::NO_CONTENT);

    let over_cap = vec![0u8; 4097];
    let rejected = app
        .oneshot(signed(&alice, "PUT", &path, &over_cap, now()))
        .await
        .unwrap();
    assert_eq!(rejected.status(), StatusCode::PAYLOAD_TOO_LARGE);
}

#[tokio::test]
async fn recipient_isolation() {
    let app = router();
    let alice = Identity::from_seed(b"alice");
    let bob = Identity::from_seed(b"bob");
    let carol = Identity::from_seed(b"carol");

    let put = app
        .clone()
        .oneshot(signed(
            &alice,
            "PUT",
            &format!("/v0/mailbox/{}/item-1", hex_pk(&bob)),
            b"for bob only",
            now(),
        ))
        .await
        .unwrap();
    assert_eq!(put.status(), StatusCode::NO_CONTENT);

    // Carol has no such item — her own mailbox is unaffected by Bob's.
    let carol_list = app
        .oneshot(signed(&carol, "GET", "/v0/mailbox", b"", now()))
        .await
        .unwrap();
    let json: serde_json::Value = serde_json::from_slice(&body_bytes(carol_list).await).unwrap();
    assert_eq!(json["items"], serde_json::json!([]));
}

#[tokio::test]
async fn fs_mailbox_store_persists_across_router_rebuild() {
    let dir = tempfile::tempdir().unwrap();
    let alice = Identity::from_seed(b"alice");
    let bob = Identity::from_seed(b"bob");

    let build = |dir: &std::path::Path| {
        app(
            Arc::new(MemoryStore::new()),
            Arc::new(MemoryGrantStore::new()),
            Arc::new(FsMailboxStore::new(dir).unwrap()),
            Arc::new(MemoryShareStore::new()),
            SKEW,
            None,
        )
    };

    let first = build(dir.path());
    let put = first
        .oneshot(signed(
            &alice,
            "PUT",
            &format!("/v0/mailbox/{}/item-1", hex_pk(&bob)),
            b"durable wrapped key",
            now(),
        ))
        .await
        .unwrap();
    assert_eq!(put.status(), StatusCode::NO_CONTENT);

    // A fresh router over the same directory still serves it, with the
    // depositor's identity intact.
    let second = build(dir.path());
    let get = second
        .oneshot(signed(&bob, "GET", "/v0/mailbox/item-1", b"", now()))
        .await
        .unwrap();
    assert_eq!(get.status(), StatusCode::OK);
    assert_eq!(
        get.headers().get("svastha-from").unwrap().to_str().unwrap(),
        hex_pk(&alice)
    );
    assert_eq!(body_bytes(get).await, b"durable wrapped key");
}
