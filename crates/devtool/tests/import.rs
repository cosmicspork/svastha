//! Drives `svastha_devtool::import_run` against a real in-process relay
//! (`svastha_relay::app` over an ephemeral TCP port), seeded through the same
//! signed-request path a client would use. The document is the committed
//! `fixtures/ccda/minimal-ccd.xml`; a subset of the events it derives is
//! pre-seeded so the run has real dups to skip and real gaps to fill.

use std::collections::HashSet;
use std::sync::Arc;

use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use sha2::{Digest, Sha256};
use svastha_core::envelope::{wrap_key, DataKey};
use svastha_core::event::{Event, Provenance};
use svastha_core::keys::Identity;
use svastha_devtool::{import_run, ImportConfig, RelayHttp};
use svastha_relay::grants::MemoryGrantStore;
use svastha_relay::mailbox::MemoryMailboxStore;
use svastha_relay::share::MemoryShareStore;
use svastha_relay::store::MemoryStore;

/// BIP39's canonical all-zero-entropy test mnemonic — a well-known, publicly
/// documented fixture, not a secret.
const TEST_MNEMONIC: &str =
    "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

const FIXTURE: &str = include_str!("../../../fixtures/ccda/minimal-ccd.xml");
const DOC_NAME: &str = "IHE_XDM/SUBSET01/DOC0001.XML";

/// Start `svastha_relay::app` on an OS-assigned port and return its base URL.
fn spawn_relay() -> String {
    let (tx, rx) = std::sync::mpsc::channel();
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

/// The content ids the fixture derives, deduped and in first-seen order —
/// exactly the set `import_run` would push into an empty vault.
fn expected_ids(sha: &str) -> Vec<String> {
    let result = svastha_import::import_ccda(FIXTURE).unwrap();
    let mut seen = HashSet::new();
    let mut ids = Vec::new();
    for draft in result.events {
        let event = event_from_draft(draft, sha);
        let id = event.id.to_hex();
        if seen.insert(id.clone()) {
            ids.push(id);
        }
    }
    ids
}

/// Build the same `Event` `import_run` builds for a draft. Provenance is
/// excluded from the content id, so the exact label here doesn't affect the id.
fn event_from_draft(draft: svastha_import::EventDraft, sha: &str) -> Event {
    Event::new(
        draft.kind,
        draft.code,
        draft.effective_at,
        draft.value,
        Provenance {
            source: format!("import:{DOC_NAME}"),
            source_doc: Some(sha.to_string()),
        },
    )
}

/// Seal and PUT one signed event under `ev-{id}`, mirroring what the web (and
/// `import_run`) store. Returns the event's content id.
fn seed_event(relay: &RelayHttp<'_>, identity: &Identity, key: &DataKey, event: Event) -> String {
    let signed = identity.sign_event(event);
    let id = signed.event.id.to_hex();
    let blob_id = format!("ev-{id}");
    let plaintext = serde_json::to_vec(&signed).unwrap();
    let sealed = key.seal(&plaintext, blob_id.as_bytes());
    relay.put_blob(&blob_id, &sealed.to_bytes()).unwrap();
    id
}

/// The fixture's sha256 and the sealed `doc-` blob's id.
fn fixture_sha() -> String {
    hex::encode(Sha256::digest(FIXTURE.as_bytes()))
}

/// Seal and PUT the fixture as its `doc-` provenance blob.
fn seed_doc(relay: &RelayHttp<'_>, key: &DataKey) -> String {
    let sha = fixture_sha();
    let envelope = serde_json::json!({ "name": DOC_NAME, "bytes": BASE64.encode(FIXTURE) });
    let blob_id = format!("doc-{sha}");
    let plaintext = serde_json::to_vec(&envelope).unwrap();
    let sealed = key.seal(&plaintext, blob_id.as_bytes());
    relay.put_blob(&blob_id, &sealed.to_bytes()).unwrap();
    blob_id
}

/// How many `ev-` blobs the relay currently lists.
fn ev_count(relay: &RelayHttp<'_>) -> usize {
    relay
        .list_blobs()
        .unwrap()
        .iter()
        .filter(|id| id.starts_with("ev-"))
        .count()
}

fn config(base: &str, dry_run: bool) -> ImportConfig {
    ImportConfig {
        relay_url: base.to_string(),
        mnemonic: TEST_MNEMONIC.to_string(),
        dry_run,
    }
}

#[test]
fn pushes_only_missing_events_and_is_idempotent() {
    let base = spawn_relay();
    let identity = Identity::from_mnemonic(TEST_MNEMONIC, "").unwrap();
    let relay = RelayHttp::new(base.clone(), &identity);

    let data_key = DataKey::generate();
    let wrapped = wrap_key(&identity.x25519_public(), &data_key);
    relay.put_blob("vault.key", &wrapped.to_bytes()).unwrap();
    seed_doc(&relay, &data_key);

    let sha = fixture_sha();
    let all_ids = expected_ids(&sha);
    assert!(
        all_ids.len() > 4,
        "fixture should derive several distinct events"
    );

    // Pre-seed the first few events, so the run has genuine dups to skip.
    let seeded = 3;
    let drafts = svastha_import::import_ccda(FIXTURE).unwrap().events;
    let mut seeded_ids = HashSet::new();
    for draft in drafts {
        if seeded_ids.len() == seeded {
            break;
        }
        let event = event_from_draft(draft, &sha);
        let id = event.id.to_hex();
        if seeded_ids.contains(&id) {
            continue; // a repeated fact — only seed distinct ids
        }
        seeded_ids.insert(seed_event(&relay, &identity, &data_key, event));
    }
    assert_eq!(seeded_ids.len(), seeded);

    let missing: HashSet<String> = all_ids
        .iter()
        .filter(|id| !seeded_ids.contains(*id))
        .cloned()
        .collect();

    // --- dry-run: reports the missing ids but writes nothing ---
    let before = ev_count(&relay);
    let dry = import_run(&config(&base, true)).expect("dry-run import");
    assert_eq!(
        dry.new_ids.iter().cloned().collect::<HashSet<_>>(),
        missing,
        "dry-run should name exactly the missing ids"
    );
    assert_eq!(dry.dups, seeded, "the pre-seeded events are dups");
    assert_eq!(
        ev_count(&relay),
        before,
        "dry-run must not write to the relay"
    );

    // --- real run: pushes exactly the missing ids ---
    let real = import_run(&config(&base, false)).expect("real import");
    assert_eq!(
        real.new_ids.iter().cloned().collect::<HashSet<_>>(),
        missing,
        "real run should push exactly the missing ids"
    );
    let on_relay: HashSet<String> = relay
        .list_blobs()
        .unwrap()
        .iter()
        .filter_map(|id| id.strip_prefix("ev-").map(str::to_string))
        .collect();
    assert_eq!(
        on_relay,
        all_ids.iter().cloned().collect::<HashSet<_>>(),
        "every derived event is now on the relay, once each"
    );

    // --- re-run: a no-op ---
    let again = import_run(&config(&base, false)).expect("re-run import");
    assert!(again.new_ids.is_empty(), "re-run pushes nothing");
    assert!(
        again.docs.iter().all(|d| d.new == 0),
        "re-run reports no new events per document"
    );
    assert_eq!(ev_count(&relay), all_ids.len());
}

#[test]
fn tampered_doc_blob_is_a_hard_error() {
    let base = spawn_relay();
    let identity = Identity::from_mnemonic(TEST_MNEMONIC, "").unwrap();
    let relay = RelayHttp::new(base.clone(), &identity);

    let data_key = DataKey::generate();
    let wrapped = wrap_key(&identity.x25519_public(), &data_key);
    relay.put_blob("vault.key", &wrapped.to_bytes()).unwrap();

    // Seal the doc blob, then flip a ciphertext byte so its AEAD tag no longer
    // verifies — the same tamper the decrypt test exercises.
    let sha = fixture_sha();
    let envelope = serde_json::json!({ "name": DOC_NAME, "bytes": BASE64.encode(FIXTURE) });
    let blob_id = format!("doc-{sha}");
    let plaintext = serde_json::to_vec(&envelope).unwrap();
    let mut bytes = data_key.seal(&plaintext, blob_id.as_bytes()).to_bytes();
    let last = bytes.len() - 1;
    bytes[last] ^= 0x01;
    relay.put_blob(&blob_id, &bytes).unwrap();

    let err = import_run(&config(&base, false)).expect_err("tampered doc must not open");
    assert!(
        err.to_string().contains(&blob_id) || format!("{err:#}").contains(&blob_id),
        "error should name the offending blob id: {err:#}"
    );
}
