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
use svastha_node::answer_scope::AnswerScopeControl;
use svastha_node::cache::Cache;
use svastha_node::chat;
use svastha_node::client::RelayClient;
use svastha_node::config::InferenceConfig;
use svastha_node::inference::InferenceRuntime;
use svastha_node::journal::Journal;
use svastha_node::logtail::LogBuffer;
use svastha_node::ocr_control::{OcrControl, OcrSettings};
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

/// A runtime with `base` as the operator's boot default for both roles — the
/// shape an owner who has set no endpoint of their own resolves to. Loaded from
/// a fresh temp dir so no owner has a persisted choice.
fn inference_client(base: &str) -> InferenceRuntime {
    let boot = InferenceConfig {
        endpoint: base.to_string(),
        api_key: None,
        model: "chat-test".to_string(),
    };
    InferenceRuntime::load(
        Some(boot.clone()),
        Some(boot),
        tempfile::tempdir().unwrap().path(),
    )
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
    command_at(owner, owner_client, node, cmd, 1_753_000_200_000)
}

/// Deposit a command with an explicit signed `sent_at` — the owner's own clock,
/// which is what orders two instructions sent close together.
fn command_at(
    owner: &Identity,
    owner_client: &RelayClient,
    node: &Identity,
    cmd: AdminCommand,
    sent_at: i64,
) -> String {
    let body = AdminCmdBody { command: cmd };
    let envelope = MailboxMessage::seal(
        owner,
        &node.x25519_public(),
        MessageKind::AdminCmd,
        sent_at,
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
    let report = chat::run(&h.node_client, &h.state, &inf, &scopes(&h), &mut journal).unwrap();
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
    let report = chat::run(&h.node_client, &h.state, &inf, &scopes(&h), &mut journal).unwrap();
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
    let report = chat::run(&h.node_client, &h.state, &inf, &scopes(&h), &mut journal).unwrap();
    assert_eq!(report.dropped, 1, "sender gate drops the stranger");
    assert_eq!(report.answered, 0);
    assert_eq!(
        calls.load(Ordering::SeqCst),
        0,
        "no inference for a dropped question"
    );
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

    let a_aspirin = med(&a.id, "1191", "aspirin", "2025-01-01");
    put_event(&a.client, &a.ring, &a.id, &a_aspirin);
    let b_warfarin = med(&b.id, "11289", "warfarin", "2025-01-01");
    put_event(&b.client, &b.ring, &b.id, &b_warfarin);
    h.enroll_and_sync();

    ask(&a.id, &a.client, &h.node, "am I taking warfarin?");
    let mut journal = h.journal();
    let report = chat::run(&h.node_client, &h.state, &inf, &scopes(&h), &mut journal).unwrap();
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

    ask(&b.id, &b.client, &h.node, "am I taking warfarin?");
    let report = chat::run(&h.node_client, &h.state, &inf, &scopes(&h), &mut journal).unwrap();
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
    let stopped_concept = svastha_node::index::VaultIndex::concept_key(&stopped.event);
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
    chat::run(&h.node_client, &h.state, &inf, &scopes(&h), &mut journal).unwrap();
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
        chat::run(&h.node_client, &h.state, &inf, &scopes(&h), &mut journal).unwrap();
    }
    assert_eq!(read_chat_answers(&owner.client, &owner.id).len(), 1);
    assert_eq!(calls.load(Ordering::SeqCst), 1);

    // Simulated restart: fresh journal from the same durable dir. Even if the
    // question lingered in the node's mailbox, it must not be answered again.
    let mut journal = h.journal();
    let report = chat::run(&h.node_client, &h.state, &inf, &scopes(&h), &mut journal).unwrap();
    assert_eq!(report.answered, 0, "restart does not re-answer");
    assert_eq!(
        calls.load(Ordering::SeqCst),
        1,
        "no second inference call after restart"
    );
    assert_eq!(read_chat_answers(&owner.client, &owner.id).len(), 1);
}

// ---- admin tests ----

/// A runtime whose boot config points both roles at `endpoint` (a valid
/// synchronous URL) — the single-endpoint shape these admin tests exercise.
fn runtime(dir: &std::path::Path, endpoint: &str) -> InferenceRuntime {
    let boot = InferenceConfig {
        endpoint: endpoint.to_string(),
        api_key: None,
        model: "chat-test".to_string(),
    };
    InferenceRuntime::load(Some(boot.clone()), Some(boot), dir)
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
    let report = admin::run(
        &h.node_client,
        &h.state,
        &mut rt,
        &mut control(&h),
        &mut scopes(&h),
        &logs,
        &mut journal,
    )
    .unwrap();
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
    admin::run(
        &h.node_client,
        &h.state,
        &mut rt,
        &mut control(&h),
        &mut scopes(&h),
        &logs,
        &mut journal,
    )
    .unwrap();

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
            api_key: None,
        },
    );
    let mut journal = h.journal();
    admin::run(
        &h.node_client,
        &h.state,
        &mut rt,
        &mut control(&h),
        &mut scopes(&h),
        &logs,
        &mut journal,
    )
    .unwrap();
    assert_eq!(
        rt.marker_for(&hex_ed(&owner.id)),
        "[endpoint: new-inference.internal]"
    );

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
            api_key: None,
        },
    );
    admin::run(
        &h.node_client,
        &h.state,
        &mut rt,
        &mut control(&h),
        &mut scopes(&h),
        &logs,
        &mut journal,
    )
    .unwrap();
    let bad_reply = read_admin_replies(&owner.client, &owner.id).pop().unwrap();
    assert!(!bad_reply.ok, "batch endpoint rejected");
    assert!(bad_reply.detail.as_deref().unwrap().contains("Batch"));
    // The rejected value never became live.
    assert_eq!(
        rt.marker_for(&hex_ed(&owner.id)),
        "[endpoint: new-inference.internal]"
    );
}

/// One owner's endpoint is one owner's. Over the real wire, with two enrolled
/// owners on one node: the point of making this per-owner is that A cannot
/// repoint B's plaintext, and `job_status` must not tell A about B's host or
/// anyone's key either.
#[test]
fn an_owners_endpoint_and_its_key_reach_nobody_else() {
    let h = Harness::new(b"endpoint tenancy node");
    let a = h.add_owner(b"endpoint tenancy owner a");
    let b = h.add_owner(b"endpoint tenancy owner b");
    h.enroll_and_sync();

    let logs = LogBuffer::new();
    let mut rt = runtime(h.dir.path(), "https://boot.internal/v1");
    let mut journal = h.journal();

    command(
        &a.id,
        &a.client,
        &h.node,
        AdminCommand::SetInferenceEndpoint {
            endpoint: "https://a-host.internal/v1".into(),
            api_key: Some("a-secret-key".into()),
        },
    );
    admin::run(
        &h.node_client,
        &h.state,
        &mut rt,
        &mut control(&h),
        &mut scopes(&h),
        &logs,
        &mut journal,
    )
    .unwrap();

    assert_eq!(rt.marker_for(&hex_ed(&a.id)), "[endpoint: a-host.internal]");
    assert_eq!(
        rt.marker_for(&hex_ed(&b.id)),
        "[endpoint: boot.internal]",
        "B never chose, so B still runs on the operator's default"
    );

    // A's own reply names A's host and never the key A just sent.
    let a_reply = read_admin_replies(&a.client, &a.id).pop().unwrap();
    assert!(a_reply.ok);
    let detail = a_reply.detail.as_deref().unwrap();
    assert!(detail.contains("a-host.internal"));
    assert!(!detail.contains("a-secret-key"), "no key echoed: {detail}");

    // B asks for status and is told about B's endpoint only.
    command(&b.id, &b.client, &h.node, AdminCommand::JobStatus);
    admin::run(
        &h.node_client,
        &h.state,
        &mut rt,
        &mut control(&h),
        &mut scopes(&h),
        &logs,
        &mut journal,
    )
    .unwrap();
    let b_status = read_admin_replies(&b.client, &b.id).pop().unwrap();
    let detail = b_status.detail.as_deref().unwrap();
    assert!(detail.contains("boot.internal"), "B's own endpoint");
    assert!(
        !detail.contains("a-host.internal"),
        "never another owner's host: {detail}"
    );
    assert!(!detail.contains("a-secret-key"), "never a key: {detail}");
}

/// Two endpoint instructions from one owner in a single pass end on the later
/// one, and the superseded device is told so rather than answered `ok`.
///
/// The mailbox hands items over in `HashMap` order, so without the pass's two
/// phases the node lands on the stale endpoint some of the time — and keeps
/// sending that owner's record to a host they had already moved away from,
/// while both devices read `ok: true`.
#[test]
fn the_later_endpoint_instruction_wins_and_the_other_is_told() {
    let h = Harness::new(b"endpoint order node");
    let owner = h.add_owner(b"endpoint order owner");
    h.enroll_and_sync();

    let logs = LogBuffer::new();
    let mut rt = runtime(h.dir.path(), "https://boot.internal/v1");
    let mut journal = h.journal();

    for round in 0..10i64 {
        let (older_host, newer_host) = if round % 2 == 0 {
            ("older.internal", "newer.internal")
        } else {
            ("newer.internal", "older.internal")
        };
        let older_id = command_at(
            &owner.id,
            &owner.client,
            &h.node,
            AdminCommand::SetInferenceEndpoint {
                endpoint: format!("https://{older_host}/v1"),
                api_key: None,
            },
            1_753_000_000_000 + round * 10,
        );
        let newer_id = command_at(
            &owner.id,
            &owner.client,
            &h.node,
            AdminCommand::SetInferenceEndpoint {
                endpoint: format!("https://{newer_host}/v1"),
                api_key: None,
            },
            1_753_000_000_005 + round * 10,
        );

        admin::run(
            &h.node_client,
            &h.state,
            &mut rt,
            &mut control(&h),
            &mut scopes(&h),
            &logs,
            &mut journal,
        )
        .unwrap();

        assert_eq!(
            rt.marker_for(&hex_ed(&owner.id)),
            format!("[endpoint: {newer_host}]"),
            "round {round}: ended on the stale instruction"
        );

        let replies = read_admin_replies(&owner.client, &owner.id);
        let older_reply = replies
            .iter()
            .find(|r| r.in_reply_to == older_id)
            .expect("the superseded command is still answered");
        let newer_reply = replies
            .iter()
            .find(|r| r.in_reply_to == newer_id)
            .expect("the applied command is answered");
        assert!(!older_reply.ok, "round {round}: superseded is not applied");
        assert!(newer_reply.ok, "round {round}: the later one is applied");
        // Both state the endpoint in force, so either device can check rather
        // than take `ok` at its word.
        let marker = format!("[endpoint: {newer_host}]");
        for reply in [older_reply, newer_reply] {
            let detail = reply.detail.as_deref().unwrap_or_default();
            assert!(
                detail.contains(&marker),
                "round {round}: reply states the endpoint in force, got: {detail}"
            );
        }
        for entry in owner.client.list_mailbox().unwrap() {
            owner.client.delete_mailbox(&entry.id).unwrap();
        }
    }
}

/// An endpoint command and a scope command in the same pass are independent
/// instructions: neither supersedes the other, and both apply.
#[test]
fn an_endpoint_command_does_not_supersede_a_scope_command() {
    let h = Harness::new(b"two class node");
    let owner = h.add_owner(b"two class owner");
    h.enroll_and_sync();

    let logs = LogBuffer::new();
    let mut rt = runtime(h.dir.path(), "https://boot.internal/v1");
    let mut journal = h.journal();
    let mut sc = scopes(&h);

    let scope_id = command_at(
        &owner.id,
        &owner.client,
        &h.node,
        AdminCommand::SetAnswerScope {
            include: vec!["cycle".into()],
        },
        1_753_000_000_000,
    );
    let endpoint_id = command_at(
        &owner.id,
        &owner.client,
        &h.node,
        AdminCommand::SetInferenceEndpoint {
            endpoint: "https://mine.internal/v1".into(),
            api_key: None,
        },
        1_753_000_000_005,
    );

    admin::run(
        &h.node_client,
        &h.state,
        &mut rt,
        &mut control(&h),
        &mut sc,
        &logs,
        &mut journal,
    )
    .unwrap();

    let replies = read_admin_replies(&owner.client, &owner.id);
    for id in [&scope_id, &endpoint_id] {
        let reply = replies.iter().find(|r| &r.in_reply_to == id).unwrap();
        assert!(reply.ok, "both applied, got: {:?}", reply.detail);
    }
    assert_eq!(
        rt.marker_for(&hex_ed(&owner.id)),
        "[endpoint: mine.internal]"
    );
    let cycle = app_local_entry(&owner.id, "cycle-start", "Period start", "2026-01-05");
    assert!(sc.scope(&hex_ed(&owner.id)).allows(&cycle.event));
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
    let report = admin::run(
        &h.node_client,
        &h.state,
        &mut rt,
        &mut control(&h),
        &mut scopes(&h),
        &logs,
        &mut journal,
    )
    .unwrap();
    assert_eq!(
        report.dropped, 1,
        "design §2: commands only from enrolled owners"
    );
    assert_eq!(report.replied, 0);
    assert!(read_admin_replies(&stranger_client, &stranger).is_empty());
}

/// The admin tests drive commands, not the reading gate; each gets a control
/// rooted in the harness's own data dir, with the shipped defaults.
fn control(h: &Harness) -> OcrControl {
    OcrControl::load(h.dir.path(), OcrSettings::default())
}

/// Likewise for the answer scope: rooted in the harness's data dir, so a test
/// that sets one reads the same state back on the next pass.
fn scopes(h: &Harness) -> AnswerScopeControl {
    AnswerScopeControl::load(h.dir.path())
}

/// The trust rule made true in effect, not just in authorization: an owner's
/// `pause_ocr` stops the node reading *their* pages. Anyone else it serves keeps
/// reading, is told so by `job_status`, and could never have been paused by
/// someone else's command in the first place.
#[test]
fn pausing_is_scoped_to_the_owner_who_sent_the_command() {
    let h = Harness::new(b"admin node pause");
    let a = h.add_owner(b"admin owner pause a");
    let b = h.add_owner(b"admin owner pause b");
    h.enroll_and_sync();

    let logs = LogBuffer::new();
    let mut journal = h.journal();
    // An operator who opted this deployment in: both owners read until one of
    // them says otherwise.
    let mut control = OcrControl::load(
        h.dir.path(),
        OcrSettings {
            default_paused: false,
            ..Default::default()
        },
    );

    // Pass one: A pauses. (Two passes, so the pause is certainly applied before
    // the status commands below are answered — the mailbox drain order is the
    // relay's business, not this test's.)
    command(&a.id, &a.client, &h.node, AdminCommand::PauseOcr);
    let mut rt = runtime(h.dir.path(), "https://inference.internal/v1");
    admin::run(
        &h.node_client,
        &h.state,
        &mut rt,
        &mut control,
        &mut scopes(&h),
        &logs,
        &mut journal,
    )
    .unwrap();

    let pause_reply = read_admin_replies(&a.client, &a.id);
    assert_eq!(pause_reply.len(), 1);
    assert!(pause_reply[0].ok);
    let detail = pause_reply[0].detail.as_deref().unwrap();
    assert!(
        detail.contains("your vault") && detail.contains("unaffected"),
        "the reply has to make the scope plain, got: {detail}"
    );
    assert!(
        read_admin_replies(&b.client, &b.id).is_empty(),
        "B was not part of this exchange at all"
    );

    // Pass two: both ask for status.
    command(&a.id, &a.client, &h.node, AdminCommand::JobStatus);
    command(&b.id, &b.client, &h.node, AdminCommand::JobStatus);
    admin::run(
        &h.node_client,
        &h.state,
        &mut rt,
        &mut control,
        &mut scopes(&h),
        &logs,
        &mut journal,
    )
    .unwrap();

    let a_status = status_detail(&a.client, &a.id);
    assert!(
        a_status.contains("ocr: paused by you"),
        "A is told whose pause it is, so it knows it can undo it, got: {a_status}"
    );
    let b_status = status_detail(&b.client, &b.id);
    assert!(
        b_status.contains("ocr: reading"),
        "B's reading is untouched by A's pause, got: {b_status}"
    );
}

/// The `job_status` reply's detail (the one reply carrying vault counts).
fn status_detail(owner_client: &RelayClient, owner: &Identity) -> String {
    read_admin_replies(owner_client, owner)
        .into_iter()
        .filter_map(|r| r.detail)
        .find(|d| d.contains("vault: events="))
        .expect("a job_status reply")
}

// ---- answer scope (opt-in entries) ----

/// A cycle or mind entry: a coded observation in the app-local
/// `urn:svastha:codes` system, which is what makes it sensitive on both the node
/// and the device.
fn app_local_entry(owner: &Identity, code: &str, display: &str, date: &str) -> SignedEvent {
    owner.sign_event(Event::new(
        EventKind::Observation,
        Some(Code {
            system: "urn:svastha:codes".into(),
            code: code.into(),
            display: Some(display.into()),
        }),
        Some(date.into()),
        None,
        Provenance {
            source: "self".into(),
            source_doc: None,
        },
    ))
}

/// The whole feature in one exchange: a question only a cycle entry could answer
/// is refused — **without an inference call** — until the owner opts cycle in,
/// and answered with a citation once they have. The opt-in persists across the
/// pass that applies it, so "effective next pass" is what is actually asserted.
#[test]
fn set_answer_scope_gates_what_an_answer_can_draw_from() {
    let (base, calls) = spawn_inference(Mode::Ok(
        r#"{"answer":"Your last period started on the 5th.","used":[1]}"#.into(),
    ));
    let inf = inference_client(&base);

    let h = Harness::new(b"scope node one");
    let owner = h.add_owner(b"scope owner one");
    let period = app_local_entry(&owner.id, "cycle-start", "Period start", "2026-01-05");
    put_event(&owner.client, &owner.ring, &owner.id, &period);
    h.enroll_and_sync();

    // Default: excluded. The endpoint is never called at all.
    ask(
        &owner.id,
        &owner.client,
        &h.node,
        "when did my period start?",
    );
    let mut journal = h.journal();
    let report = chat::run(&h.node_client, &h.state, &inf, &scopes(&h), &mut journal).unwrap();
    assert_eq!(report.cant_answer, 1, "honest refusal, not a guess");
    assert_eq!(
        calls.load(Ordering::SeqCst),
        0,
        "an excluded entry must not reach the endpoint — not even as context"
    );
    let answers = read_chat_answers(&owner.client, &owner.id);
    assert_eq!(answers.len(), 1);
    assert!(answers[0].citations.is_empty());

    // The owner opts cycle in.
    let cmd_id = command(
        &owner.id,
        &owner.client,
        &h.node,
        AdminCommand::SetAnswerScope {
            include: vec!["cycle".into()],
        },
    );
    let logs = LogBuffer::new();
    let mut rt = runtime(h.dir.path(), "https://inference.internal/v1");
    admin::run(
        &h.node_client,
        &h.state,
        &mut rt,
        &mut control(&h),
        &mut scopes(&h),
        &logs,
        &mut journal,
    )
    .unwrap();

    let reply = read_admin_replies(&owner.client, &owner.id)
        .into_iter()
        .find(|r| r.in_reply_to == cmd_id)
        .expect("a reply to the scope command");
    assert!(reply.ok);
    let detail = reply.detail.as_deref().unwrap();
    assert!(
        detail.contains("Cycle") && detail.contains("your vault") && detail.contains("unaffected"),
        "the reply states the resulting scope and its reach, got: {detail}"
    );

    // Next pass: the same question is answered, and cited.
    ask(
        &owner.id,
        &owner.client,
        &h.node,
        "when did my period start?",
    );
    let report = chat::run(&h.node_client, &h.state, &inf, &scopes(&h), &mut journal).unwrap();
    assert_eq!(report.answered, 1);
    assert_eq!(calls.load(Ordering::SeqCst), 1, "now the endpoint is asked");
    let cited = read_chat_answers(&owner.client, &owner.id)
        .into_iter()
        .find(|a| !a.citations.is_empty())
        .expect("a grounded answer");
    assert_eq!(cited.citations, vec![period.event.id.to_hex()]);
}

/// Two owners, two choices. A's opt-in cannot open B's entries, which is the
/// same rule pausing follows — and the reason the command is owner-scoped rather
/// than a node setting.
#[test]
fn an_opt_in_is_scoped_to_the_owner_who_sent_it() {
    let (base, calls) = spawn_inference(Mode::Ok(r#"{"answer":"steady","used":[1]}"#.into()));
    let inf = inference_client(&base);

    let h = Harness::new(b"scope node two");
    let a = h.add_owner(b"scope owner two a");
    let b = h.add_owner(b"scope owner two b");
    let a_mood = app_local_entry(&a.id, "mood", "Mood", "2026-01-05");
    let b_mood = app_local_entry(&b.id, "mood", "Mood", "2026-01-05");
    put_event(&a.client, &a.ring, &a.id, &a_mood);
    put_event(&b.client, &b.ring, &b.id, &b_mood);
    h.enroll_and_sync();

    command(
        &a.id,
        &a.client,
        &h.node,
        AdminCommand::SetAnswerScope {
            include: vec!["mind".into()],
        },
    );
    let logs = LogBuffer::new();
    let mut rt = runtime(h.dir.path(), "https://inference.internal/v1");
    let mut journal = h.journal();
    admin::run(
        &h.node_client,
        &h.state,
        &mut rt,
        &mut control(&h),
        &mut scopes(&h),
        &logs,
        &mut journal,
    )
    .unwrap();

    ask(&a.id, &a.client, &h.node, "how has my mood been?");
    ask(&b.id, &b.client, &h.node, "how has my mood been?");
    let report = chat::run(&h.node_client, &h.state, &inf, &scopes(&h), &mut journal).unwrap();
    assert_eq!(report.answered, 1, "only A's question retrieves anything");
    assert_eq!(report.cant_answer, 1, "B's mood entries are still out");
    assert_eq!(calls.load(Ordering::SeqCst), 1, "one endpoint call, A's");

    assert_eq!(
        read_chat_answers(&a.client, &a.id)[0].citations,
        vec![a_mood.event.id.to_hex()]
    );
    assert!(
        read_chat_answers(&b.client, &b.id)[0].citations.is_empty(),
        "one household's opt-in must not open another's entries"
    );
}

/// An unrecognized category name is answered honestly and changes nothing — the
/// additive-set rule applied one level down, to a command's *argument*. Silently
/// dropping it would leave the app showing a switch the node ignores.
#[test]
fn an_unknown_category_is_refused_and_leaves_the_scope_alone() {
    let h = Harness::new(b"scope node three");
    let owner = h.add_owner(b"scope owner three");
    h.enroll_and_sync();

    let logs = LogBuffer::new();
    let mut rt = runtime(h.dir.path(), "https://inference.internal/v1");
    let mut journal = h.journal();

    command(
        &owner.id,
        &owner.client,
        &h.node,
        AdminCommand::SetAnswerScope {
            include: vec!["cycle".into()],
        },
    );
    admin::run(
        &h.node_client,
        &h.state,
        &mut rt,
        &mut control(&h),
        &mut scopes(&h),
        &logs,
        &mut journal,
    )
    .unwrap();

    let bad = command(
        &owner.id,
        &owner.client,
        &h.node,
        AdminCommand::SetAnswerScope {
            include: vec!["mind".into(), "dreams".into()],
        },
    );
    let report = admin::run(
        &h.node_client,
        &h.state,
        &mut rt,
        &mut control(&h),
        &mut scopes(&h),
        &logs,
        &mut journal,
    )
    .unwrap();
    assert_eq!(report.replied, 1, "answered, not dropped");

    let reply = read_admin_replies(&owner.client, &owner.id)
        .into_iter()
        .find(|r| r.in_reply_to == bad)
        .expect("a reply to the bad command");
    assert!(!reply.ok, "ok:false rather than acting on a guess");
    assert!(reply.detail.as_deref().unwrap().contains("dreams"));

    // And the previous choice stands: cycle in, mind still out.
    command(&owner.id, &owner.client, &h.node, AdminCommand::JobStatus);
    admin::run(
        &h.node_client,
        &h.state,
        &mut rt,
        &mut control(&h),
        &mut scopes(&h),
        &logs,
        &mut journal,
    )
    .unwrap();
    let status = status_detail(&owner.client, &owner.id);
    assert!(
        status.contains("Cycle") && !status.contains("Mind"),
        "job_status reports the scope the owner actually has, got: {status}"
    );
}

/// A command from a newer app is **answered**, not dropped. This is what makes
/// the spec's additive-set sentence true: before the catch-all variant, an
/// unrecognized `cmd` tag failed to deserialize and the envelope was dropped
/// with no reply, which an owner cannot tell apart from an offline node — and
/// which, for a privacy switch, means believing a setting applied when it never
/// arrived.
#[test]
fn a_command_this_node_does_not_know_is_answered_rather_than_dropped() {
    let h = Harness::new(b"admin node unknown");
    let owner = h.add_owner(b"admin owner unknown");
    h.enroll_and_sync();

    // Deposited as raw JSON: this build has no variant for it, which is exactly
    // the version-skew case being reproduced.
    let body =
        serde_json::json!({ "command": { "cmd": "set_dream_scope", "include": ["dreams"] } });
    let envelope = MailboxMessage::seal(
        &owner.id,
        &h.node.x25519_public(),
        MessageKind::AdminCmd,
        1_753_000_300_000,
        &serde_json::to_vec(&body).unwrap(),
    );
    let cmd_id = envelope.id_hex();
    owner
        .client
        .put_mailbox(
            &hex_ed(&h.node),
            &format!("admin-{cmd_id}"),
            &serde_json::to_vec(&envelope).unwrap(),
        )
        .unwrap();

    let logs = LogBuffer::new();
    let mut rt = runtime(h.dir.path(), "https://inference.internal/v1");
    let mut journal = h.journal();
    let report = admin::run(
        &h.node_client,
        &h.state,
        &mut rt,
        &mut control(&h),
        &mut scopes(&h),
        &logs,
        &mut journal,
    )
    .unwrap();
    assert_eq!(report.replied, 1, "answered");
    assert_eq!(report.dropped, 0, "not silently dropped");

    let reply = read_admin_replies(&owner.client, &owner.id)
        .into_iter()
        .find(|r| r.in_reply_to == cmd_id)
        .expect("the sender gets a reply it can match to its command");
    assert!(!reply.ok);
    assert!(
        reply.detail.as_deref().unwrap().contains("does not know"),
        "and the reason says the node is the old half, got: {:?}",
        reply.detail
    );
}

/// Two scope instructions from one owner in a single pass must end on the
/// **later** one, whichever order the mailbox happens to hand them over.
///
/// The relay's mailbox lists items from a `HashMap`, so arrival order is not
/// stable between passes — which is exactly how this defect hides: the node ends
/// on the stale instruction only sometimes, and both commands answer `ok: true`
/// either way, so nothing looks wrong. For a switch that governs disclosure,
/// "usually applies your last instruction" is not a property worth having.
///
/// Twenty rounds, alternating which set is the newer one, so a stale-wins bug
/// cannot hide behind a starting state that already matches.
#[test]
fn the_later_scope_instruction_wins_whatever_order_it_arrives_in() {
    let h = Harness::new(b"scope order node");
    let owner = h.add_owner(b"scope order owner");
    h.enroll_and_sync();

    let logs = LogBuffer::new();
    let mut rt = runtime(h.dir.path(), "https://inference.internal/v1");
    let mut journal = h.journal();
    let mut sc = scopes(&h);
    let mood = app_local_entry(&owner.id, "mood", "Mood", "2026-01-05");
    let cycle = app_local_entry(&owner.id, "cycle-start", "Period start", "2026-01-05");

    for round in 0..20i64 {
        // Alternate, so each round's expected end state differs from the last.
        let (older, newer): (Vec<String>, Vec<String>) = if round % 2 == 0 {
            (vec!["cycle".into()], vec!["mind".into()])
        } else {
            (vec!["mind".into()], vec!["cycle".into()])
        };

        let older_id = command_at(
            &owner.id,
            &owner.client,
            &h.node,
            AdminCommand::SetAnswerScope {
                include: older.clone(),
            },
            1_753_000_000_000 + round * 10,
        );
        let newer_id = command_at(
            &owner.id,
            &owner.client,
            &h.node,
            AdminCommand::SetAnswerScope {
                include: newer.clone(),
            },
            1_753_000_000_005 + round * 10,
        );

        let report = admin::run(
            &h.node_client,
            &h.state,
            &mut rt,
            &mut control(&h),
            &mut sc,
            &logs,
            &mut journal,
        )
        .unwrap();
        assert_eq!(report.replied, 2, "both are answered (round {round})");

        // Both are answered, but only the applied one answers `ok` — `ok` means
        // applied, and the device whose instruction lost must be able to tell.
        let replies = read_admin_replies(&owner.client, &owner.id);
        let older_reply = replies
            .iter()
            .find(|r| r.in_reply_to == older_id)
            .expect("the superseded command is still answered");
        let newer_reply = replies
            .iter()
            .find(|r| r.in_reply_to == newer_id)
            .expect("the applied command is answered");
        assert!(!older_reply.ok, "round {round}: superseded is not applied");
        assert!(newer_reply.ok, "round {round}: the later one is applied");
        // And both state the same in-force scope, so either device can check.
        let marker = format!("[scope: {}]", newer.join(","));
        for reply in [older_reply, newer_reply] {
            let detail = reply.detail.as_deref().unwrap_or_default();
            assert!(
                detail.contains(&marker),
                "round {round}: reply states the scope in force, got: {detail}"
            );
        }

        let scope = sc.scope(&hex_ed(&owner.id));
        let ends_on_mind = scope.allows(&mood.event);
        let ends_on_cycle = scope.allows(&cycle.event);
        if newer == vec!["mind".to_string()] {
            assert!(
                ends_on_mind && !ends_on_cycle,
                "round {round}: ended on the stale instruction"
            );
        } else {
            assert!(
                ends_on_cycle && !ends_on_mind,
                "round {round}: ended on the stale instruction"
            );
        }
    }
}

/// What the node tells each device when two of an owner's scope instructions
/// land in one pass.
///
/// `ok` on this wire means **applied**. A skipped command answered `ok: true`
/// broke that: the device whose instruction lost was told, in the only field it
/// could check, that its scope was in force — while the node was enforcing the
/// other device's. So a skipped command answers `ok: false`, and every reply
/// states the scope now in force in a form the client can parse and compare, so
/// a device verifies rather than trusts.
#[test]
fn a_superseded_scope_command_is_not_reported_as_applied() {
    let h = Harness::new(b"scope reply node");
    let owner = h.add_owner(b"scope reply owner");
    h.enroll_and_sync();

    // Device A asks for Cycle on; device B, later, asks for nothing.
    let a = command_at(
        &owner.id,
        &owner.client,
        &h.node,
        AdminCommand::SetAnswerScope {
            include: vec!["cycle".into()],
        },
        1_753_000_000_000,
    );
    let b = command_at(
        &owner.id,
        &owner.client,
        &h.node,
        AdminCommand::SetAnswerScope { include: vec![] },
        1_753_000_000_005,
    );

    let logs = LogBuffer::new();
    let mut rt = runtime(h.dir.path(), "https://inference.internal/v1");
    let mut journal = h.journal();
    let mut sc = scopes(&h);
    admin::run(
        &h.node_client,
        &h.state,
        &mut rt,
        &mut control(&h),
        &mut sc,
        &logs,
        &mut journal,
    )
    .unwrap();

    let replies = read_admin_replies(&owner.client, &owner.id);
    let reply_a = replies
        .iter()
        .find(|r| r.in_reply_to == a)
        .expect("A is answered");
    let reply_b = replies
        .iter()
        .find(|r| r.in_reply_to == b)
        .expect("B is answered");

    // A lost. It must not be able to read its reply as "applied".
    assert!(
        !reply_a.ok,
        "a command that was not applied cannot answer ok: true"
    );
    // B won.
    assert!(reply_b.ok);

    // Both state the scope actually in force, so either device can compare it
    // with what it asked for rather than trusting a boolean.
    for reply in [reply_a, reply_b] {
        let detail = reply.detail.as_deref().unwrap_or_default();
        assert!(
            detail.contains("[scope: none]"),
            "reply states the scope in force, got: {detail}"
        );
    }
    // And the scope really is B's.
    let mood = app_local_entry(&owner.id, "mood", "Mood", "2026-01-05");
    let cycle = app_local_entry(&owner.id, "cycle-start", "Period start", "2026-01-05");
    let scope = sc.scope(&hex_ed(&owner.id));
    assert!(!scope.allows(&mood.event) && !scope.allows(&cycle.event));
}

/// An applied command echoes what it applied, not merely that it worked.
#[test]
fn an_applied_scope_command_states_the_scope_it_put_in_force() {
    let h = Harness::new(b"scope echo node");
    let owner = h.add_owner(b"scope echo owner");
    h.enroll_and_sync();

    let id = command(
        &owner.id,
        &owner.client,
        &h.node,
        AdminCommand::SetAnswerScope {
            include: vec!["cycle".into(), "mind".into()],
        },
    );
    let logs = LogBuffer::new();
    let mut rt = runtime(h.dir.path(), "https://inference.internal/v1");
    let mut journal = h.journal();
    admin::run(
        &h.node_client,
        &h.state,
        &mut rt,
        &mut control(&h),
        &mut scopes(&h),
        &logs,
        &mut journal,
    )
    .unwrap();

    let reply = read_admin_replies(&owner.client, &owner.id)
        .into_iter()
        .find(|r| r.in_reply_to == id)
        .expect("answered");
    assert!(reply.ok);
    let detail = reply.detail.as_deref().unwrap();
    assert!(
        detail.contains("[scope: cycle,mind]"),
        "echoes the applied set in a parseable form, got: {detail}"
    );
}
