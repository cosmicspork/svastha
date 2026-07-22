//! Generates `spec/vectors/curation.json` from the implementation. Run:
//!   cargo run -p svastha-core --example curation_vectors > spec/vectors/curation.json
//! The committed vectors are the frozen output of this; rerun only on a
//! deliberate, version-bumped contract change.
//!
//! One valid record (with its canonical preimage and deterministic RFC 8032
//! signature pinned) plus three tamper cases a correct verifier must reject: a
//! mutated `value`, a mutated `key`, and a `signature` re-attributed to a wrong
//! `author`. Each entry carries `valid` — the expected `verify()` outcome the core
//! test asserts against.

use serde::Serialize;
use serde_json::{json, Value};
use svastha_core::keys::Identity;
use svastha_core::CONTRACT_VERSION;

// A fixed signer seed (HKDF IKM bytes, not a BIP39 seed); Ed25519 signing is
// deterministic, so the signature is reproducible. Same seed the other vectors use.
const SIGNER_SEED_HEX: &str = "0102030405060708090a0b0c0d0e0f10";

#[derive(Serialize)]
struct VectorFile {
    contract_version: u32,
    records: Vec<RecordVector>,
}

#[derive(Serialize)]
struct RecordVector {
    /// What this vector exercises.
    note: String,
    /// The expected `verify()` outcome.
    valid: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    signer_seed_hex: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    canon_hex: Option<String>,
    /// The full signed record wire form (`{ key, value, updated_at, author,
    /// signature }`), as JSON so the tamper cases can be minted by mutation.
    record: Value,
}

fn main() {
    let signer = Identity::from_seed(&hex::decode(SIGNER_SEED_HEX).unwrap());

    // The one valid, canonical record: a tag list on an event.
    let valid = signer.sign_curation(
        "tag:732134e89dcf3272fbabd50cd584640f9cf2e359f301a95710bfe692ee1a7cc0".into(),
        json!({ "tags": ["fever", "travel"] }),
        1_700_000_000_000,
    );
    let canon_hex = hex::encode(valid.record.signing_bytes());
    let valid_json = serde_json::to_value(&valid).unwrap();

    // Tamper cases keep the valid signature but mutate a covered field (or the
    // author), so a correct verifier rejects all three.
    let tampered_value = mutate(&valid_json, |r| {
        r["value"] = json!({ "tags": ["fever", "travel", "forged"] });
    });
    let tampered_key = mutate(&valid_json, |r| {
        r["key"] = json!("tag:0000000000000000000000000000000000000000000000000000000000000000");
    });
    // Re-attribute to a different identity's public key; the signature no longer
    // verifies under it.
    let wrong_author = Identity::from_seed(b"attacker seed");
    let wrong_author_json = mutate(&valid_json, |r| {
        r["author"] = json!(hex::encode(wrong_author.verifying_key().to_bytes()));
    });

    let file = VectorFile {
        contract_version: CONTRACT_VERSION,
        records: vec![
            RecordVector {
                note: "valid signed curation record (tag list)".into(),
                valid: true,
                signer_seed_hex: Some(SIGNER_SEED_HEX.into()),
                canon_hex: Some(canon_hex),
                record: valid_json,
            },
            RecordVector {
                note: "tampered value: signature no longer covers the record".into(),
                valid: false,
                signer_seed_hex: None,
                canon_hex: None,
                record: tampered_value,
            },
            RecordVector {
                note: "tampered key: signature no longer covers the record".into(),
                valid: false,
                signer_seed_hex: None,
                canon_hex: None,
                record: tampered_key,
            },
            RecordVector {
                note: "wrong author: signature does not verify under the substituted key".into(),
                valid: false,
                signer_seed_hex: None,
                canon_hex: None,
                record: wrong_author_json,
            },
        ],
    };
    println!("{}", serde_json::to_string_pretty(&file).unwrap());
}

fn mutate(base: &Value, f: impl FnOnce(&mut Value)) -> Value {
    let mut cloned = base.clone();
    f(&mut cloned);
    cloned
}
