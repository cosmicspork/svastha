//! Integration tests for the OCR → proposals pipeline (D2) against the **real
//! relay crate** in-process, plus a **mock OpenAI-compatible inference server**
//! (also in-process on an ephemeral port). The owner side stands in for the PWA:
//! it seeds a vault with captured pages, grants the node, and deposits a
//! `key_handoff`; the node then enrols, syncs, and OCRs — and the owner reads the
//! deposited `proposal` envelopes back and asserts they match the spec body
//! schema (i.e. C2's inbox could parse them).

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::mpsc;
use std::sync::Arc;
use std::sync::Mutex;

use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use sha2::{Digest, Sha256};
use svastha_core::envelope::DataKey;
use svastha_core::keyring::Keyring;
use svastha_core::keys::Identity;
use svastha_core::mailbox::{
    parse_mailbox_item, KeyHandoffBody, MailboxItem, MailboxMessage, MessageKind, ProposalBody,
    ProposalResultBody,
};

use svastha_node::cache::Cache;
use svastha_node::client::RelayClient;
use svastha_node::config::InferenceConfig;
use svastha_node::inference::InferenceClient;
use svastha_node::journal::Journal;
use svastha_node::state::NodeState;
use svastha_node::sync::{consume_mailbox, sync_all};

use svastha_relay::grants::MemoryGrantStore;
use svastha_relay::mailbox::MemoryMailboxStore;
use svastha_relay::share::MemoryShareStore;
use svastha_relay::store::MemoryStore;

// ---- in-process relay (same pattern as tests/substrate.rs) ----

fn spawn_relay() -> String {
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let rt = tokio::runtime::Runtime::new().expect("build tokio runtime");
        rt.block_on(async move {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
                .await
                .expect("bind ephemeral port");
            tx.send(listener.local_addr().expect("local_addr"))
                .expect("send bound addr");
            let app = svastha_relay::app(
                Arc::new(MemoryStore::new()),
                Arc::new(MemoryGrantStore::new()),
                Arc::new(MemoryMailboxStore::new()),
                Arc::new(MemoryShareStore::new()),
                300,
                None,
            );
            axum::serve(listener, app).await.expect("serve relay");
        });
    });
    let addr = rx.recv().expect("relay thread failed to start");
    format!("http://{addr}")
}

// ---- mock OpenAI-compatible inference server ----

/// How the mock answers a chat-completions request.
#[derive(Clone)]
enum Mode {
    /// Return this string as the assistant message content.
    Ok(String),
    /// Return a valid completion whose content is not JSON.
    Malformed,
    /// Return HTTP 500.
    Error,
    /// Fail the first request (500), then answer with the string.
    FailFirstThenOk(String),
}

#[derive(Clone)]
struct MockState {
    mode: Mode,
    calls: Arc<AtomicUsize>,
}

/// Spawn the mock on an ephemeral port; return its base URL (`.../v1`).
fn spawn_inference(mode: Mode) -> (String, Arc<AtomicUsize>) {
    use axum::extract::State;
    use axum::http::StatusCode;
    use axum::routing::post;
    use axum::Json;
    use axum::Router;

    let calls = Arc::new(AtomicUsize::new(0));
    let state = MockState {
        mode,
        calls: calls.clone(),
    };
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let rt = tokio::runtime::Runtime::new().expect("build tokio runtime");
        rt.block_on(async move {
            async fn handler(
                State(state): State<MockState>,
                _body: axum::body::Bytes,
            ) -> (StatusCode, Json<serde_json::Value>) {
                let n = state.calls.fetch_add(1, Ordering::SeqCst);
                let content = match &state.mode {
                    Mode::Ok(s) => s.clone(),
                    Mode::Malformed => "I could not read this image.".to_string(),
                    Mode::Error => {
                        return (
                            StatusCode::INTERNAL_SERVER_ERROR,
                            Json(serde_json::json!({})),
                        )
                    }
                    Mode::FailFirstThenOk(s) => {
                        if n == 0 {
                            return (
                                StatusCode::INTERNAL_SERVER_ERROR,
                                Json(serde_json::json!({})),
                            );
                        }
                        s.clone()
                    }
                };
                (
                    StatusCode::OK,
                    Json(serde_json::json!({
                        "choices": [ { "message": { "role": "assistant", "content": content } } ]
                    })),
                )
            }
            let app = Router::new()
                .route("/v1/chat/completions", post(handler))
                .with_state(state);
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
                .await
                .expect("bind ephemeral port");
            tx.send(listener.local_addr().expect("local_addr"))
                .expect("send bound addr");
            axum::serve(listener, app).await.expect("serve mock");
        });
    });
    let addr = rx.recv().expect("mock thread failed to start");
    (format!("http://{addr}/v1"), calls)
}

fn inference_client(base: &str) -> InferenceClient {
    InferenceClient::new(&InferenceConfig {
        endpoint: base.to_string(),
        api_key: None,
        model: "vision-test".to_string(),
    })
}

/// A findings answer the mock returns as the model's content.
fn one_bp_finding() -> String {
    r#"{"findings":[
        {"kind":"observation","system":"loinc","code":"8480-6",
         "display":"Systolic blood pressure","value_quantity":"120","unit":"mm[Hg]",
         "effective_at":"2026-03-03","confidence":0.92}
    ]}"#
    .to_string()
}

// ---- owner-side helpers (the PWA's role) ----

fn hex_ed(id: &Identity) -> String {
    hex::encode(id.verifying_key().to_bytes())
}

fn put_attachment(client: &RelayClient, ring: &Keyring, owner: &Identity, raw: &[u8]) -> String {
    let sha = hex::encode(Sha256::digest(raw));
    let blob_id = format!("att-{sha}");
    let body = serde_json::json!({ "mime": "image/jpeg", "bytes": BASE64.encode(raw) });
    let sealed = ring
        .seal_blob(
            owner,
            blob_id.as_bytes(),
            &serde_json::to_vec(&body).unwrap(),
        )
        .unwrap();
    client.put_blob(&blob_id, &sealed).unwrap();
    sha
}

fn grant_node(owner_client: &RelayClient, node: &Identity) {
    let scope = br#"{"prefixes":["ev-","att-","doc-","cur-"]}"#;
    owner_client.put_grant(&hex_ed(node), Some(scope)).unwrap();
}

fn deposit_handoff(owner_client: &RelayClient, owner: &Identity, node: &Identity, ring: &Keyring) {
    let for_node = ring.wrap_for_grantee(owner, &node.x25519_public()).unwrap();
    let body = KeyHandoffBody {
        from_ed: hex_ed(owner),
        from_x25519: hex::encode(owner.x25519_public().as_bytes()),
        label: "test owner".into(),
        wrapped_hex: hex::encode(for_node.to_bytes()),
    };
    let envelope = MailboxMessage::seal(
        owner,
        &node.x25519_public(),
        MessageKind::KeyHandoff,
        1_753_000_000_000,
        &serde_json::to_vec(&body).unwrap(),
    );
    owner_client
        .put_mailbox(
            &hex_ed(node),
            "kh-1",
            &serde_json::to_vec(&envelope).unwrap(),
        )
        .unwrap();
}

/// The owner reads its mailbox and returns every verified, opened `proposal`
/// body (as C2's inbox would). Panics if any envelope fails to verify or open —
/// that is the "C2 could parse it" assertion.
fn read_proposals(owner_client: &RelayClient, owner: &Identity) -> Vec<(String, ProposalBody)> {
    let mut out = Vec::new();
    for entry in owner_client.list_mailbox().unwrap() {
        let (bytes, from) = owner_client.get_mailbox(&entry.id).unwrap().unwrap();
        let MailboxItem::Message(msg) = parse_mailbox_item(&bytes).unwrap() else {
            continue;
        };
        if msg.kind != MessageKind::Proposal {
            continue;
        }
        assert!(msg.verify(), "deposited proposal must verify");
        assert_eq!(
            msg.from_hex(),
            from,
            "envelope from must match relay attest"
        );
        let plain = msg.open(owner).expect("owner opens proposal sealed to it");
        let body: ProposalBody =
            serde_json::from_slice(&plain).expect("proposal body matches the spec schema");
        out.push((msg.id_hex(), body));
    }
    out
}

/// Full owner-side setup: seal a vault with `images`, grant + hand off to the
/// node. Returns `(node RelayClient, owner RelayClient, node identity, owner
/// identity)` plus the node's fresh state/cache/journal for the pipeline.
struct Fixture {
    node_client: RelayClient,
    owner_client: RelayClient,
    owner: Identity,
    node: Identity,
    state: Mutex<NodeState>,
    cache: Cache,
    journal_dir: tempfile::TempDir,
}

fn setup(seed: &[u8], images: &[&[u8]]) -> Fixture {
    let base = spawn_relay();
    let owner = Identity::from_seed(seed);
    let mut node_seed = seed.to_vec();
    node_seed.extend_from_slice(b"-node");
    let node = Identity::from_seed(&node_seed);
    let owner_client = RelayClient::new(base.clone(), Arc::new(Identity::from_seed(seed)));
    let node_client = RelayClient::new(base.clone(), Arc::new(Identity::from_seed(&node_seed)));

    let data_key = DataKey::generate();
    let ring = Keyring::genesis(&owner.x25519_public(), &data_key);
    for img in images {
        put_attachment(&owner_client, &ring, &owner, img);
    }
    grant_node(&owner_client, &node);
    deposit_handoff(&owner_client, &owner, &node, &ring);

    let state = Mutex::new(NodeState::new());
    let cache = Cache::new(tempfile::tempdir().unwrap().path().to_path_buf());
    // Enrol and sync so att- bytes land in the cache and the index.
    consume_mailbox(&node_client, &state).unwrap();
    sync_all(&node_client, &cache, &state).unwrap();

    Fixture {
        node_client,
        owner_client,
        owner,
        node,
        state,
        cache,
        journal_dir: tempfile::tempdir().unwrap(),
    }
}

// ---- tests ----

#[test]
fn ocr_happy_path_deposits_a_parseable_proposal() {
    let (base, calls) = spawn_inference(Mode::Ok(one_bp_finding()));
    let inf = inference_client(&base);
    let fx = setup(b"ocr owner one", &[b"page one bytes"]);
    let mut journal = Journal::load(fx.journal_dir.path());

    let report =
        svastha_node::ocr::run(&fx.node_client, &fx.cache, &fx.state, &inf, &mut journal).unwrap();
    assert_eq!(report.proposals, 1, "one page → one proposal");
    assert_eq!(report.failed, 0);
    assert_eq!(calls.load(Ordering::SeqCst), 1, "one inference call");

    // The owner (PWA) reads the proposal back and it parses as a valid draft.
    let proposals = read_proposals(&fx.owner_client, &fx.owner);
    assert_eq!(proposals.len(), 1);
    let (msg_id, body) = &proposals[0];
    assert_eq!(body.proposals.len(), 1);
    let draft = &body.proposals[0];
    // Provenance the owner's signature will later cover via `proposed`.
    assert_eq!(draft.method.as_deref(), Some("ocr"));
    assert_eq!(draft.model.as_deref(), Some("vision-test"));
    assert!(draft.source_blob.as_deref().unwrap().starts_with("att-"));
    // The draft event is unsigned, schema-valid, and coded on the import URI.
    assert!(
        draft.event.proposed.is_none(),
        "draft is unsigned/unstamped"
    );
    let code = draft.event.code.as_ref().expect("coded");
    assert_eq!(code.system, "http://loinc.org");
    assert_eq!(code.code, "8480-6");
    assert!(!msg_id.is_empty());

    // Job status reflects the pass.
    let jobs = fx.state.lock().unwrap().job_status();
    assert_eq!(jobs.processed, 1);
    assert_eq!(jobs.failed, 0);
    assert_eq!(jobs.queued, 0);
}

#[test]
fn malformed_inference_output_proposes_nothing() {
    let (base, _calls) = spawn_inference(Mode::Malformed);
    let inf = inference_client(&base);
    let fx = setup(b"ocr owner two", &[b"unreadable page"]);
    let mut journal = Journal::load(fx.journal_dir.path());

    let report =
        svastha_node::ocr::run(&fx.node_client, &fx.cache, &fx.state, &inf, &mut journal).unwrap();
    assert_eq!(report.proposals, 0, "garbage output → no proposal");
    assert_eq!(report.empties, 1, "recorded processed-empty, not proposed");
    assert!(read_proposals(&fx.owner_client, &fx.owner).is_empty());

    // Re-running does not re-process an empty (terminal) source.
    let report2 =
        svastha_node::ocr::run(&fx.node_client, &fx.cache, &fx.state, &inf, &mut journal).unwrap();
    assert_eq!(report2.empties, 0, "empty source is terminal");
}

#[test]
fn idempotent_across_a_simulated_restart() {
    let (base, calls) = spawn_inference(Mode::Ok(one_bp_finding()));
    let inf = inference_client(&base);
    let fx = setup(b"ocr owner three", &[b"page bytes"]);

    {
        let mut journal = Journal::load(fx.journal_dir.path());
        svastha_node::ocr::run(&fx.node_client, &fx.cache, &fx.state, &inf, &mut journal).unwrap();
    }
    assert_eq!(read_proposals(&fx.owner_client, &fx.owner).len(), 1);

    // Simulated restart: a fresh journal loaded from the same durable dir sees
    // the deposited source and does not re-propose.
    let mut journal = Journal::load(fx.journal_dir.path());
    let report =
        svastha_node::ocr::run(&fx.node_client, &fx.cache, &fx.state, &inf, &mut journal).unwrap();
    assert_eq!(report.proposals, 0, "restart must not re-deposit");
    assert_eq!(
        read_proposals(&fx.owner_client, &fx.owner).len(),
        1,
        "still exactly one proposal in the owner's mailbox"
    );
    assert_eq!(calls.load(Ordering::SeqCst), 1, "no second inference call");
}

#[test]
fn resolved_source_is_never_reproposed() {
    let (base, _calls) = spawn_inference(Mode::Ok(one_bp_finding()));
    let inf = inference_client(&base);
    let fx = setup(b"ocr owner four", &[b"page bytes"]);
    let mut journal = Journal::load(fx.journal_dir.path());

    svastha_node::ocr::run(&fx.node_client, &fx.cache, &fx.state, &inf, &mut journal).unwrap();
    let proposals = read_proposals(&fx.owner_client, &fx.owner);
    let proposal_id = proposals[0].0.clone();

    // Owner rejects the proposal: deposits a proposal_result back to the node.
    let result = ProposalResultBody {
        proposal_id: proposal_id.clone(),
        accepted: vec![],
        rejected: vec![proposals[0].1.proposals[0].event.id.to_hex()],
    };
    let envelope = MailboxMessage::seal(
        &fx.owner,
        &fx.node.x25519_public(),
        MessageKind::ProposalResult,
        1_753_000_500_000,
        &serde_json::to_vec(&result).unwrap(),
    );
    fx.owner_client
        .put_mailbox(
            &hex_ed(&fx.node),
            "pr-1",
            &serde_json::to_vec(&envelope).unwrap(),
        )
        .unwrap();

    // Next pass folds the rejection in and re-proposes nothing.
    let report =
        svastha_node::ocr::run(&fx.node_client, &fx.cache, &fx.state, &inf, &mut journal).unwrap();
    assert_eq!(report.resolved, 1, "the rejection resolved the source");
    assert_eq!(
        report.proposals, 0,
        "rejected means rejected — no re-propose"
    );
    assert_eq!(read_proposals(&fx.owner_client, &fx.owner).len(), 1);
}

#[test]
fn inference_error_backs_the_page_off() {
    let (base, _calls) = spawn_inference(Mode::Error);
    let inf = inference_client(&base);
    let fx = setup(b"ocr owner six", &[b"page bytes"]);
    let mut journal = Journal::load(fx.journal_dir.path());

    let report =
        svastha_node::ocr::run(&fx.node_client, &fx.cache, &fx.state, &inf, &mut journal).unwrap();
    assert_eq!(report.failed, 1);
    assert_eq!(report.proposals, 0);
    assert!(read_proposals(&fx.owner_client, &fx.owner).is_empty());
    assert_eq!(
        fx.state.lock().unwrap().job_status().queued,
        1,
        "awaiting retry"
    );
}

#[test]
fn a_failing_page_backs_off_without_wedging_the_queue() {
    // First inference call 500s, the rest succeed: with two pages, the first
    // processed fails and backs off while the second still gets proposed.
    let (base, _calls) = spawn_inference(Mode::FailFirstThenOk(one_bp_finding()));
    let inf = inference_client(&base);
    let fx = setup(b"ocr owner five", &[b"page A bytes", b"page B bytes"]);
    let mut journal = Journal::load(fx.journal_dir.path());

    let report =
        svastha_node::ocr::run(&fx.node_client, &fx.cache, &fx.state, &inf, &mut journal).unwrap();
    assert_eq!(report.failed, 1, "the failing page is counted, not fatal");
    assert_eq!(report.proposals, 1, "the other page is not wedged");
    assert_eq!(read_proposals(&fx.owner_client, &fx.owner).len(), 1);

    // The failed page is awaiting retry (the queued gauge), and within its
    // back-off a re-run does not retry it (and does not re-propose the other).
    let jobs = fx.state.lock().unwrap().job_status();
    assert_eq!(jobs.queued, 1, "one page awaiting retry");
    assert_eq!(jobs.failed, 1);

    let report2 =
        svastha_node::ocr::run(&fx.node_client, &fx.cache, &fx.state, &inf, &mut journal).unwrap();
    assert_eq!(report2.proposals, 0, "deposited page not re-proposed");
    assert_eq!(
        report2.failed, 0,
        "failed page still backing off, not retried"
    );
}
