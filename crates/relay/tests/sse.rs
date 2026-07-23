//! Integration tests for the relay's SSE push channel (`GET /v0/events`): the
//! payload-free poke stream. Same in-process `tower::oneshot` harness as
//! `blobs.rs`. A poke is lossy by design, so every test subscribes (opens the
//! stream) *before* triggering the change that pokes it — the ordering the real
//! client relies on too.

use std::time::Duration;

use axum::body::Body;
use axum::http::{Request, StatusCode};
use svastha_core::keys::Identity;
use tokio_stream::StreamExt;
use tower::ServiceExt;

mod common;
use common::{now, router, signed};

fn hex_pk(id: &Identity) -> String {
    hex::encode(id.verifying_key().to_bytes())
}

/// Open the SSE stream for `signer` and assert it is a live event-stream.
/// Returns the streaming body so a test can read pokes off it.
async fn open_events(app: &axum::Router, signer: &Identity) -> axum::body::BodyDataStream {
    let resp = app
        .clone()
        .oneshot(signed(signer, "GET", "/v0/events", b"", now()))
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    assert_eq!(
        resp.headers()
            .get(axum::http::header::CONTENT_TYPE)
            .unwrap()
            .to_str()
            .unwrap(),
        "text/event-stream"
    );
    resp.into_body().into_data_stream()
}

/// Read the next SSE frame as text, failing if none arrives promptly. The
/// heartbeat is 30s away, so anything read here is a real poke.
async fn next_frame(stream: &mut axum::body::BodyDataStream) -> String {
    let chunk = tokio::time::timeout(Duration::from_secs(3), stream.next())
        .await
        .expect("a poke should arrive well within the timeout")
        .expect("the stream should not have ended")
        .expect("the body chunk should not error");
    String::from_utf8_lossy(&chunk).into_owned()
}

#[tokio::test]
async fn events_requires_auth() {
    let resp = router()
        .oneshot(
            Request::builder()
                .uri("/v0/events")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn deposit_pokes_the_recipient() {
    let app = router();
    let alice = Identity::from_seed(b"alice");
    let bob = Identity::from_seed(b"bob");

    // Bob is listening before Alice deposits.
    let mut bob_stream = open_events(&app, &bob).await;

    let deposit = app
        .clone()
        .oneshot(signed(
            &alice,
            "PUT",
            &format!("/v0/mailbox/{}/item-1", hex_pk(&bob)),
            b"wrapped key",
            now(),
        ))
        .await
        .unwrap();
    assert_eq!(deposit.status(), StatusCode::NO_CONTENT);

    let frame = next_frame(&mut bob_stream).await;
    assert!(frame.contains("event: mailbox"), "got: {frame}");
    // Payload-free: the poke never carries the deposited id or the sender.
    assert!(
        !frame.contains("item-1"),
        "poke leaked the item id: {frame}"
    );
    assert!(
        !frame.contains(&hex_pk(&alice)),
        "poke leaked the sender: {frame}"
    );
}

#[tokio::test]
async fn own_blob_write_pokes_own_other_devices() {
    let app = router();
    let alice = Identity::from_seed(b"alice");

    // A second device on the same identity is listening.
    let mut alice_stream = open_events(&app, &alice).await;

    let put = app
        .clone()
        .oneshot(signed(&alice, "PUT", "/v0/blobs/ev-1", b"sealed", now()))
        .await
        .unwrap();
    assert_eq!(put.status(), StatusCode::NO_CONTENT);

    let frame = next_frame(&mut alice_stream).await;
    assert!(frame.contains("event: blobs"), "got: {frame}");
    assert!(!frame.contains("ev-1"), "poke leaked the blob id: {frame}");
}

#[tokio::test]
async fn blob_write_pokes_a_grantee() {
    let app = router();
    let alice = Identity::from_seed(b"alice");
    let bob = Identity::from_seed(b"bob");

    // Alice grants Bob read access to her vault.
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

    // Bob listens, then Alice writes: Bob (a grantee) is poked to pull.
    let mut bob_stream = open_events(&app, &bob).await;
    let put = app
        .clone()
        .oneshot(signed(&alice, "PUT", "/v0/blobs/ev-2", b"sealed", now()))
        .await
        .unwrap();
    assert_eq!(put.status(), StatusCode::NO_CONTENT);

    let frame = next_frame(&mut bob_stream).await;
    assert!(frame.contains("event: blobs"), "got: {frame}");
}

#[tokio::test]
async fn scoped_out_grantee_is_not_poked() {
    // A prefix-scoped grantee is not woken for a write it could not read. This is
    // a courtesy, not a leak boundary (a poke carries no id either way), so a
    // spurious poke would only cost a harmless empty pull — but the relay already
    // knows the scope, so it skips it.
    let app = router();
    let alice = Identity::from_seed(b"alice");
    let bob = Identity::from_seed(b"bob");

    // Bob may read only att- blobs.
    let grant = app
        .clone()
        .oneshot(signed(
            &alice,
            "PUT",
            &format!("/v0/grants/{}", hex_pk(&bob)),
            br#"{"prefixes":["att-"]}"#,
            now(),
        ))
        .await
        .unwrap();
    assert_eq!(grant.status(), StatusCode::NO_CONTENT);

    let mut bob_stream = open_events(&app, &bob).await;

    // Alice writes an ev- blob, outside Bob's scope: no poke reaches Bob.
    let put_ev = app
        .clone()
        .oneshot(signed(&alice, "PUT", "/v0/blobs/ev-9", b"sealed", now()))
        .await
        .unwrap();
    assert_eq!(put_ev.status(), StatusCode::NO_CONTENT);
    let quiet = tokio::time::timeout(Duration::from_millis(300), bob_stream.next()).await;
    assert!(quiet.is_err(), "scoped-out grantee was poked for ev-");

    // An att- write is within scope: now Bob is poked.
    let put_att = app
        .clone()
        .oneshot(signed(
            &alice,
            "PUT",
            "/v0/blobs/att-9",
            b"sealed",
            now() + 1,
        ))
        .await
        .unwrap();
    assert_eq!(put_att.status(), StatusCode::NO_CONTENT);
    let frame = next_frame(&mut bob_stream).await;
    assert!(frame.contains("event: blobs"), "got: {frame}");
}

#[tokio::test]
async fn expired_grantee_is_not_poked() {
    // An expired grant should not poke its grantee at all — it behaves as no
    // grant everywhere, the push channel included.
    let app = router();
    let alice = Identity::from_seed(b"alice");
    let bob = Identity::from_seed(b"bob");

    let base = now();
    let expired = format!(r#"{{"expires_at":{}}}"#, base - 1);
    let grant = app
        .clone()
        .oneshot(signed(
            &alice,
            "PUT",
            &format!("/v0/grants/{}", hex_pk(&bob)),
            expired.as_bytes(),
            base,
        ))
        .await
        .unwrap();
    assert_eq!(grant.status(), StatusCode::NO_CONTENT);

    let mut bob_stream = open_events(&app, &bob).await;
    let put = app
        .clone()
        .oneshot(signed(&alice, "PUT", "/v0/blobs/ev-8", b"sealed", base + 1))
        .await
        .unwrap();
    assert_eq!(put.status(), StatusCode::NO_CONTENT);
    let quiet = tokio::time::timeout(Duration::from_millis(300), bob_stream.next()).await;
    assert!(quiet.is_err(), "expired grantee was poked");
}

#[tokio::test]
async fn blob_write_does_not_poke_an_unrelated_identity() {
    let app = router();
    let alice = Identity::from_seed(b"alice");
    let carol = Identity::from_seed(b"carol"); // no grant from Alice

    let mut carol_stream = open_events(&app, &carol).await;
    let put = app
        .clone()
        .oneshot(signed(&alice, "PUT", "/v0/blobs/ev-3", b"sealed", now()))
        .await
        .unwrap();
    assert_eq!(put.status(), StatusCode::NO_CONTENT);

    // Carol shares nothing with Alice, so her stream stays silent (only the
    // far-off heartbeat would ever arrive). A timeout here is the pass.
    let quiet = tokio::time::timeout(Duration::from_millis(300), carol_stream.next()).await;
    assert!(quiet.is_err(), "unrelated identity was poked");
}
