//! Generates `spec/vectors/mailbox.json` from the implementation. Run:
//!   cargo run -p svastha-core --example mailbox_vectors > spec/vectors/mailbox.json
//! The committed vectors are the frozen output of this; rerun only on a
//! deliberate, version-bumped contract change.
//!
//! Inputs (seeds, ephemeral secrets, nonces) are fixed so the output is
//! reproducible; production code draws all of these from the OS RNG.

use serde_json::{json, Value};
use svastha_core::envelope::{wrap_key_with_ephemeral, DataKey};
use svastha_core::event::{Code, Event, EventKind, EventValue, Provenance};
use svastha_core::keys::Identity;
use svastha_core::mailbox::{
    DraftProposal, KeyHandoffBody, MailboxMessage, MessageKind, ProposalBody,
};
use svastha_core::CONTRACT_VERSION;

const SENDER_SEED: &str = "1010101010101010101010101010101010101010101010101010101010101010";
const RECIPIENT_SEED: &str = "2020202020202020202020202020202020202020202020202020202020202020";

fn arr32(s: &str) -> [u8; 32] {
    hex::decode(s).unwrap().try_into().unwrap()
}

fn arr24(s: &str) -> [u8; 24] {
    hex::decode(s).unwrap().try_into().unwrap()
}

/// A valid, freshly-sealed vector: pins every derived byte plus the rebuild
/// inputs so a reimplementation can reproduce it from seeds and nonces.
fn valid_vector(
    note: &str,
    kind: MessageKind,
    sent_at: i64,
    ephemeral_hex: &str,
    nonce_hex: &str,
    plaintext: &[u8],
) -> Value {
    let sender = Identity::from_seed(&hex::decode(SENDER_SEED).unwrap());
    let recipient = Identity::from_seed(&hex::decode(RECIPIENT_SEED).unwrap());
    let built = MailboxMessage::seal_with(
        &sender,
        &recipient.x25519_public(),
        kind,
        sent_at,
        plaintext,
        arr32(ephemeral_hex),
        arr24(nonce_hex),
    );
    let envelope = serde_json::to_value(&built).unwrap();
    json!({
        "note": note,
        "valid": true,
        "sender_seed_hex": SENDER_SEED,
        "recipient_seed_hex": RECIPIENT_SEED,
        "recipient_x25519_public_hex": hex::encode(recipient.x25519_public().as_bytes()),
        "kind": envelope["kind"],
        "sent_at": sent_at,
        "ephemeral_secret_hex": ephemeral_hex,
        "seal_nonce_hex": nonce_hex,
        "body_plaintext_hex": hex::encode(plaintext),
        "canon_hex": hex::encode(built.canonical_bytes()),
        "id_hex": hex::encode(built.msg_id()),
        "signing_bytes_hex": hex::encode(built.signing_bytes()),
        "signature_hex": envelope["signature"],
        "envelope": envelope,
    })
}

/// Flip the first byte of a hex-string field in an envelope value.
fn flip_first_byte(hex_str: &str) -> String {
    let mut bytes = hex::decode(hex_str).unwrap();
    bytes[0] ^= 0x01;
    hex::encode(bytes)
}

fn main() {
    let sender = Identity::from_seed(&hex::decode(SENDER_SEED).unwrap());
    let recipient = Identity::from_seed(&hex::decode(RECIPIENT_SEED).unwrap());

    // key_handoff body: sender identity + a wrapped vault key (deterministically
    // wrapped to the recipient so the whole vector is reproducible).
    let inner_key = DataKey::from_bytes([0xab; 32]);
    let inner_wrapped = wrap_key_with_ephemeral(
        &recipient.x25519_public(),
        &inner_key,
        [0x77; 32],
        arr24("0a0b0c0d0e0f101112131415161718191a1b1c1d1e1f2021"),
    );
    let key_handoff_body = serde_json::to_vec(&KeyHandoffBody {
        from_ed: hex::encode(sender.verifying_key().to_bytes()),
        from_x25519: hex::encode(sender.x25519_public().as_bytes()),
        label: "laptop".into(),
        wrapped_hex: hex::encode(inner_wrapped.to_bytes()),
    })
    .unwrap();

    // proposal body: one unsigned, schema-valid draft event with provenance.
    let draft = Event::new(
        EventKind::Observation,
        Some(Code {
            system: "http://loinc.org".into(),
            code: "8867-4".into(),
            display: Some("Heart rate".into()),
        }),
        Some("2026-07-20T09:00:00Z".into()),
        Some(EventValue::Quantity {
            value: "68".into(),
            unit: Some(Code {
                system: "http://unitsofmeasure.org".into(),
                code: "/min".into(),
                display: None,
            }),
        }),
        Provenance {
            source: "node".into(),
            source_doc: None,
        },
    );
    let proposal_body = serde_json::to_vec(&ProposalBody {
        proposals: vec![DraftProposal {
            event: draft,
            source_blob: Some("att-0f1e2d3c".into()),
            method: Some("ocr".into()),
            model: Some("some-vision-model".into()),
        }],
    })
    .unwrap();

    let key_handoff = valid_vector(
        "key_handoff: the typed successor to the bare wrapped-key deposit",
        MessageKind::KeyHandoff,
        1_753_280_000_000,
        "3030303030303030303030303030303030303030303030303030303030303030",
        "404040404040404040404040404040404040404040404040",
        &key_handoff_body,
    );

    let proposal = valid_vector(
        "proposal: an unsigned draft event with extraction provenance",
        MessageKind::Proposal,
        1_753_280_005_000,
        "3131313131313131313131313131313131313131313131313131313131313131",
        "414141414141414141414141414141414141414141414141",
        &proposal_body,
    );

    // Tampered signature: a valid envelope whose signature has one byte flipped.
    let mut tampered_sig = key_handoff["envelope"].clone();
    tampered_sig["signature"] = json!(flip_first_byte(tampered_sig["signature"].as_str().unwrap()));
    let tampered_sig = json!({
        "note": "tampered signature: verification must fail",
        "valid": false,
        "envelope": tampered_sig,
    });

    // Tampered sent_at: the stored id no longer matches the recomputed one, so
    // verification fails even though the signature bytes are untouched.
    let mut tampered_field = key_handoff["envelope"].clone();
    tampered_field["sent_at"] = json!(key_handoff["envelope"]["sent_at"].as_i64().unwrap() + 1);
    let tampered_field = json!({
        "note": "tampered sent_at (id no longer matches): verification must fail",
        "valid": false,
        "envelope": tampered_field,
    });

    // Legacy bare wrapped-key deposit — today's format, still parseable, wrapped
    // key still openable within the current major.
    let legacy_key = DataKey::from_bytes([0xcd; 32]);
    let legacy_wrapped = wrap_key_with_ephemeral(
        &recipient.x25519_public(),
        &legacy_key,
        [0x88; 32],
        arr24("505152535455565758595a5b5c5d5e5f6061626364656667"),
    );
    let legacy = json!({
        "note": "bare wrapped-key deposit (pre-envelope) still parses and unwraps",
        "json": {
            "v": 1,
            "from_ed": hex::encode(sender.verifying_key().to_bytes()),
            "from_x25519": hex::encode(sender.x25519_public().as_bytes()),
            "label": "old phone",
            "wrapped_hex": hex::encode(legacy_wrapped.to_bytes()),
        },
        "recipient_seed_hex": RECIPIENT_SEED,
        "unwraps": true,
    });

    let file = json!({
        "contract_version": CONTRACT_VERSION,
        "messages": [key_handoff, proposal, tampered_sig, tampered_field],
        "legacy": [legacy],
    });
    println!("{}", serde_json::to_string_pretty(&file).unwrap());
}
