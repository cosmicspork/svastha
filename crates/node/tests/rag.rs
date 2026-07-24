//! Integration tests for cited Q&A and admin handling (D3) against the **real
//! relay crate** in-process plus a **mock OpenAI-compatible inference server**
//! (also in-process). The owner side stands in for the PWA: it seeds a vault,
//! grants the node, hands off keys, then deposits `chat_msg` questions and
//! `admin_cmd`s and reads the node's `chat_msg` answers / `admin_reply`s back —
//! asserting they match the spec body schemas C3 consumes.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::mpsc;
use std::sync::Arc;
use std::sync::Mutex;

use serde_json::json;
use sha2::{Digest, Sha256};
use svastha_core::curation::SignedCurationRecord;
use svastha_core::envelope::DataKey;
use svastha_core::event::{Code, Event, EventKind, Provenance, SignedEvent};
use svastha_core::keyring::Keyring;
use svastha_core::keys::Identity;
use svastha_core::mailbox::{
    parse_mailbox_item, AdminCmdBody, AdminCommand, AdminReplyBody, ChatMsgBody, ChatRole,
    KeyHandoffBody, MailboxItem, MailboxMessage, MessageKind,
};

use svastha_node::admin;
use svastha_node::cache::Cache;
use svastha_node::chat;
use svastha_node::client::RelayClient;
use svastha_node::config::InferenceConfig;
use svastha_node::inference::{InferenceClient, InferenceRuntime};
use svastha_node::journal::Journal;
use svastha_node::logtail::LogBuffer;
use svastha_node::state::NodeState;
use svastha_node::sync::{consume_mailbox, sync_all};

use svastha_relay::grants::MemoryGrantStore;
use svastha_relay::mailbox::MemoryMailboxStore;
use svastha_relay::share::MemoryShareStore;
use svastha_relay::store::MemoryStore;

// ---- in-process relay (same pattern as tests/ocr.rs) ----

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

#[derive(Clone)]
enum Mode {
    /// Return this string as the assistant message content (a JSON answer).
    Ok(String),
    /// Return a valid completion whose content is not the expected JSON.
    Malformed,
}

#[derive(Clone)]
struct MockState {
    mode: Mode,
    calls: Arc<AtomicUsize>,
}

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
                state.calls.fetch_add(1, Ordering::SeqCst);
                let content = match &state.mode {
                    Mode::Ok(s) => s.clone(),
                    Mode::Malformed => "I'm not able to answer that.".to_string(),
                };
                (
                    StatusCode::OK,
                    Json(json!({
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
        model: "chat-test".to_string(),
    })
}

// ---- owner-side helpers (the PWA's role) ----

fn hex_ed(id: &Identity) -> String {
    hex::encode(id.verifying_key().to_bytes())
}

fn med(owner: &Identity, rxnorm: &str, display: &str, date: &str) -> SignedEvent {
    owner.sign_event(Event::new(
        EventKind::MedicationStatement,
        Some(Code {
            system: "http://www.nlm.nih.gov/research/umls/rxnorm".into(),
            code: rxnorm.into(),
            display: Some(display.into()),
        }),
        Some(date.into()),
        None,
        Provenance {
            source: "import".into(),
            source_doc: None,
        },
    ))
}

fn put_event(client: &RelayClient, ring: &Keyring, owner: &Identity, signed: &SignedEvent) {
    let blob_id = format!("ev-{}", signed.event.id.to_hex());
    let sealed = ring
        .seal_blob(
            owner,
            blob_id.as_bytes(),
            &serde_json::to_vec(signed).unwrap(),
        )
        .unwrap();
    client.put_blob(&blob_id, &sealed).unwrap();
}

fn put_curation(
    client: &RelayClient,
    ring: &Keyring,
    owner: &Identity,
    rec: &SignedCurationRecord,
) {
    let blob_id = format!(
        "cur-{}",
        hex::encode(Sha256::digest(rec.record.key.as_bytes()))
    );
    let sealed = ring
        .seal_blob(owner, blob_id.as_bytes(), &serde_json::to_vec(rec).unwrap())
        .unwrap();
    client.put_blob(&blob_id, &sealed).unwrap();
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
            &format!("kh-{}", hex_ed(owner)),
            &serde_json::to_vec(&envelope).unwrap(),
        )
        .unwrap();
}

/// Seal a `chat_msg` question to the node and deposit it (the PWA's
/// `sendChatMessage`). Returns the question envelope's message id.
fn ask(asker: &Identity, asker_client: &RelayClient, node: &Identity, text: &str) -> String {
    let body = ChatMsgBody {
        role: ChatRole::Question,
        text: text.into(),
        citations: vec![],
    };
    let envelope = MailboxMessage::seal(
        asker,
        &node.x25519_public(),
        MessageKind::ChatMsg,
        1_753_000_100_000,
        &serde_json::to_vec(&body).unwrap(),
    );
    let id = envelope.id_hex();
    asker_client
        .put_mailbox(
            &hex_ed(node),
            &format!("chat-{id}"),
            &serde_json::to_vec(&envelope).unwrap(),
        )
        .unwrap();
    id
}

/// Seal an `admin_cmd` to the node and deposit it. Returns its message id.
fn command(
    owner: &Identity,
    owner_client: &RelayClient,
    node: &Identity,
    cmd: AdminCommand,
) -> String {
    let body = AdminCmdBody { command: cmd };
    let envelope = MailboxMessage::seal(
        owner,
        &node.x25519_public(),
        MessageKind::AdminCmd,
        1_753_000_200_000,
        &serde_json::to_vec(&body).unwrap(),
    );
    let id = envelope.id_hex();
    owner_client
        .put_mailbox(
            &hex_ed(node),
            &format!("admin-{id}"),
            &serde_json::to_vec(&envelope).unwrap(),
        )
        .unwrap();
    id
}

/// The owner reads its mailbox and returns every verified, opened `chat_msg`
/// **answer** (as C3's ask screen would). Verifies the envelope and binds the
/// relay attestation — the "C3 could parse it" assertion.
fn read_chat_answers(owner_client: &RelayClient, owner: &Identity) -> Vec<ChatMsgBody> {
    read_bodies(owner_client, owner, MessageKind::ChatMsg)
        .into_iter()
        .filter(|b: &ChatMsgBody| b.role == ChatRole::Answer)
        .collect()
}

fn read_admin_replies(owner_client: &RelayClient, owner: &Identity) -> Vec<AdminReplyBody> {
    read_bodies(owner_client, owner, MessageKind::AdminReply)
}

fn read_bodies<T: for<'de> serde::Deserialize<'de>>(
    owner_client: &RelayClient,
    owner: &Identity,
    kind: MessageKind,
) -> Vec<T> {
    let mut out = Vec::new();
    for entry in owner_client.list_mailbox().unwrap() {
        let (bytes, from) = owner_client.get_mailbox(&entry.id).unwrap().unwrap();
        let Ok(MailboxItem::Message(msg)) = parse_mailbox_item(&bytes) else {
            continue;
        };
        if msg.kind != kind {
            continue;
        }
        assert!(msg.verify(), "node reply must verify");
        assert_eq!(
            msg.from_hex(),
            from,
            "envelope from must match relay attest"
        );
        let plain = msg.open(owner).expect("owner opens a reply sealed to it");
        out.push(serde_json::from_slice::<T>(&plain).expect("reply matches the spec schema"));
    }
    out
}

// ---- the multi-tenant harness ----

struct Harness {
    base: String,
    node: Identity,
    node_client: RelayClient,
    state: Mutex<NodeState>,
    cache: Cache,
    dir: tempfile::TempDir,
}

struct Owner {
    id: Identity,
    client: RelayClient,
    ring: Keyring,
}

impl Harness {
    fn new(node_seed: &[u8]) -> Self {
        let base = spawn_relay();
        let node = Identity::from_seed(node_seed);
        let node_client = RelayClient::new(base.clone(), Arc::new(Identity::from_seed(node_seed)));
        Harness {
            base,
            node,
            node_client,
            state: Mutex::new(NodeState::new()),
            cache: Cache::new(tempfile::tempdir().unwrap().path().to_path_buf()),
            dir: tempfile::tempdir().unwrap(),
        }
    }

    /// Add an owner: fresh identity + client + genesis keyring, grant the node,
    /// and hand off the keyring. The caller seeds the vault, then calls
    /// [`enroll_and_sync`].
    fn add_owner(&self, seed: &[u8]) -> Owner {
        let id = Identity::from_seed(seed);
        let client = RelayClient::new(self.base.clone(), Arc::new(Identity::from_seed(seed)));
        let ring = Keyring::genesis(&id.x25519_public(), &DataKey::generate());
        grant_node(&client, &self.node);
        deposit_handoff(&client, &id, &self.node, &ring);
        Owner { id, client, ring }
    }

    fn enroll_and_sync(&self) {
        consume_mailbox(&self.node_client, &self.state).unwrap();
        sync_all(&self.node_client, &self.cache, &self.state).unwrap();
    }

    fn journal(&self) -> Journal {
        Journal::load(self.dir.path())
    }
}

// ---- chat tests ----

#[test]
fn question_gets_a_cited_answer_the_web_schema_accepts() {
    // The model cites context item 1; with a single seeded match, that maps to the
    // seeded event's id — a citation that is a subset of the supplied context.
    let (base, calls) = spawn_inference(Mode::Ok(
        r#"{"answer":"You are currently taking lisinopril 10mg.","used":[1]}"#.into(),
    ));
    let inf = inference_client(&base);

    let h = Harness::new(b"rag node one");
    let owner = h.add_owner(b"rag owner one");
    let lisinopril = med(&owner.id, "197361", "Lisinopril 10mg", "2025-01-01");
    put_event(&owner.client, &owner.ring, &owner.id, &lisinopril);
    h.enroll_and_sync();

    ask(&owner.id, &owner.client, &h.node, "am I taking lisinopril?");
    let mut journal = h.journal();
    let report = chat::run(&h.node_client, &h.state, &inf, &mut journal).unwrap();
    assert_eq!(report.answered, 1, "one grounded answer");
    assert_eq!(calls.load(Ordering::SeqCst), 1, "one inference call");

    let answers = read_chat_answers(&owner.client, &owner.id);
    assert_eq!(answers.len(), 1);
    assert_eq!(answers[0].role, ChatRole::Answer);
    assert!(!answers[0].text.is_empty());
    assert_eq!(
        answers[0].citations,
        vec![lisinopril.event.id.to_hex()],
        "the citation is the seeded event id — a subset of the supplied context"
    );
}

#[test]
fn ungroundable_answer_replies_honestly_without_citations() {
    // The endpoint is reachable but returns prose, not the JSON schema → the node
    // must reply honestly rather than forward uncited prose.
    let (base, _calls) = spawn_inference(Mode::Malformed);
    let inf = inference_client(&base);

    let h = Harness::new(b"rag node two");
    let owner = h.add_owner(b"rag owner two");
    put_event(
        &owner.client,
        &owner.ring,
        &owner.id,
        &med(&owner.id, "197361", "Lisinopril", "2025-01-01"),
    );
    h.enroll_and_sync();

    ask(&owner.id, &owner.client, &h.node, "am I taking lisinopril?");
    let mut journal = h.journal();
    let report = chat::run(&h.node_client, &h.state, &inf, &mut journal).unwrap();
    assert_eq!(report.answered, 0);
    assert_eq!(
        report.cant_answer, 1,
        "honest can't-answer, not uncited prose"
    );

    let answers = read_chat_answers(&owner.client, &owner.id);
    assert_eq!(answers.len(), 1);
    assert!(
        answers[0].citations.is_empty(),
        "no citations on a can't-answer"
    );
    assert!(!answers[0].text.is_empty(), "still an honest sentence");
}

#[test]
fn a_question_from_a_non_enrolled_identity_is_dropped() {
    // A validly-signed question from an identity the node was never granted by.
    let (base, calls) = spawn_inference(Mode::Ok(r#"{"answer":"x","used":[1]}"#.into()));
    let inf = inference_client(&base);

    let h = Harness::new(b"rag node three");
    let owner = h.add_owner(b"rag owner three");
    put_event(
        &owner.client,
        &owner.ring,
        &owner.id,
        &med(&owner.id, "197361", "Lisinopril", "2025-01-01"),
    );
    h.enroll_and_sync();

    // A stranger (never enrolled) signs a real envelope and deposits a question.
    let stranger = Identity::from_seed(b"rag stranger");
    let stranger_client = RelayClient::new(
        h.base.clone(),
        Arc::new(Identity::from_seed(b"rag stranger")),
    );
    ask(
        &stranger,
        &stranger_client,
        &h.node,
        "am I taking lisinopril?",
    );

    let mut journal = h.journal();
    let report = chat::run(&h.node_client, &h.state, &inf, &mut journal).unwrap();
    assert_eq!(report.dropped, 1, "sender gate drops the stranger");
    assert_eq!(report.answered, 0);
    assert_eq!(
        calls.load(Ordering::SeqCst),
        0,
        "no inference for a dropped question"
    );
    // The stranger receives no answer.
    assert!(read_chat_answers(&stranger_client, &stranger).is_empty());
}

#[test]
fn cross_tenant_isolation_a_question_never_retrieves_bs_events() {
    // A and B both enrolled on one node. A's question names a drug that exists
    // ONLY in B's vault → A's retrieval is over A's index alone, finds nothing, and
    // the node answers honestly with no citations. B asking the same is answered
    // from B's own vault, citing B's event — proving the walls, not the wiring.
    let (base, _calls) = spawn_inference(Mode::Ok(r#"{"answer":"Yes.","used":[1]}"#.into()));
    let inf = inference_client(&base);

    let h = Harness::new(b"rag node xt");
    let a = h.add_owner(b"rag owner A");
    let b = h.add_owner(b"rag owner B");

    // A's vault: aspirin. B's vault: warfarin. Distinct.
    let a_aspirin = med(&a.id, "1191", "aspirin", "2025-01-01");
    put_event(&a.client, &a.ring, &a.id, &a_aspirin);
    let b_warfarin = med(&b.id, "11289", "warfarin", "2025-01-01");
    put_event(&b.client, &b.ring, &b.id, &b_warfarin);
    h.enroll_and_sync();

    // A asks about warfarin — which only B has.
    ask(&a.id, &a.client, &h.node, "am I taking warfarin?");
    let mut journal = h.journal();
    let report = chat::run(&h.node_client, &h.state, &inf, &mut journal).unwrap();
    assert_eq!(
        report.cant_answer, 1,
        "A's warfarin question finds nothing in A's vault"
    );
    assert_eq!(report.answered, 0);

    let a_answers = read_chat_answers(&a.client, &a.id);
    assert_eq!(a_answers.len(), 1);
    assert!(
        a_answers[0].citations.is_empty(),
        "A can never cite B's warfarin event"
    );

    // B asks about warfarin — B's own vault answers, citing B's event.
    ask(&b.id, &b.client, &h.node, "am I taking warfarin?");
    let report = chat::run(&h.node_client, &h.state, &inf, &mut journal).unwrap();
    assert_eq!(report.answered, 1);
    let b_answers = read_chat_answers(&b.client, &b.id);
    assert_eq!(b_answers[0].citations, vec![b_warfarin.event.id.to_hex()]);
}

#[test]
fn resolved_vs_current_curation_shapes_the_cited_answer() {
    // Two metformin meds, one marked resolved. The model is told to cite item 1;
    // retrieval's curation-aware ranking puts the ACTIVE med first, so the citation
    // is the current one — the status overlay shaping what gets answered.
    let (base, _calls) = spawn_inference(Mode::Ok(r#"{"answer":"metformin.","used":[1]}"#.into()));
    let inf = inference_client(&base);

    let h = Harness::new(b"rag node cur");
    let owner = h.add_owner(b"rag owner cur");
    let active = med(&owner.id, "860975", "metformin tablet", "2020-01-01");
    let stopped = med(&owner.id, "861007", "metformin syrup", "2024-01-01"); // newer, but resolved
    put_event(&owner.client, &owner.ring, &owner.id, &active);
    put_event(&owner.client, &owner.ring, &owner.id, &stopped);
    let stopped_concept = svastha_node::index::VaultIndex::concept_key(&stopped.event).unwrap();
    put_curation(
        &owner.client,
        &owner.ring,
        &owner.id,
        &owner.id.sign_curation(
            format!("status:{stopped_concept}"),
            json!({ "status": "inactive" }),
            1000,
        ),
    );
    h.enroll_and_sync();

    ask(
        &owner.id,
        &owner.client,
        &h.node,
        "what metformin am I currently taking?",
    );
    let mut journal = h.journal();
    chat::run(&h.node_client, &h.state, &inf, &mut journal).unwrap();
    let answers = read_chat_answers(&owner.client, &owner.id);
    assert_eq!(
        answers[0].citations,
        vec![active.event.id.to_hex()],
        "the current med is cited over the newer-but-resolved one"
    );
}

#[test]
fn a_handled_question_is_not_re_answered_after_a_restart() {
    let (base, calls) = spawn_inference(Mode::Ok(r#"{"answer":"yes","used":[1]}"#.into()));
    let inf = inference_client(&base);

    let h = Harness::new(b"rag node restart");
    let owner = h.add_owner(b"rag owner restart");
    put_event(
        &owner.client,
        &owner.ring,
        &owner.id,
        &med(&owner.id, "197361", "Lisinopril", "2025-01-01"),
    );
    h.enroll_and_sync();
    ask(&owner.id, &owner.client, &h.node, "am I taking lisinopril?");

    {
        let mut journal = h.journal();
        chat::run(&h.node_client, &h.state, &inf, &mut journal).unwrap();
    }
    assert_eq!(read_chat_answers(&owner.client, &owner.id).len(), 1);
    assert_eq!(calls.load(Ordering::SeqCst), 1);

    // Simulated restart: fresh journal from the same durable dir. Even if the
    // question lingered in the node's mailbox, it must not be answered again.
    let mut journal = h.journal();
    let report = chat::run(&h.node_client, &h.state, &inf, &mut journal).unwrap();
    assert_eq!(report.answered, 0, "restart does not re-answer");
    assert_eq!(
        calls.load(Ordering::SeqCst),
        1,
        "no second inference call after restart"
    );
    assert_eq!(read_chat_answers(&owner.client, &owner.id).len(), 1);
}

// ---- admin tests ----

/// A runtime whose boot config points at `endpoint` (a valid synchronous URL).
fn runtime(dir: &std::path::Path, endpoint: &str) -> InferenceRuntime {
    InferenceRuntime::load(
        Some(InferenceConfig {
            endpoint: endpoint.to_string(),
            api_key: None,
            model: "chat-test".to_string(),
        }),
        dir,
    )
}

#[test]
fn admin_job_status_round_trips() {
    let h = Harness::new(b"admin node status");
    let owner = h.add_owner(b"admin owner status");
    put_event(
        &owner.client,
        &owner.ring,
        &owner.id,
        &med(&owner.id, "197361", "Lisinopril", "2025-01-01"),
    );
    h.enroll_and_sync();

    let cmd_id = command(&owner.id, &owner.client, &h.node, AdminCommand::JobStatus);
    let mut rt = runtime(h.dir.path(), "https://inference.internal/v1");
    let logs = LogBuffer::new();
    let mut journal = h.journal();
    let report = admin::run(&h.node_client, &h.state, &mut rt, &logs, &mut journal).unwrap();
    assert_eq!(report.replied, 1);

    let replies = read_admin_replies(&owner.client, &owner.id);
    assert_eq!(replies.len(), 1);
    assert_eq!(
        replies[0].in_reply_to, cmd_id,
        "reply references the command id"
    );
    assert!(replies[0].ok);
    let detail = replies[0].detail.as_deref().unwrap();
    assert!(
        detail.contains("events=1"),
        "reports this owner's index size"
    );
    assert!(detail.contains("ocr:"), "reports the ocr counters");
}

#[test]
fn admin_log_tail_round_trips_with_content_free_lines() {
    let h = Harness::new(b"admin node log");
    let owner = h.add_owner(b"admin owner log");
    h.enroll_and_sync();

    let logs = LogBuffer::new();
    logs.push("vault synced owner=aabbccddeeff events=3".into());
    logs.push("chat pass answered=1".into());

    command(
        &owner.id,
        &owner.client,
        &h.node,
        AdminCommand::LogTail { lines: Some(10) },
    );
    let mut rt = runtime(h.dir.path(), "https://inference.internal/v1");
    let mut journal = h.journal();
    admin::run(&h.node_client, &h.state, &mut rt, &logs, &mut journal).unwrap();

    let replies = read_admin_replies(&owner.client, &owner.id);
    assert_eq!(replies.len(), 1);
    assert!(replies[0].ok);
    let detail = replies[0].detail.as_deref().unwrap();
    assert!(
        detail.contains("chat pass answered=1"),
        "recent log line returned"
    );
}

#[test]
fn admin_set_inference_endpoint_accepts_valid_and_rejects_batch() {
    let h = Harness::new(b"admin node inf");
    let owner = h.add_owner(b"admin owner inf");
    h.enroll_and_sync();

    let logs = LogBuffer::new();
    let mut rt = runtime(h.dir.path(), "https://boot.internal/v1");

    // A valid synchronous endpoint is accepted and becomes live.
    command(
        &owner.id,
        &owner.client,
        &h.node,
        AdminCommand::SetInferenceEndpoint {
            endpoint: "https://new-inference.internal/v1".into(),
        },
    );
    let mut journal = h.journal();
    admin::run(&h.node_client, &h.state, &mut rt, &logs, &mut journal).unwrap();
    assert_eq!(rt.endpoint(), Some("https://new-inference.internal/v1"));

    let ok_reply = read_admin_replies(&owner.client, &owner.id).pop().unwrap();
    assert!(ok_reply.ok, "valid endpoint accepted");
    // Clear the owner mailbox so the next reply is unambiguous.
    for entry in owner.client.list_mailbox().unwrap() {
        owner.client.delete_mailbox(&entry.id).unwrap();
    }

    // A Batch-API path is rejected (design §8) with ok:false and the reason.
    command(
        &owner.id,
        &owner.client,
        &h.node,
        AdminCommand::SetInferenceEndpoint {
            endpoint: "https://api.internal/v1/batch".into(),
        },
    );
    admin::run(&h.node_client, &h.state, &mut rt, &logs, &mut journal).unwrap();
    let bad_reply = read_admin_replies(&owner.client, &owner.id).pop().unwrap();
    assert!(!bad_reply.ok, "batch endpoint rejected");
    assert!(bad_reply.detail.as_deref().unwrap().contains("Batch"));
    // The rejected value never became live.
    assert_eq!(rt.endpoint(), Some("https://new-inference.internal/v1"));
}

#[test]
fn admin_command_from_a_non_enrolled_identity_is_dropped() {
    let h = Harness::new(b"admin node gate");
    let _owner = h.add_owner(b"admin owner gate");
    h.enroll_and_sync();

    let stranger = Identity::from_seed(b"admin stranger");
    let stranger_client = RelayClient::new(
        h.base.clone(),
        Arc::new(Identity::from_seed(b"admin stranger")),
    );
    command(
        &stranger,
        &stranger_client,
        &h.node,
        AdminCommand::JobStatus,
    );

    let logs = LogBuffer::new();
    let mut rt = runtime(h.dir.path(), "https://boot.internal/v1");
    let mut journal = h.journal();
    let report = admin::run(&h.node_client, &h.state, &mut rt, &logs, &mut journal).unwrap();
    assert_eq!(
        report.dropped, 1,
        "design §2: commands only from enrolled owners"
    );
    assert_eq!(report.replied, 0);
    assert!(read_admin_replies(&stranger_client, &stranger).is_empty());
}
