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
use svastha_node::ocr_control::{OcrControl, OcrSettings, DEFAULT_MAX_PAGES_PER_PASS};
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
        model: "coding-test".to_string(),
    })
}

/// A findings answer the mock returns as the model's content.
fn one_bp_finding() -> String {
    r#"{"findings":[
        {"kind":"observation","source_line":2,"system":"loinc","code":"8480-6",
         "display":"Systolic blood pressure","value_quantity":"120","unit":"mm[Hg]",
         "effective_at":"2026-03-03","confidence":0.92}
    ]}"#
    .to_string()
}

/// The same answer plus a second finding that cites line 1 — the letterhead —
/// for a reading that is not on it. The guard must drop the second and keep the
/// first.
fn one_good_and_one_cross_row_finding() -> String {
    r#"{"findings":[
        {"kind":"observation","source_line":2,"system":"loinc","code":"8480-6",
         "display":"Systolic blood pressure","value_quantity":"120","unit":"mm[Hg]"},
        {"kind":"observation","source_line":1,"system":"loinc","code":"8462-4",
         "display":"Diastolic blood pressure","value_quantity":"80"}
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
            // Keyed by owner: two owners enrolling with one node must not
            // overwrite each other's handoff.
            &format!("kh-{}", hex_ed(owner)),
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

/// Full owner-side setup: seals a vault with `images`, grants the node, and
/// hands off keys. Bundles the resulting relay clients and identities with the
/// node's fresh state/cache/journal for the pipeline.
struct Fixture {
    node_client: RelayClient,
    owner_client: RelayClient,
    owner: Identity,
    node: Identity,
    state: Mutex<NodeState>,
    cache: Cache,
    journal_dir: tempfile::TempDir,
    /// The `att-` source ids of the seeded pages, in order, so a test can ask
    /// the journal directly whether a page is still eligible.
    sources: Vec<String>,
}

fn setup(seed: &[u8], images: &[&[u8]]) -> Fixture {
    let base = spawn_relay();
    let mut node_seed = seed.to_vec();
    node_seed.extend_from_slice(b"-node");
    let node = Identity::from_seed(&node_seed);
    let node_client = RelayClient::new(base.clone(), Arc::new(Identity::from_seed(&node_seed)));

    let side = seed_owner(&base, &node, seed, images);

    let state = Mutex::new(NodeState::new());
    let cache = Cache::new(tempfile::tempdir().unwrap().path().to_path_buf());
    // Enrol and sync so att- bytes land in the cache and the index.
    consume_mailbox(&node_client, &state).unwrap();
    sync_all(&node_client, &cache, &state).unwrap();

    Fixture {
        node_client,
        owner_client: side.client,
        owner: side.id,
        node,
        state,
        cache,
        journal_dir: tempfile::tempdir().unwrap(),
        sources: side.sources,
    }
}

/// One enrolled owner: identity, relay client, and the `att-` ids of the pages
/// seeded into their vault.
struct OwnerSide {
    id: Identity,
    client: RelayClient,
    sources: Vec<String>,
}

/// Two owners enrolled with **one** node — the multi-tenant shape the node has
/// been built for since day one, and the only shape in which a per-owner gate
/// differs from a node-wide one.
struct PairFixture {
    node_client: RelayClient,
    state: Mutex<NodeState>,
    cache: Cache,
    journal_dir: tempfile::TempDir,
    a: OwnerSide,
    b: OwnerSide,
}

/// Seed one owner's vault with `images`, grant the node, and hand off the
/// keyring. The caller enrols and syncs afterwards.
fn seed_owner(base: &str, node: &Identity, seed: &[u8], images: &[&[u8]]) -> OwnerSide {
    let id = Identity::from_seed(seed);
    let client = RelayClient::new(base.to_string(), Arc::new(Identity::from_seed(seed)));
    let ring = Keyring::genesis(&id.x25519_public(), &DataKey::generate());
    let sources = images
        .iter()
        .map(|img| format!("att-{}", put_attachment(&client, &ring, &id, img)))
        .collect();
    grant_node(&client, node);
    deposit_handoff(&client, &id, node, &ring);
    OwnerSide {
        id,
        client,
        sources,
    }
}

fn setup_pair(seed_a: &[u8], images_a: &[&[u8]], seed_b: &[u8], images_b: &[&[u8]]) -> PairFixture {
    let base = spawn_relay();
    let mut node_seed = seed_a.to_vec();
    node_seed.extend_from_slice(b"-node");
    let node = Identity::from_seed(&node_seed);
    let node_client = RelayClient::new(base.clone(), Arc::new(Identity::from_seed(&node_seed)));

    let a = seed_owner(&base, &node, seed_a, images_a);
    let b = seed_owner(&base, &node, seed_b, images_b);

    let state = Mutex::new(NodeState::new());
    let cache = Cache::new(tempfile::tempdir().unwrap().path().to_path_buf());
    consume_mailbox(&node_client, &state).unwrap();
    sync_all(&node_client, &cache, &state).unwrap();
    assert_eq!(
        state.lock().unwrap().enrolled_count(),
        2,
        "both vaults enrolled"
    );

    PairFixture {
        node_client,
        state,
        cache,
        journal_dir: tempfile::tempdir().unwrap(),
        a,
        b,
    }
}

fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs() as i64
}

#[test]
fn ocr_happy_path_deposits_a_parseable_proposal() {
    let (base, calls) = spawn_inference(Mode::Ok(one_bp_finding()));
    let inf = inference_client(&base);
    let fx = setup(b"ocr owner one", &[b"page one bytes"]);
    let mut journal = Journal::load(fx.journal_dir.path());

    let report = svastha_node::ocr::run(
        &fx.node_client,
        &fx.cache,
        &fx.state,
        &inf,
        &StubReader::page(),
        &resumed(&fx.journal_dir),
        &mut journal,
    )
    .unwrap();
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
    assert_eq!(draft.model.as_deref(), Some("coding-test"));
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

    let jobs = fx.state.lock().unwrap().job_status();
    assert_eq!(jobs.processed, 1);
    assert_eq!(jobs.failed, 0);
    assert_eq!(jobs.queued, 0);
}

/// A reply the extractor cannot parse says nothing about the page — it is the
/// coding model failing to format an answer. Marking the page *empty* would be
/// terminal, so one formatting quirk would bury a readable page for the life of
/// the journal. It has to back off like any other transient failure.
#[test]
fn an_unparseable_reply_backs_off_rather_than_burying_the_page() {
    let (base, _calls) = spawn_inference(Mode::Malformed);
    let inf = inference_client(&base);
    let fx = setup(b"ocr owner two", &[b"unreadable page"]);
    let mut journal = Journal::load(fx.journal_dir.path());

    let report = svastha_node::ocr::run(
        &fx.node_client,
        &fx.cache,
        &fx.state,
        &inf,
        &StubReader::page(),
        &resumed(&fx.journal_dir),
        &mut journal,
    )
    .unwrap();
    assert_eq!(report.proposals, 0, "garbage output → no proposal");
    assert_eq!(report.failed, 1, "a failure, retryable");
    assert_eq!(
        report.empties, 0,
        "an unparseable reply is not a verdict that the page is blank"
    );
    assert!(read_proposals(&fx.owner_client, &fx.owner).is_empty());

    let owner_hex = hex_ed(&fx.owner);
    assert!(
        !journal.eligible(&owner_hex, &fx.sources[0], now_secs()),
        "backing off right now"
    );
    assert!(
        journal.eligible(&owner_hex, &fx.sources[0], now_secs() + 3600),
        "and eligible again once the back-off elapses — not terminal"
    );
}

/// The same failure wearing valid JSON: an object with no `findings` key at
/// all, or with the findings under some other name. That is the coding model
/// failing to answer in the schema, not a verdict that the page is blank, and
/// `mark_empty` would be terminal.
#[test]
fn a_reply_with_no_findings_key_backs_off_rather_than_burying_the_page() {
    for (seed, answer) in [
        (b"ocr owner no findings key".as_slice(), "{}"),
        (
            b"ocr owner wrong findings key".as_slice(),
            r#"{"result":[]}"#,
        ),
    ] {
        let (base, _calls) = spawn_inference(Mode::Ok(answer.to_string()));
        let inf = inference_client(&base);
        let fx = setup(seed, &[b"page bytes"]);
        let mut journal = Journal::load(fx.journal_dir.path());

        let report = svastha_node::ocr::run(
            &fx.node_client,
            &fx.cache,
            &fx.state,
            &inf,
            &StubReader::page(),
            &resumed(&fx.journal_dir),
            &mut journal,
        )
        .unwrap();
        assert_eq!(report.failed, 1, "reply was {answer}");
        assert_eq!(
            report.empties, 0,
            "an answer in the wrong shape says nothing about the page: {answer}"
        );
        assert!(
            journal.eligible(&hex_ed(&fx.owner), &fx.sources[0], now_secs() + 3600),
            "the page must still be readable next pass: {answer}"
        );
    }
}

/// The last way a page could still be buried: an answer that *offered* findings
/// and had none survive validation. No drafts, but the model did not report a
/// blank page — it produced claims that could not be read or could not be
/// verified, which says nothing about the page and everything about the answer.
#[test]
fn a_page_whose_findings_all_drop_backs_off_rather_than_burying_the_page() {
    let answer = r#"{"findings":[{"kind":"observation","source_line":1,
        "display":{"text":"Potassium"},"value_quantity":"4.1"}]}"#;
    let (base, _calls) = spawn_inference(Mode::Ok(answer.to_string()));
    let inf = inference_client(&base);
    let fx = setup(b"ocr owner all dropped", &[b"page bytes"]);
    let mut journal = Journal::load(fx.journal_dir.path());

    let report = svastha_node::ocr::run(
        &fx.node_client,
        &fx.cache,
        &fx.state,
        &inf,
        &StubReader::transcript(&["Potassium 4.1"]),
        &resumed(&fx.journal_dir),
        &mut journal,
    )
    .unwrap();
    assert_eq!(
        report.failed, 1,
        "offered findings, none usable — retryable"
    );
    assert_eq!(
        report.empties, 0,
        "a page whose findings all dropped is not a page with nothing on it"
    );
    assert_eq!(report.proposals, 0);
    assert_eq!(
        report.dropped_findings, 1,
        "the drop is still counted; the telemetry does not move"
    );
    assert!(read_proposals(&fx.owner_client, &fx.owner).is_empty());
    assert!(
        journal.eligible(&hex_ed(&fx.owner), &fx.sources[0], now_secs() + 3600),
        "a readable page must come back once the back-off elapses"
    );
}

/// The other half of the same branch: a model that *did* read the page and
/// found nothing on it is a conclusion about the page, and stays terminal.
#[test]
fn a_page_the_model_says_is_blank_stays_terminal() {
    let (base, _calls) = spawn_inference(Mode::Ok(r#"{"findings":[]}"#.to_string()));
    let inf = inference_client(&base);
    let fx = setup(b"ocr owner blank", &[b"blank page"]);
    let mut journal = Journal::load(fx.journal_dir.path());

    let report = svastha_node::ocr::run(
        &fx.node_client,
        &fx.cache,
        &fx.state,
        &inf,
        &StubReader::page(),
        &resumed(&fx.journal_dir),
        &mut journal,
    )
    .unwrap();
    assert_eq!(report.empties, 1, "recorded processed-empty, not proposed");
    assert_eq!(report.failed, 0);
    assert!(
        !journal.eligible(&hex_ed(&fx.owner), &fx.sources[0], now_secs() + 86_400),
        "empty is terminal"
    );
}

/// The source-line guard's rejection path, end to end through the node: a
/// finding that does not quote the line it cites is dropped and counted, and
/// only the verified one reaches the owner's mailbox.
#[test]
fn a_finding_that_does_not_quote_its_line_never_reaches_the_owner() {
    let (base, _calls) = spawn_inference(Mode::Ok(one_good_and_one_cross_row_finding()));
    let inf = inference_client(&base);
    let fx = setup(b"ocr owner guard", &[b"page bytes"]);
    let mut journal = Journal::load(fx.journal_dir.path());

    let report = svastha_node::ocr::run(
        &fx.node_client,
        &fx.cache,
        &fx.state,
        &inf,
        &StubReader::page(),
        &resumed(&fx.journal_dir),
        &mut journal,
    )
    .unwrap();
    assert_eq!(report.dropped_findings, 1, "the guard rejected one finding");
    assert_eq!(report.proposals, 1, "and the verified one still ships");

    let proposals = read_proposals(&fx.owner_client, &fx.owner);
    assert_eq!(proposals.len(), 1);
    let drafts = &proposals[0].1.proposals;
    assert_eq!(drafts.len(), 1, "only the verified finding was proposed");
    assert_eq!(drafts[0].event.code.as_ref().unwrap().code, "8480-6");
}

#[test]
fn idempotent_across_a_simulated_restart() {
    let (base, calls) = spawn_inference(Mode::Ok(one_bp_finding()));
    let inf = inference_client(&base);
    let fx = setup(b"ocr owner three", &[b"page bytes"]);

    {
        let mut journal = Journal::load(fx.journal_dir.path());
        svastha_node::ocr::run(
            &fx.node_client,
            &fx.cache,
            &fx.state,
            &inf,
            &StubReader::page(),
            &resumed(&fx.journal_dir),
            &mut journal,
        )
        .unwrap();
    }
    assert_eq!(read_proposals(&fx.owner_client, &fx.owner).len(), 1);

    // Simulated restart: a fresh journal loaded from the same durable dir sees
    // the deposited source and does not re-propose.
    let mut journal = Journal::load(fx.journal_dir.path());
    let report = svastha_node::ocr::run(
        &fx.node_client,
        &fx.cache,
        &fx.state,
        &inf,
        &StubReader::page(),
        &resumed(&fx.journal_dir),
        &mut journal,
    )
    .unwrap();
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

    svastha_node::ocr::run(
        &fx.node_client,
        &fx.cache,
        &fx.state,
        &inf,
        &StubReader::page(),
        &resumed(&fx.journal_dir),
        &mut journal,
    )
    .unwrap();
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
    let report = svastha_node::ocr::run(
        &fx.node_client,
        &fx.cache,
        &fx.state,
        &inf,
        &StubReader::page(),
        &resumed(&fx.journal_dir),
        &mut journal,
    )
    .unwrap();
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

    let report = svastha_node::ocr::run(
        &fx.node_client,
        &fx.cache,
        &fx.state,
        &inf,
        &StubReader::page(),
        &resumed(&fx.journal_dir),
        &mut journal,
    )
    .unwrap();
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

    let report = svastha_node::ocr::run(
        &fx.node_client,
        &fx.cache,
        &fx.state,
        &inf,
        &StubReader::page(),
        &resumed(&fx.journal_dir),
        &mut journal,
    )
    .unwrap();
    assert_eq!(report.failed, 1, "the failing page is counted, not fatal");
    assert_eq!(report.proposals, 1, "the other page is not wedged");
    assert_eq!(read_proposals(&fx.owner_client, &fx.owner).len(), 1);

    // The failed page is awaiting retry (the queued gauge), and within its
    // back-off a re-run does not retry it (and does not re-propose the other).
    let jobs = fx.state.lock().unwrap().job_status();
    assert_eq!(jobs.queued, 1, "one page awaiting retry");
    assert_eq!(jobs.failed, 1);

    let report2 = svastha_node::ocr::run(
        &fx.node_client,
        &fx.cache,
        &fx.state,
        &inf,
        &StubReader::page(),
        &resumed(&fx.journal_dir),
        &mut journal,
    )
    .unwrap();
    assert_eq!(report2.proposals, 0, "deposited page not re-proposed");
    assert_eq!(
        report2.failed, 0,
        "failed page still backing off, not retried"
    );
}

/// Stage A stubbed: the real recognizer needs model files (and a page that looks
/// like one), so these tests drive the pass with a fixed transcript. What they
/// exercise is everything the transcript feeds — the prompt, the source-line
/// guard, the journal, and the proposal deposit.
struct StubReader {
    lines: Vec<String>,
    unreadable: bool,
    /// Pages this reader was asked to read — the in-process OCR pass is the
    /// expensive half, so a test about the per-pass cap has to count it.
    reads: Arc<AtomicUsize>,
    /// The bytes of each page handed over, so a multi-owner test can tell
    /// *whose* pages were read (each owner's fixture pages are prefixed).
    seen: Arc<Mutex<Vec<Vec<u8>>>>,
}

impl StubReader {
    /// A transcript the fixture answer below can legitimately cite: the guard
    /// checks each finding's display and value against the line it names, so the
    /// two have to correspond or nothing is proposed — which is the point.
    fn page() -> Self {
        Self {
            lines: vec![
                "Vitals 2026-03-03".to_string(),
                "Systolic blood pressure 120 mm[Hg]".to_string(),
            ],
            unreadable: false,
            reads: Arc::new(AtomicUsize::new(0)),
            seen: Arc::new(Mutex::new(Vec::new())),
        }
    }

    /// A reader with a transcript of the caller's choosing.
    fn transcript(lines: &[&str]) -> Self {
        Self {
            lines: lines.iter().map(|l| l.to_string()).collect(),
            ..Self::page()
        }
    }

    /// A reader that fails on every page, as the real one does on a photograph
    /// it cannot make sense of.
    fn unreadable() -> Self {
        Self {
            unreadable: true,
            ..Self::page()
        }
    }

    /// A reader that finds no text at all — a blank or unrecognizable page.
    fn blank() -> Self {
        Self {
            lines: vec![],
            ..Self::page()
        }
    }

    fn reads(&self) -> usize {
        self.reads.load(Ordering::SeqCst)
    }

    /// How many pages whose bytes start with `prefix` this reader was handed —
    /// the per-owner read count the pause tests assert on.
    fn pages_starting_with(&self, prefix: &str) -> usize {
        self.seen
            .lock()
            .unwrap()
            .iter()
            .filter(|page| page.starts_with(prefix.as_bytes()))
            .count()
    }
}

impl svastha_node::transcribe::PageReader for StubReader {
    fn transcribe(&self, bytes: &[u8]) -> anyhow::Result<Vec<String>> {
        self.reads.fetch_add(1, Ordering::SeqCst);
        self.seen.lock().unwrap().push(bytes.to_vec());
        if self.unreadable {
            anyhow::bail!("this page could not be read");
        }
        Ok(self.lines.clone())
    }
}

/// A control with reading on for every owner, for the tests that are about the
/// pass itself. The gate's own behaviour — paused by default, per-owner scoping,
/// and the per-pass cap — is covered by `ocr_control`'s unit tests and the
/// pause tests below.
fn resumed(dir: &tempfile::TempDir) -> OcrControl {
    OcrControl::load(dir.path(), opted_in(DEFAULT_MAX_PAGES_PER_PASS))
}

/// Boot settings for a node an operator has opted in (`SVASTHA_NODE_OCR_PAUSED=false`),
/// with the given per-pass cap. Passed as a parameter, never through the process
/// env: cargo runs tests in parallel threads, and a shared env var is a race.
fn opted_in(max_pages_per_pass: usize) -> OcrSettings {
    OcrSettings {
        default_paused: false,
        max_pages_per_pass,
    }
}

/// The whole point of the gate: enrolling a node against a vault that already
/// holds pages must not start reading them. A thousand-entry approval queue is
/// not a queue anyone reviews, and the design rests on the owner reviewing.
#[test]
fn a_fresh_node_reads_nothing_until_the_owner_resumes() {
    let (base, calls) = spawn_inference(Mode::Ok(one_bp_finding()));
    let inf = inference_client(&base);
    let fx = setup(
        b"ocr owner paused",
        &[b"page one", b"page two", b"page three"],
    );
    let mut journal = Journal::load(fx.journal_dir.path());
    let owner_hex = hex_ed(&fx.owner);

    // Loaded with the shipped defaults — nobody has chosen, so nobody is read.
    let mut control = OcrControl::load(fx.journal_dir.path(), OcrSettings::default());
    let report = svastha_node::ocr::run(
        &fx.node_client,
        &fx.cache,
        &fx.state,
        &inf,
        &StubReader::page(),
        &control,
        &mut journal,
    )
    .unwrap();

    assert_eq!(report.paused_owners, 1);
    assert_eq!(report.proposals, 0);
    assert_eq!(calls.load(Ordering::SeqCst), 0, "no inference call at all");
    assert!(
        read_proposals(&fx.owner_client, &fx.owner).is_empty(),
        "nothing may reach the owner's mailbox"
    );

    // Resuming reads them, and the pages are still eligible — pausing defers
    // work rather than discarding it.
    control.set_paused(&owner_hex, false).unwrap();
    let report = svastha_node::ocr::run(
        &fx.node_client,
        &fx.cache,
        &fx.state,
        &inf,
        &StubReader::page(),
        &control,
        &mut journal,
    )
    .unwrap();
    assert_eq!(report.paused_owners, 0);
    assert_eq!(report.proposals, 3);
}

/// The defect this pins: a node serving two households had **one** paused flag,
/// so either owner could stop the other's reading — and the other's status said
/// "paused" with no way to undo it. The gate is the owner's own.
#[test]
fn one_owners_pause_leaves_the_other_reading() {
    let (base, _calls) = spawn_inference(Mode::Ok(one_bp_finding()));
    let inf = inference_client(&base);
    // Both owners start reading (the operator opted this deployment in), so the
    // only thing that stops A below is A's own pause.
    let fx = setup_pair(
        b"ocr owner pause a",
        &[b"a page one", b"a page two"],
        b"ocr owner pause b",
        &[b"b page one", b"b page two"],
    );
    let mut journal = Journal::load(fx.journal_dir.path());
    let mut control = OcrControl::load(fx.journal_dir.path(), opted_in(DEFAULT_MAX_PAGES_PER_PASS));
    control.set_paused(&hex_ed(&fx.a.id), true).unwrap();

    let reader = StubReader::page();
    let report = svastha_node::ocr::run(
        &fx.node_client,
        &fx.cache,
        &fx.state,
        &inf,
        &reader,
        &control,
        &mut journal,
    )
    .unwrap();

    assert_eq!(report.paused_owners, 1, "exactly one household stood down");
    assert_eq!(report.proposals, 2, "the other's two pages were read");
    assert_eq!(
        reader.pages_starting_with("a"),
        0,
        "the paused owner's pages were never even read"
    );
    assert_eq!(reader.pages_starting_with("b"), 2);
    assert!(
        read_proposals(&fx.a.client, &fx.a.id).is_empty(),
        "nothing reaches the paused owner's mailbox"
    );
    assert_eq!(read_proposals(&fx.b.client, &fx.b.id).len(), 2);

    // A's pages are deferred, not discarded: A resumes — across a reload of the
    // control, as a restart would — and its backlog is read, B's already done.
    let mut control = OcrControl::load(fx.journal_dir.path(), opted_in(DEFAULT_MAX_PAGES_PER_PASS));
    assert!(
        control.paused(&hex_ed(&fx.a.id)),
        "the pause survived the reload"
    );
    control.set_paused(&hex_ed(&fx.a.id), false).unwrap();

    let reader = StubReader::page();
    let report = svastha_node::ocr::run(
        &fx.node_client,
        &fx.cache,
        &fx.state,
        &inf,
        &reader,
        &control,
        &mut journal,
    )
    .unwrap();
    assert_eq!(report.paused_owners, 0);
    assert_eq!(report.proposals, 2);
    assert_eq!(reader.pages_starting_with("a"), 2, "A's backlog, now read");
    assert_eq!(reader.pages_starting_with("b"), 0, "B's pages are done");
    assert_eq!(read_proposals(&fx.a.client, &fx.a.id).len(), 2);
}

/// The escape hatch for a deployment upgrading into pause-by-default: no owner
/// has a persisted choice, no UI sends `resume_ocr` yet, and without this the
/// node silently stops reading with no remedy short of wiping state. An owner
/// who *has* chosen still wins over it.
#[test]
fn the_boot_default_opts_in_owners_who_have_not_chosen() {
    let (base, _calls) = spawn_inference(Mode::Ok(one_bp_finding()));
    let inf = inference_client(&base);
    let fx = setup_pair(
        b"ocr owner envdefault a",
        &[b"a page one"],
        b"ocr owner envdefault b",
        &[b"b page one"],
    );
    let mut journal = Journal::load(fx.journal_dir.path());

    // A chose to pause; B has never chosen anything.
    {
        let mut control =
            OcrControl::load(fx.journal_dir.path(), opted_in(DEFAULT_MAX_PAGES_PER_PASS));
        control.set_paused(&hex_ed(&fx.a.id), true).unwrap();
    }
    let control = OcrControl::load(fx.journal_dir.path(), opted_in(DEFAULT_MAX_PAGES_PER_PASS));

    let report = svastha_node::ocr::run(
        &fx.node_client,
        &fx.cache,
        &fx.state,
        &inf,
        &StubReader::page(),
        &control,
        &mut journal,
    )
    .unwrap();
    assert_eq!(report.proposals, 1, "B reads on the boot default");
    assert_eq!(report.paused_owners, 1, "A's persisted choice still wins");
    assert!(read_proposals(&fx.a.client, &fx.a.id).is_empty());
    assert_eq!(read_proposals(&fx.b.client, &fx.b.id).len(), 1);
}

/// A resumed control with the per-pass cap set to `pages`.
fn capped(dir: &tempfile::TempDir, pages: usize) -> OcrControl {
    OcrControl::load(dir.path(), opted_in(pages))
}

/// A backlog arrives as reviewable batches, not a flood — and the next pass
/// picks up exactly where this one stopped.
#[test]
fn reads_at_most_the_cap_per_pass() {
    let (base, _calls) = spawn_inference(Mode::Ok(one_bp_finding()));
    let inf = inference_client(&base);
    let fx = setup(
        b"ocr owner capped",
        &[b"page one", b"page two", b"page three", b"page four"],
    );
    let mut journal = Journal::load(fx.journal_dir.path());
    let control = capped(&fx.journal_dir, 2);

    let first = svastha_node::ocr::run(
        &fx.node_client,
        &fx.cache,
        &fx.state,
        &inf,
        &StubReader::page(),
        &control,
        &mut journal,
    )
    .unwrap();
    assert_eq!(first.proposals, 2, "capped at two");
    assert!(first.deferred_to_next_pass > 0, "and says there is more");

    let second = svastha_node::ocr::run(
        &fx.node_client,
        &fx.cache,
        &fx.state,
        &inf,
        &StubReader::page(),
        &control,
        &mut journal,
    )
    .unwrap();
    assert_eq!(second.proposals, 2, "the rest, next pass");

    let third = svastha_node::ocr::run(
        &fx.node_client,
        &fx.cache,
        &fx.state,
        &inf,
        &StubReader::page(),
        &control,
        &mut journal,
    )
    .unwrap();
    assert_eq!(third.proposals, 0, "and then it is done");
    assert_eq!(third.deferred_to_next_pass, 0);
}

/// The cap has to bound *work*, not successes. A failing page costs the same
/// full in-process OCR pass as a successful one, so counting only successes let
/// a vault of failing pages run unbounded reads in one reconcile — the loop the
/// cap exists to protect.
#[test]
fn a_page_that_cannot_be_read_consumes_the_cap_like_any_other() {
    let (base, _calls) = spawn_inference(Mode::Ok(one_bp_finding()));
    let inf = inference_client(&base);
    let fx = setup(
        b"ocr owner unreadable",
        &[b"page one", b"page two", b"page three", b"page four"],
    );
    let mut journal = Journal::load(fx.journal_dir.path());
    let control = capped(&fx.journal_dir, 2);

    let reader = StubReader::unreadable();
    let report = svastha_node::ocr::run(
        &fx.node_client,
        &fx.cache,
        &fx.state,
        &inf,
        &reader,
        &control,
        &mut journal,
    )
    .unwrap();
    assert_eq!(report.failed, 2, "two attempts, not four");
    assert_eq!(
        reader.reads(),
        2,
        "the pass actually stopped reading; the accounting is not the point"
    );
    assert!(
        report.deferred_to_next_pass > 0,
        "the untouched pages are deferred, not lost"
    );
}

/// The same defect on the other early-`continue`: a page the reader gets
/// through but finds no text on still cost a full OCR pass.
#[test]
fn a_blank_page_consumes_the_cap_like_any_other() {
    let (base, _calls) = spawn_inference(Mode::Ok(one_bp_finding()));
    let inf = inference_client(&base);
    let fx = setup(
        b"ocr owner blank pages",
        &[b"page one", b"page two", b"page three", b"page four"],
    );
    let mut journal = Journal::load(fx.journal_dir.path());
    let control = capped(&fx.journal_dir, 2);

    let reader = StubReader::blank();
    let report = svastha_node::ocr::run(
        &fx.node_client,
        &fx.cache,
        &fx.state,
        &inf,
        &reader,
        &control,
        &mut journal,
    )
    .unwrap();
    assert_eq!(report.empties, 2, "two attempts, not four");
    assert_eq!(reader.reads(), 2);
    assert!(report.deferred_to_next_pass > 0);
}

/// `job_status` is a gauge the owner reads over the admin surface. Pausing
/// stops the reading, not the reporting: an owner who pauses and then asks what
/// is outstanding must not be shown whatever the number happened to be when
/// they paused.
#[test]
fn a_paused_pass_still_refreshes_job_status() {
    let (base, _calls) = spawn_inference(Mode::Ok(one_bp_finding()));
    let inf = inference_client(&base);
    let fx = setup(b"ocr owner paused status", &[b"page one"]);
    let mut journal = Journal::load(fx.journal_dir.path());

    // A stale gauge, as a run before the pause would have left it.
    fx.state.lock().unwrap().record_ocr_run(7, 3, 1);

    let control = OcrControl::load(fx.journal_dir.path(), OcrSettings::default());
    let report = svastha_node::ocr::run(
        &fx.node_client,
        &fx.cache,
        &fx.state,
        &inf,
        &StubReader::page(),
        &control,
        &mut journal,
    )
    .unwrap();
    assert_eq!(report.paused_owners, 1);

    let jobs = fx.state.lock().unwrap().job_status();
    assert_eq!(
        jobs.queued, 0,
        "the queued gauge is refreshed while paused, not frozen"
    );
    // The cumulative totals are a record of work done, and a paused pass did
    // none — refreshing the gauge must not inflate them.
    assert_eq!(jobs.processed, 3);
    assert_eq!(jobs.failed, 1);
}
