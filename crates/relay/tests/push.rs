//! Integration tests for the relay's Web Push transport (`/v0/push*` and the
//! poke-bus fan-out). Same in-process `tower::oneshot` harness as the other
//! relay tests, plus a tiny in-process mock **push service** the subscription
//! endpoints point at, so the fan-out can make a real (encrypted, VAPID-signed)
//! Web Push request and we can assert what the push service would have seen.
//!
//! The VAPID keypair and the subscription (recipient) keys below are throwaway
//! P-256 keys generated for these tests — never a real deployment's keys — so the
//! encryption and VAPID-signing paths execute end to end against the mock.

use std::net::SocketAddr;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

use axum::extract::State;
use axum::http::StatusCode;
use axum::routing::post;
use axum::Router;
use serde_json::json;
use svastha_core::keys::Identity;
use svastha_relay::app;
use svastha_relay::grants::MemoryGrantStore;
use svastha_relay::mailbox::MemoryMailboxStore;
use svastha_relay::push::{subscription_key, MemoryPushStore, PushService, PushStore, Vapid};
use svastha_relay::share::MemoryShareStore;
use svastha_relay::store::MemoryStore;
use tokio::sync::mpsc;
use tower::ServiceExt;

mod common;
use common::{now, signed, SKEW};

// Throwaway VAPID keypair (base64url), and a throwaway subscription recipient
// keypair — both valid P-256 so the crypto actually runs. Not any real keys.
const VAPID_PRIVATE: &str = "sjv4NeMvW29SzUoKdsGBe-6WtsEbWdVUT5J3FYeMldE";
const VAPID_PUBLIC: &str =
    "BJhLUo4OAO7Y7Px936fiImMVaijiJesff_zSPNGxmMRc5agit7K8Zruu6yMV8R9CUXlW4go1Jc4Uo6xdLT4X9sA";
const P256DH: &str =
    "BAdliBhmaa-YV6rf7mVteItCQi3959IR_vBZehafaUK-tTEdcTXVLq46D7LE_JTOr0_TwB8iWEUJcpXQTkND0I4";
const AUTH: &str = "Pv7LHGsXde6X2LKoAVe4yw";

fn hex_pk(id: &Identity) -> String {
    hex::encode(id.verifying_key().to_bytes())
}

fn pk_bytes(id: &Identity) -> [u8; 32] {
    id.verifying_key().to_bytes()
}

/// Build a router with Web Push enabled over a caller-held [`MemoryPushStore`] so
/// a test can inspect the store directly (e.g. to assert pruning).
fn push_app(store: Arc<MemoryPushStore>) -> Router {
    let vapid = Vapid {
        subject: "mailto:ops@example.test".to_string(),
        public_key: VAPID_PUBLIC.to_string(),
        private_key: VAPID_PRIVATE.to_string(),
    };
    app(
        Arc::new(MemoryStore::new()),
        Arc::new(MemoryGrantStore::new()),
        Arc::new(MemoryMailboxStore::new()),
        Arc::new(MemoryShareStore::new()),
        SKEW,
        None,
        Some(Arc::new(PushService::new(vapid, store.clone()))),
    )
}

/// The subscription JSON a browser produces, pointed at `endpoint`.
fn subscription_body(endpoint: &str) -> Vec<u8> {
    serde_json::to_vec(&json!({
        "endpoint": endpoint,
        "keys": { "p256dh": P256DH, "auth": AUTH },
    }))
    .unwrap()
}

/// Register a subscription for `signer` pointed at `endpoint`; assert `204`. The
/// timestamp is explicit so a test re-registering the same endpoint varies it and
/// the two requests don't collide as replays (identical body + second → identical
/// signature, which the auth nonce guard rejects).
async fn register_at(app: &Router, signer: &Identity, endpoint: &str, ts: u64) {
    let body = subscription_body(endpoint);
    let resp = app
        .clone()
        .oneshot(signed(signer, "PUT", "/v0/push", &body, ts))
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::NO_CONTENT);
}

/// Register at the current time — for tests that register an endpoint only once.
async fn register(app: &Router, signer: &Identity, endpoint: &str) {
    register_at(app, signer, endpoint, now()).await;
}

// --- in-process mock push service ---

struct MockState {
    hits: AtomicUsize,
    status: StatusCode,
    tx: mpsc::UnboundedSender<()>,
}

async fn mock_handler(State(m): State<Arc<MockState>>) -> StatusCode {
    m.hits.fetch_add(1, Ordering::SeqCst);
    let _ = m.tx.send(());
    m.status
}

struct Mock {
    addr: SocketAddr,
    state: Arc<MockState>,
    rx: mpsc::UnboundedReceiver<()>,
}

impl Mock {
    /// A push endpoint URL (per device) served by this mock.
    fn endpoint(&self, id: &str) -> String {
        format!("http://{}/push/{id}", self.addr)
    }
    fn hits(&self) -> usize {
        self.state.hits.load(Ordering::SeqCst)
    }
    /// Wait for the next push to arrive, or fail if none does promptly.
    async fn wait_hit(&mut self) {
        tokio::time::timeout(Duration::from_secs(5), self.rx.recv())
            .await
            .expect("a push should reach the mock within the timeout")
            .expect("the mock channel should stay open");
    }
}

/// Start a mock push service that answers every push with `status`.
async fn start_mock(status: StatusCode) -> Mock {
    let (tx, rx) = mpsc::unbounded_channel();
    let state = Arc::new(MockState {
        hits: AtomicUsize::new(0),
        status,
        tx,
    });
    let router = Router::new()
        .route("/push/{id}", post(mock_handler))
        .with_state(state.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        axum::serve(listener, router).await.unwrap();
    });
    Mock { addr, state, rx }
}

/// Bob deposits a mailbox item for `recipient`, which pokes the recipient (and so
/// fans out to Web Push).
async fn deposit(app: &Router, depositor: &Identity, recipient: &Identity, item: &str, ts: u64) {
    let path = format!("/v0/mailbox/{}/{item}", hex_pk(recipient));
    let resp = app
        .clone()
        .oneshot(signed(depositor, "PUT", &path, b"envelope", ts))
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::NO_CONTENT);
}

// --- CRUD ---

#[tokio::test]
async fn subscription_crud_round_trip() {
    let store = Arc::new(MemoryPushStore::new());
    let app = push_app(store.clone());
    let alice = Identity::from_seed(b"alice");
    let e1 = "https://push.example/device-1";
    let e2 = "https://push.example/device-2";

    let base = now();
    register_at(&app, &alice, e1, base).await;
    register_at(&app, &alice, e2, base + 1).await;
    assert_eq!(store.list(&pk_bytes(&alice)).unwrap().len(), 2);

    // Re-registering the same device replaces rather than duplicates (a later
    // timestamp so it isn't seen as a replay of the first registration).
    register_at(&app, &alice, e1, base + 2).await;
    assert_eq!(store.list(&pk_bytes(&alice)).unwrap().len(), 2);

    // DELETE naming one endpoint removes just that device.
    let del_one = serde_json::to_vec(&json!({ "endpoint": e1 })).unwrap();
    let resp = app
        .clone()
        .oneshot(signed(&alice, "DELETE", "/v0/push", &del_one, now()))
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::NO_CONTENT);
    let left = store.list(&pk_bytes(&alice)).unwrap();
    assert_eq!(left.len(), 1);
    assert_eq!(left[0].0, subscription_key(e2));

    // Empty-body DELETE clears everything for the identity.
    let resp = app
        .clone()
        .oneshot(signed(&alice, "DELETE", "/v0/push", b"", now()))
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::NO_CONTENT);
    assert!(store.list(&pk_bytes(&alice)).unwrap().is_empty());
}

#[tokio::test]
async fn malformed_subscription_is_rejected() {
    let store = Arc::new(MemoryPushStore::new());
    let app = push_app(store.clone());
    let alice = Identity::from_seed(b"alice");

    // Not a subscription object at all.
    let resp = app
        .clone()
        .oneshot(signed(&alice, "PUT", "/v0/push", b"not json", now()))
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::BAD_REQUEST);

    // Missing keys.
    let bad = serde_json::to_vec(&json!({ "endpoint": "https://x/1" })).unwrap();
    let resp = app
        .clone()
        .oneshot(signed(&alice, "PUT", "/v0/push", &bad, now()))
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
    assert!(store.list(&pk_bytes(&alice)).unwrap().is_empty());
}

#[tokio::test]
async fn vapid_key_is_exposed() {
    let store = Arc::new(MemoryPushStore::new());
    let app = push_app(store);
    let alice = Identity::from_seed(b"alice");

    let resp = app
        .clone()
        .oneshot(signed(&alice, "GET", "/v0/push/key", b"", now()))
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let body = common::body_bytes(resp).await;
    let v: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(v["vapid_public_key"], VAPID_PUBLIC);
}

#[tokio::test]
async fn push_endpoints_require_auth() {
    let store = Arc::new(MemoryPushStore::new());
    let app = push_app(store);

    for (method, path) in [
        ("PUT", "/v0/push"),
        ("DELETE", "/v0/push"),
        ("GET", "/v0/push/key"),
    ] {
        let resp = app
            .clone()
            .oneshot(
                axum::http::Request::builder()
                    .method(method)
                    .uri(path)
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(
            resp.status(),
            StatusCode::UNAUTHORIZED,
            "{method} {path} should require auth"
        );
    }
}

// --- fan-out ---

#[tokio::test]
async fn deposit_fans_out_to_web_push() {
    let mut mock = start_mock(StatusCode::CREATED).await;
    let store = Arc::new(MemoryPushStore::new());
    let app = push_app(store.clone());
    let alice = Identity::from_seed(b"alice");
    let bob = Identity::from_seed(b"bob");

    register(&app, &alice, &mock.endpoint("dev-1")).await;

    // Bob deposits for Alice → Alice is poked → Web Push reaches the mock.
    deposit(&app, &bob, &alice, "item-1", now()).await;
    mock.wait_hit().await;
    assert_eq!(mock.hits(), 1);
}

#[tokio::test]
async fn a_burst_collapses_to_one_push() {
    let mut mock = start_mock(StatusCode::CREATED).await;
    let store = Arc::new(MemoryPushStore::new());
    let app = push_app(store.clone());
    let alice = Identity::from_seed(b"alice");
    let bob = Identity::from_seed(b"bob");

    register(&app, &alice, &mock.endpoint("dev-1")).await;

    // A burst of deposits in quick succession — the collapse window folds them
    // into a single push, not one per deposit.
    let base = now();
    for i in 0..5 {
        deposit(&app, &bob, &alice, &format!("item-{i}"), base + i).await;
    }
    mock.wait_hit().await;
    // Give any (erroneously) un-collapsed sends time to also land.
    tokio::time::sleep(Duration::from_millis(400)).await;
    assert_eq!(mock.hits(), 1, "the burst should collapse to one push");
}

#[tokio::test]
async fn a_live_sse_stream_suppresses_push() {
    // A foregrounded client (a live SSE stream) already got the real-time poke;
    // the relay must not also send it a redundant lock-screen push.
    let mock = start_mock(StatusCode::CREATED).await;
    let store = Arc::new(MemoryPushStore::new());
    let app = push_app(store.clone());
    let alice = Identity::from_seed(b"alice");
    let bob = Identity::from_seed(b"bob");

    register(&app, &alice, &mock.endpoint("dev-1")).await;

    // Alice opens a live SSE stream, then Bob deposits for her.
    let sse = app
        .clone()
        .oneshot(signed(&alice, "GET", "/v0/events", b"", now()))
        .await
        .unwrap();
    assert_eq!(sse.status(), StatusCode::OK);
    let _stream = sse.into_body().into_data_stream(); // hold it open

    deposit(&app, &bob, &alice, "item-1", now()).await;
    // No push should reach the mock while the stream is live.
    tokio::time::sleep(Duration::from_millis(500)).await;
    assert_eq!(mock.hits(), 0, "a foregrounded client should not be pushed");
}

#[tokio::test]
async fn gone_response_prunes_the_subscription() {
    // A push service that reports the endpoint gone (410) means the subscription
    // is dead; the relay prunes it so it stops trying.
    let mut mock = start_mock(StatusCode::GONE).await;
    let store = Arc::new(MemoryPushStore::new());
    let app = push_app(store.clone());
    let alice = Identity::from_seed(b"alice");
    let bob = Identity::from_seed(b"bob");

    register(&app, &alice, &mock.endpoint("dev-1")).await;
    assert_eq!(store.list(&pk_bytes(&alice)).unwrap().len(), 1);

    deposit(&app, &bob, &alice, "item-1", now()).await;
    mock.wait_hit().await;

    // The prune happens right after the send returns; poll briefly for it.
    let mut pruned = false;
    for _ in 0..50 {
        if store.list(&pk_bytes(&alice)).unwrap().is_empty() {
            pruned = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert!(pruned, "a 410 Gone response should prune the subscription");
}

// --- feature-off ---

#[tokio::test]
async fn push_disabled_returns_503_but_leaves_everything_else_working() {
    // No VAPID key: the router() harness builds an app with push = None.
    let app = common::router();
    let alice = Identity::from_seed(b"alice");

    // Push endpoints answer 503 (feature off), never 500 or a panic.
    let sub = subscription_body("https://push.example/x");
    let put = app
        .clone()
        .oneshot(signed(&alice, "PUT", "/v0/push", &sub, now()))
        .await
        .unwrap();
    assert_eq!(put.status(), StatusCode::SERVICE_UNAVAILABLE);

    let key = app
        .clone()
        .oneshot(signed(&alice, "GET", "/v0/push/key", b"", now()))
        .await
        .unwrap();
    assert_eq!(key.status(), StatusCode::SERVICE_UNAVAILABLE);

    // Everything else still works: a blob write and a mailbox deposit succeed,
    // and the SSE poke channel still delivers — push being off changes nothing.
    let blob = app
        .clone()
        .oneshot(signed(&alice, "PUT", "/v0/blobs/ev-1", b"sealed", now()))
        .await
        .unwrap();
    assert_eq!(blob.status(), StatusCode::NO_CONTENT);

    let bob = Identity::from_seed(b"bob");
    deposit(&app, &bob, &alice, "item-1", now()).await;
}
