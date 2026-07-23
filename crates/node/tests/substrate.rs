//! Integration tests for the node substrate against the **real relay crate**,
//! served in-process on an ephemeral port (the same pattern the devtool test
//! uses). The owner side stands in for the PWA: it seeds a sealed vault, grants
//! the node, and deposits a `key_handoff`; then the node's own enrolment and sync
//! code runs against the live wire API.

use std::sync::mpsc;
use std::sync::Arc;
use std::sync::Mutex;
use std::time::Duration;

use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use sha2::{Digest, Sha256};
use svastha_core::curation::SignedCurationRecord;
use svastha_core::envelope::DataKey;
use svastha_core::event::{Code, Event, EventKind, Provenance, SignedEvent};
use svastha_core::keyring::Keyring;
use svastha_core::keys::Identity;
use svastha_core::mailbox::{KeyHandoffBody, MailboxMessage, MessageKind};

use svastha_node::cache::Cache;
use svastha_node::client::RelayClient;
use svastha_node::poke::Poke;
use svastha_node::state::NodeState;
use svastha_node::sync::{consume_mailbox, sync_all, sync_owner};

use svastha_relay::grants::MemoryGrantStore;
use svastha_relay::mailbox::MemoryMailboxStore;
use svastha_relay::share::MemoryShareStore;
use svastha_relay::store::MemoryStore;

/// Start `svastha_relay::app` on an OS-assigned port; return its base URL. Runs on
/// a dedicated thread with its own runtime for the life of the test process.
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

fn hex_ed(id: &Identity) -> String {
    hex::encode(id.verifying_key().to_bytes())
}

/// A medication event with an RxNorm code, signed by `owner`.
fn med(owner: &Identity, rxnorm: &str, effective: &str) -> SignedEvent {
    owner.sign_event(Event::new(
        EventKind::MedicationStatement,
        Some(Code {
            system: "http://www.nlm.nih.gov/research/umls/rxnorm".into(),
            code: rxnorm.into(),
            display: None,
        }),
        Some(effective.into()),
        None,
        Provenance {
            source: "import".into(),
            source_doc: None,
        },
    ))
}

/// Seal a signed event under `ring` (as `owner`) and PUT it as `owner`.
fn put_event(client: &RelayClient, ring: &Keyring, owner: &Identity, signed: &SignedEvent) {
    let blob_id = format!("ev-{}", signed.event.id.to_hex());
    let plaintext = serde_json::to_vec(signed).unwrap();
    let sealed = ring
        .seal_blob(owner, blob_id.as_bytes(), &plaintext)
        .unwrap();
    client.put_blob(&blob_id, &sealed).unwrap();
}

/// Seal and PUT a signed curation record under `ring`.
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
    let plaintext = serde_json::to_vec(rec).unwrap();
    let sealed = ring
        .seal_blob(owner, blob_id.as_bytes(), &plaintext)
        .unwrap();
    client.put_blob(&blob_id, &sealed).unwrap();
}

/// Seal and PUT an attachment blob (`{mime, bytes}`) under `ring`. Returns its
/// content hash.
fn put_attachment(client: &RelayClient, ring: &Keyring, owner: &Identity, raw: &[u8]) -> String {
    let sha = hex::encode(Sha256::digest(raw));
    let blob_id = format!("att-{sha}");
    let body = serde_json::json!({ "mime": "image/jpeg", "bytes": BASE64.encode(raw) });
    let plaintext = serde_json::to_vec(&body).unwrap();
    let sealed = ring
        .seal_blob(owner, blob_id.as_bytes(), &plaintext)
        .unwrap();
    client.put_blob(&blob_id, &sealed).unwrap();
    sha
}

/// Grant the node prefix-scoped read (ev-/att-/doc-/cur-), as the design specifies.
fn grant_node(owner_client: &RelayClient, node: &Identity) {
    let scope = br#"{"prefixes":["ev-","att-","doc-","cur-"]}"#;
    owner_client.put_grant(&hex_ed(node), Some(scope)).unwrap();
}

/// Wrap `ring` for the node and deposit it as a `key_handoff` into the node's
/// mailbox — the PWA's role. `owner_client` signs the deposit as the owner, so the
/// relay's `svastha-from` attests the owner.
fn deposit_handoff(
    owner_client: &RelayClient,
    owner: &Identity,
    node: &Identity,
    ring: &Keyring,
    item_id: &str,
) {
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
            item_id,
            &serde_json::to_vec(&envelope).unwrap(),
        )
        .unwrap();
}

#[test]
fn enrolls_and_syncs_a_sealed_vault() {
    let base = spawn_relay();
    let owner = Identity::from_seed(b"owner one");
    let node = Identity::from_seed(b"processing node");
    let owner_client = RelayClient::new(base.clone(), Arc::new(Identity::from_seed(b"owner one")));
    let node_client = RelayClient::new(
        base.clone(),
        Arc::new(Identity::from_seed(b"processing node")),
    );

    // Owner's genesis keyring; seal a vault under it.
    let data_key = DataKey::generate();
    let ring = Keyring::genesis(&owner.x25519_public(), &data_key);
    let a = med(&owner, "197361", "2025-01-01T00:00:00Z");
    let b = med(&owner, "310798", "2025-06-01T00:00:00Z");
    put_event(&owner_client, &ring, &owner, &a);
    put_event(&owner_client, &ring, &owner, &b);
    // Owner marks the first medication past (status: curation).
    let concept = svastha_node::index::VaultIndex::concept_key(&a.event).unwrap();
    let status = owner.sign_curation(
        format!("status:{concept}"),
        serde_json::json!({"status":"inactive"}),
        1_000,
    );
    put_curation(&owner_client, &ring, &owner, &status);
    // A tag curation record the node must ignore by convention.
    let tag = owner.sign_curation("tag:ev-1".into(), serde_json::json!({"tags":["x"]}), 1_000);
    put_curation(&owner_client, &ring, &owner, &tag);
    // A captured attachment.
    let sha = put_attachment(&owner_client, &ring, &owner, b"fake jpeg bytes");

    grant_node(&owner_client, &node);
    deposit_handoff(&owner_client, &owner, &node, &ring, "kh-1");

    // Node enrols, then syncs.
    let state = Mutex::new(NodeState::new());
    let cache = Cache::new(tempfile::tempdir().unwrap().path().to_path_buf());
    let enroll = consume_mailbox(&node_client, &state).unwrap();
    assert_eq!(
        enroll.newly_enrolled, 1,
        "the key_handoff should enrol the owner"
    );

    let reports = sync_all(&node_client, &cache, &state).unwrap();
    assert_eq!(reports.len(), 1);
    let (owner_hex, r) = &reports[0];
    assert_eq!(*owner_hex, hex_ed(&owner));
    assert!(r.granted);
    assert_eq!(r.events, 2, "both events indexed");
    assert_eq!(r.curation_applied, 1, "only the status: record applied");
    assert_eq!(
        r.curation_ignored, 1,
        "the tag: record ignored by convention"
    );
    assert_eq!(r.attachments, 1);
    assert_eq!(r.dropped, 0);

    // The index honours the owner's current-vs-past curation.
    let guard = state.lock().unwrap();
    let idx = &guard.owner(&hex_ed(&owner)).unwrap().index;
    assert_eq!(idx.event_count(), 2);
    assert_eq!(
        idx.concept_status(&concept),
        svastha_node::index::ConceptStatus::Inactive,
        "the owner marked this medication past"
    );
    let concept_b = svastha_node::index::VaultIndex::concept_key(&b.event).unwrap();
    assert_eq!(
        idx.concept_status(&concept_b),
        svastha_node::index::ConceptStatus::Active,
        "the other medication defaults to current"
    );
    assert!(
        idx.attachment(&sha).is_some(),
        "attachment metadata indexed"
    );
}

#[test]
fn drops_a_tampered_blob() {
    let base = spawn_relay();
    let owner = Identity::from_seed(b"owner two");
    let node = Identity::from_seed(b"node two");
    let owner_client = RelayClient::new(base.clone(), Arc::new(Identity::from_seed(b"owner two")));
    let node_client = RelayClient::new(base.clone(), Arc::new(Identity::from_seed(b"node two")));

    let data_key = DataKey::generate();
    let ring = Keyring::genesis(&owner.x25519_public(), &data_key);

    // One good event, one whose ciphertext is corrupted after sealing.
    let good = med(&owner, "197361", "2025-01-01T00:00:00Z");
    put_event(&owner_client, &ring, &owner, &good);

    let bad = med(&owner, "310798", "2025-02-01T00:00:00Z");
    let bad_id = format!("ev-{}", bad.event.id.to_hex());
    let mut sealed = ring
        .seal_blob(
            &owner,
            bad_id.as_bytes(),
            &serde_json::to_vec(&bad).unwrap(),
        )
        .unwrap();
    let last = sealed.len() - 1;
    sealed[last] ^= 0x01; // flip a ciphertext byte: the AEAD tag no longer verifies
    owner_client.put_blob(&bad_id, &sealed).unwrap();

    grant_node(&owner_client, &node);
    deposit_handoff(&owner_client, &owner, &node, &ring, "kh-1");

    let state = Mutex::new(NodeState::new());
    let cache = Cache::new(tempfile::tempdir().unwrap().path().to_path_buf());
    consume_mailbox(&node_client, &state).unwrap();
    let r = sync_owner(&node_client, &cache, &state, &hex_ed(&owner)).unwrap();

    assert_eq!(r.events, 1, "only the intact event is indexed");
    assert_eq!(r.dropped, 1, "the tampered blob is dropped, not indexed");
}

#[test]
fn keyring_merges_on_rotation_redelivery() {
    let base = spawn_relay();
    let owner = Identity::from_seed(b"owner three");
    let node = Identity::from_seed(b"node three");
    let owner_client =
        RelayClient::new(base.clone(), Arc::new(Identity::from_seed(b"owner three")));
    let node_client = RelayClient::new(base.clone(), Arc::new(Identity::from_seed(b"node three")));

    // Genesis vault + one event under the genesis epoch.
    let data_key = DataKey::generate();
    let genesis = Keyring::genesis(&owner.x25519_public(), &data_key);
    let old = med(&owner, "197361", "2025-01-01T00:00:00Z");
    put_event(&owner_client, &genesis, &owner, &old);

    grant_node(&owner_client, &node);
    deposit_handoff(&owner_client, &owner, &node, &genesis, "kh-1");

    let state = Mutex::new(NodeState::new());
    let cache = Cache::new(tempfile::tempdir().unwrap().path().to_path_buf());
    consume_mailbox(&node_client, &state).unwrap();
    let r1 = sync_owner(&node_client, &cache, &state, &hex_ed(&owner)).unwrap();
    assert_eq!(r1.events, 1);

    // Rotate: a fresh epoch, a new event sealed under it (marked AAD).
    let (rotated, _new_key) = genesis.rotate(&owner.x25519_public(), 1_753_000_100_000);
    let fresh = med(&owner, "310798", "2026-01-01T00:00:00Z");
    put_event(&owner_client, &rotated, &owner, &fresh);

    // Re-deliver the rotated keyring: the node merges it (union) and keeps working.
    deposit_handoff(&owner_client, &owner, &node, &rotated, "kh-2");
    let enroll = consume_mailbox(&node_client, &state).unwrap();
    // The node leaves consumed handoffs in place (its durable enrolment record), so
    // this drain re-reads kh-1 and kh-2 — both merge into the already-enrolled
    // owner (union is idempotent), and nothing re-enrols.
    assert_eq!(enroll.newly_enrolled, 0, "re-delivery never re-enrols");
    assert!(enroll.keyrings_merged >= 1, "the rotated ring is merged in");

    let r2 = sync_owner(&node_client, &cache, &state, &hex_ed(&owner)).unwrap();
    assert_eq!(
        r2.dropped, 0,
        "the post-rotation blob opens under the merged ring"
    );

    let guard = state.lock().unwrap();
    let idx = &guard.owner(&hex_ed(&owner)).unwrap().index;
    // Both the genesis-epoch event and the rotated-epoch event are indexed.
    assert_eq!(idx.event_count(), 2);
    assert!(idx.event(&old.event.id.to_hex()).is_some());
    assert!(idx.event(&fresh.event.id.to_hex()).is_some());
}

#[test]
fn legacy_bare_wrapped_key_deposit_enrolls() {
    // Grandfathering: a pre-envelope bare wrapped-key deposit still enrols the node
    // (read as a one-epoch genesis keyring).
    let base = spawn_relay();
    let owner = Identity::from_seed(b"owner four");
    let node = Identity::from_seed(b"node four");
    let owner_client = RelayClient::new(base.clone(), Arc::new(Identity::from_seed(b"owner four")));
    let node_client = RelayClient::new(base.clone(), Arc::new(Identity::from_seed(b"node four")));

    let data_key = DataKey::generate();
    let ring = Keyring::genesis(&owner.x25519_public(), &data_key);
    let ev = med(&owner, "197361", "2025-01-01T00:00:00Z");
    put_event(&owner_client, &ring, &owner, &ev);
    grant_node(&owner_client, &node);

    // The bare (pre-envelope) deposit: a single wrapped key, no signed envelope.
    let for_node = ring
        .wrap_for_grantee(&owner, &node.x25519_public())
        .unwrap();
    // wrap_for_grantee on a genesis ring yields a one-epoch keyring; its container
    // bytes are what a modern deposit carries, but the legacy shape wraps the bare
    // key. Extract the single epoch's wrapped bytes for the legacy field.
    let wrapped_hex = hex::encode(for_node.entries()[0].wrapped_bytes());
    let legacy = serde_json::json!({
        "v": 1,
        "from_ed": hex_ed(&owner),
        "from_x25519": hex::encode(owner.x25519_public().as_bytes()),
        "label": "old app",
        "wrapped_hex": wrapped_hex,
    });
    owner_client
        .put_mailbox(
            &hex_ed(&node),
            "legacy-1",
            &serde_json::to_vec(&legacy).unwrap(),
        )
        .unwrap();

    let state = Mutex::new(NodeState::new());
    let cache = Cache::new(tempfile::tempdir().unwrap().path().to_path_buf());
    let enroll = consume_mailbox(&node_client, &state).unwrap();
    assert_eq!(enroll.newly_enrolled, 1, "the legacy deposit enrols");
    let r = sync_owner(&node_client, &cache, &state, &hex_ed(&owner)).unwrap();
    assert_eq!(r.events, 1);
}

#[test]
fn sse_poke_signals_a_mailbox_deposit() {
    let base = spawn_relay();
    let owner = Identity::from_seed(b"owner five");
    let node = Identity::from_seed(b"node five");
    let owner_client = RelayClient::new(base.clone(), Arc::new(Identity::from_seed(b"owner five")));
    let node_client = Arc::new(RelayClient::new(
        base.clone(),
        Arc::new(Identity::from_seed(b"node five")),
    ));

    // Node opens its poke stream first (pokes are lossy — subscribe before the
    // change that fires one).
    let (tx, rx) = mpsc::channel::<Poke>();
    let stream_client = node_client.clone();
    std::thread::spawn(move || {
        let _ = stream_client.stream_pokes(|poke| {
            let _ = tx.send(poke);
        });
    });
    // Give the stream a moment to connect before depositing.
    std::thread::sleep(Duration::from_millis(400));

    // Owner deposits a key_handoff into the node's mailbox → relay pokes the node.
    let data_key = DataKey::generate();
    let ring = Keyring::genesis(&owner.x25519_public(), &data_key);
    deposit_handoff(&owner_client, &owner, &node, &ring, "kh-1");

    let poke = rx
        .recv_timeout(Duration::from_secs(3))
        .expect("a mailbox poke should arrive after the deposit");
    assert_eq!(poke, Poke::Mailbox);
}
