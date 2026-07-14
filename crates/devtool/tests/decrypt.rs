//! Drives `svastha_devtool::run` against a real relay: an in-process
//! `svastha_relay::app` served over an ephemeral TCP port, seeded through the
//! same signed-request path a client would use (`RelayHttp::put_blob`).

use std::sync::Arc;

use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use sha2::{Digest, Sha256};
use svastha_core::envelope::{wrap_key, DataKey};
use svastha_core::event::{Event, EventKind, Provenance};
use svastha_core::keys::Identity;
use svastha_devtool::{run, Config, RelayHttp};
use svastha_relay::grants::MemoryGrantStore;
use svastha_relay::mailbox::MemoryMailboxStore;
use svastha_relay::share::MemoryShareStore;
use svastha_relay::store::MemoryStore;

/// BIP39's canonical all-zero-entropy test mnemonic — a well-known, publicly
/// documented fixture, not a secret. Fine to hardcode in tests (and to reuse
/// as the placeholder in `.env.example`).
const TEST_MNEMONIC: &str =
    "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

/// Start `svastha_relay::app` on an OS-assigned port and return its base URL.
/// Runs on a dedicated thread with its own runtime for the life of the test
/// process; there's nothing to shut down for a short-lived integration test.
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
            );
            axum::serve(listener, app).await.expect("serve relay");
        });
    });
    let addr = rx.recv().expect("relay thread failed to start");
    format!("http://{addr}")
}

fn observation(text: &str) -> Event {
    Event::new(
        EventKind::Observation,
        None,
        None,
        Some(svastha_core::event::EventValue::Text(text.to_string())),
        Provenance {
            source: "test fixture".to_string(),
            source_doc: None,
        },
    )
}

/// Seed vault.key, a few events, one document, and one curation record for
/// `identity`, all through real signed PUTs. Returns the ids used for events
/// (sorted hex) and the doc/curation fixtures for the test to check against.
struct Fixtures {
    event_ids_sorted: Vec<String>,
    doc_name: &'static str,
    doc_bytes: &'static [u8],
    doc_digest: String,
    curation_key: &'static str,
    curation_digest: String,
}

fn seed(relay: &RelayHttp<'_>, identity: &Identity) -> Fixtures {
    let data_key = DataKey::generate();
    let wrapped = wrap_key(&identity.x25519_public(), &data_key);
    relay.put_blob("vault.key", &wrapped.to_bytes()).unwrap();

    let mut event_ids_sorted = Vec::new();
    for text in ["bp 118/76", "immunization: flu", "condition: asthma"] {
        let signed = identity.sign_event(observation(text));
        let id_hex = signed.event.id.to_hex();
        let blob_id = format!("ev-{id_hex}");
        let plaintext = serde_json::to_vec(&signed).unwrap();
        let sealed = data_key.seal(&plaintext, blob_id.as_bytes());
        relay.put_blob(&blob_id, &sealed.to_bytes()).unwrap();
        event_ids_sorted.push(id_hex);
    }
    event_ids_sorted.sort();

    let doc_name = "IHE_XDM/SUBSET01/DOC0001.XML";
    let doc_bytes: &[u8] = b"<ClinicalDocument>fixture</ClinicalDocument>";
    let doc_digest = hex::encode(Sha256::digest(doc_bytes));
    let doc_envelope = serde_json::json!({
        "name": doc_name,
        "bytes": BASE64.encode(doc_bytes),
    });
    let doc_blob_id = format!("doc-{doc_digest}");
    let doc_plaintext = serde_json::to_vec(&doc_envelope).unwrap();
    let doc_sealed = data_key.seal(&doc_plaintext, doc_blob_id.as_bytes());
    relay
        .put_blob(&doc_blob_id, &doc_sealed.to_bytes())
        .unwrap();

    let curation_key = "note:2026-01-01";
    let curation_digest = hex::encode(Sha256::digest(curation_key.as_bytes()));
    let curation_record = serde_json::json!({
        "key": curation_key,
        "note": "reviewed at annual physical",
    });
    let curation_blob_id = format!("cur-{curation_digest}");
    let curation_plaintext = serde_json::to_vec(&curation_record).unwrap();
    let curation_sealed = data_key.seal(&curation_plaintext, curation_blob_id.as_bytes());
    relay
        .put_blob(&curation_blob_id, &curation_sealed.to_bytes())
        .unwrap();

    // An unrecognized blob id: exercises the skip path rather than erroring.
    relay
        .put_blob("misc-abc123", b"opaque, not ours to interpret")
        .unwrap();

    Fixtures {
        event_ids_sorted,
        doc_name,
        doc_bytes,
        doc_digest,
        curation_key,
        curation_digest,
    }
}

#[test]
fn decrypts_events_docs_and_curation() {
    let base = spawn_relay();
    let identity = Identity::from_mnemonic(TEST_MNEMONIC, "").unwrap();
    let relay = RelayHttp::new(base.clone(), &identity);
    let fixtures = seed(&relay, &identity);

    let out = tempfile::tempdir().unwrap();
    let out_dir = out.path().join("decrypt");
    let summary = run(&Config {
        relay_url: base,
        mnemonic: TEST_MNEMONIC.to_string(),
        out_dir: out_dir.clone(),
    })
    .expect("run should decrypt the seeded vault");

    assert_eq!(summary.events, 3);
    assert_eq!(summary.docs, 1);
    assert_eq!(summary.curation, 1);
    assert_eq!(summary.skipped, vec!["misc-abc123".to_string()]);

    // events.ndjson: one line per event, sorted by event id.
    let events_ndjson = std::fs::read_to_string(out_dir.join("events.ndjson")).unwrap();
    let lines: Vec<&str> = events_ndjson.lines().collect();
    assert_eq!(lines.len(), 3);
    let ids_in_file: Vec<String> = lines
        .iter()
        .map(|line| {
            let v: serde_json::Value = serde_json::from_str(line).unwrap();
            v["event"]["id"].as_str().unwrap().to_string()
        })
        .collect();
    assert_eq!(ids_in_file, fixtures.event_ids_sorted);

    // The doc file exists, has the verbatim bytes, and a sanitized name.
    let doc_filename = format!(
        "{}-{}",
        &fixtures.doc_digest[..12],
        "IHE_XDM__SUBSET01__DOC0001.XML"
    );
    let doc_path = out_dir.join("docs").join(&doc_filename);
    assert_eq!(std::fs::read(&doc_path).unwrap(), fixtures.doc_bytes);
    assert!(!fixtures.doc_name.is_empty()); // fixture sanity, name used above

    // curation.ndjson: the one record, with its key intact.
    let curation_ndjson = std::fs::read_to_string(out_dir.join("curation.ndjson")).unwrap();
    let curation_lines: Vec<&str> = curation_ndjson.lines().collect();
    assert_eq!(curation_lines.len(), 1);
    let record: serde_json::Value = serde_json::from_str(curation_lines[0]).unwrap();
    assert_eq!(record["key"], fixtures.curation_key);
    let _ = fixtures.curation_digest; // documents how the blob id was derived
}

#[test]
fn tampered_sealed_blob_errors() {
    let base = spawn_relay();
    let identity = Identity::from_mnemonic(TEST_MNEMONIC, "").unwrap();
    let relay = RelayHttp::new(base.clone(), &identity);

    let data_key = DataKey::generate();
    let wrapped = wrap_key(&identity.x25519_public(), &data_key);
    relay.put_blob("vault.key", &wrapped.to_bytes()).unwrap();

    let signed = identity.sign_event(observation("bp 118/76"));
    let blob_id = format!("ev-{}", signed.event.id.to_hex());
    let plaintext = serde_json::to_vec(&signed).unwrap();
    let sealed = data_key.seal(&plaintext, blob_id.as_bytes());
    let mut bytes = sealed.to_bytes();
    let last = bytes.len() - 1;
    bytes[last] ^= 0x01; // flip a ciphertext byte: AEAD tag no longer verifies
    relay.put_blob(&blob_id, &bytes).unwrap();

    let out = tempfile::tempdir().unwrap();
    let err = run(&Config {
        relay_url: base,
        mnemonic: TEST_MNEMONIC.to_string(),
        out_dir: out.path().join("decrypt"),
    })
    .expect_err("tampered blob must not decrypt");

    assert!(
        err.to_string().contains(&blob_id),
        "error should name the offending blob id: {err}"
    );
}
