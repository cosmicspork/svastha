//! Integration tests for auth replay hardening: a state-changing request whose
//! signature was seen once within the freshness window is rejected on re-use,
//! while idempotent reads are deliberately exempt. Same in-process harness as
//! `blobs.rs`. Because the signed preimage binds method, path, body, and
//! timestamp, re-sending a request with the *same* timestamp reproduces the
//! exact signature a network attacker would capture and replay.

use axum::http::StatusCode;
use svastha_core::keys::Identity;
use tower::ServiceExt;

mod common;
use common::{now, router, signed};

fn hex_pk(id: &Identity) -> String {
    hex::encode(id.verifying_key().to_bytes())
}

#[tokio::test]
async fn identical_put_is_rejected_as_a_replay() {
    let app = router();
    let alice = Identity::from_seed(b"alice");
    let ts = now();

    // A PUT is idempotent at the store, so the effect of a replay would be
    // harmless — but the relay refuses to even re-accept the captured bytes.
    let first = app
        .clone()
        .oneshot(signed(&alice, "PUT", "/v0/blobs/rec1", b"sealed", ts))
        .await
        .unwrap();
    assert_eq!(first.status(), StatusCode::NO_CONTENT);

    // Byte-for-byte the same signed request (same timestamp → same signature).
    let replay = app
        .clone()
        .oneshot(signed(&alice, "PUT", "/v0/blobs/rec1", b"sealed", ts))
        .await
        .unwrap();
    assert_eq!(replay.status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn identical_delete_is_rejected_as_a_replay() {
    let app = router();
    let alice = Identity::from_seed(b"alice");
    let bob = Identity::from_seed(b"bob");
    let ts = now();
    let path = format!("/v0/grants/{}", hex_pk(&bob));

    let first = app
        .clone()
        .oneshot(signed(&alice, "PUT", &path, b"", ts))
        .await
        .unwrap();
    assert_eq!(first.status(), StatusCode::NO_CONTENT);

    let del = app
        .clone()
        .oneshot(signed(&alice, "DELETE", &path, b"", ts))
        .await
        .unwrap();
    assert_eq!(del.status(), StatusCode::NO_CONTENT);

    // Same DELETE again with the same timestamp: a replay, not a fresh revoke.
    let replay = app
        .clone()
        .oneshot(signed(&alice, "DELETE", &path, b"", ts))
        .await
        .unwrap();
    assert_eq!(replay.status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn a_repeated_get_is_not_a_replay() {
    // Idempotent reads are exempt from the guard: a client may legitimately
    // repeat a listing within one second (the timestamp's granularity), and a
    // replayed read reveals nothing the caller doesn't already hold. The same
    // signed GET twice must both succeed.
    let app = router();
    let alice = Identity::from_seed(b"alice");
    let ts = now();

    let first = app
        .clone()
        .oneshot(signed(&alice, "GET", "/v0/blobs", b"", ts))
        .await
        .unwrap();
    assert_eq!(first.status(), StatusCode::OK);

    let repeat = app
        .clone()
        .oneshot(signed(&alice, "GET", "/v0/blobs", b"", ts))
        .await
        .unwrap();
    assert_eq!(repeat.status(), StatusCode::OK);
}

#[tokio::test]
async fn a_fresh_write_after_one_is_accepted() {
    // The guard rejects only re-use, never a distinct request. A real client
    // re-signs each attempt with the current time, so a genuine retry differs
    // in its timestamp (and thus signature) and sails through.
    let app = router();
    let alice = Identity::from_seed(b"alice");
    let ts = now();

    let first = app
        .clone()
        .oneshot(signed(&alice, "PUT", "/v0/blobs/rec1", b"sealed", ts))
        .await
        .unwrap();
    assert_eq!(first.status(), StatusCode::NO_CONTENT);

    let fresh = app
        .clone()
        .oneshot(signed(&alice, "PUT", "/v0/blobs/rec1", b"sealed", ts + 1))
        .await
        .unwrap();
    assert_eq!(fresh.status(), StatusCode::NO_CONTENT);
}

#[tokio::test]
async fn one_identitys_write_does_not_block_another() {
    // Signatures are per-identity by construction, so Bob's write is never
    // mistaken for a replay of Alice's even at the same timestamp and path.
    let app = router();
    let alice = Identity::from_seed(b"alice");
    let bob = Identity::from_seed(b"bob");
    let ts = now();

    let a = app
        .clone()
        .oneshot(signed(&alice, "PUT", "/v0/blobs/rec1", b"a", ts))
        .await
        .unwrap();
    assert_eq!(a.status(), StatusCode::NO_CONTENT);

    let b = app
        .clone()
        .oneshot(signed(&bob, "PUT", "/v0/blobs/rec1", b"b", ts))
        .await
        .unwrap();
    assert_eq!(b.status(), StatusCode::NO_CONTENT);
}
