//! Generates `spec/vectors/envelope.json` from the implementation. Run:
//!   cargo run -p svastha-core --example envelope_vectors > spec/vectors/envelope.json
//! The committed vectors are the frozen output of this; rerun only on a
//! deliberate, version-bumped contract change.
//!
//! Inputs (keys, nonces, ephemeral secrets) are fixed so the output is
//! reproducible; production code draws all of these from the OS RNG.

use serde::Serialize;
use svastha_core::envelope::{wrap_key_with_ephemeral, DataKey};
use svastha_core::keys::Identity;
use svastha_core::CONTRACT_VERSION;

// (key, nonce, aad, plaintext) — all hex. Exercises empty and non-empty aad.
const SEALING: &[(&str, &str, &str, &str)] = &[
    (
        "0101010101010101010101010101010101010101010101010101010101010101",
        "020202020202020202020202020202020202020202020202",
        "",
        "626c6f6f64207072657373757265203131382f3736", // "blood pressure 118/76"
    ),
    (
        "1f1e1d1c1b1a191817161514131211100f0e0d0c0b0a09080706050403020100",
        "ffeeddccbbaa99887766554433221100ffeeddccbbaa9988",
        "6576656e742d6964",                             // "event-id"
        "636c696e6963616c206576656e74207061796c6f6164", // "clinical event payload"
    ),
];

// (recipient_seed, ephemeral_secret, nonce, data_key) — all hex. The recipient
// seed is the canonical BIP39 "abandon … about" reference seed.
const WRAPPING: &[(&str, &str, &str, &str)] = &[(
    "5eb00bbddcf069084889a8ab9155568165f5c453ccb85e70811aaed6f6da5fc19a5ac40b389cd370d086206dec8aa6c43daea6690f20ad3d8d48b2d2ce9e38e4",
    "7777777777777777777777777777777777777777777777777777777777777777",
    "0a0b0c0d0e0f101112131415161718191a1b1c1d1e1f2021",
    "abababababababababababababababababababababababababababababababab",
)];

#[derive(Serialize)]
struct VectorFile {
    contract_version: u32,
    sealing: Vec<SealVector>,
    wrapping: Vec<WrapVector>,
}

#[derive(Serialize)]
struct SealVector {
    key_hex: String,
    nonce_hex: String,
    aad_hex: String,
    plaintext_hex: String,
    sealed_hex: String,
}

#[derive(Serialize)]
struct WrapVector {
    recipient_seed_hex: String,
    recipient_x25519_public_hex: String,
    ephemeral_secret_hex: String,
    nonce_hex: String,
    data_key_hex: String,
    wrapped_hex: String,
}

fn arr32(hex_str: &str) -> [u8; 32] {
    hex::decode(hex_str).unwrap().try_into().unwrap()
}

fn arr24(hex_str: &str) -> [u8; 24] {
    hex::decode(hex_str).unwrap().try_into().unwrap()
}

fn main() {
    let sealing = SEALING
        .iter()
        .map(|&(key, nonce, aad, plaintext)| {
            let pt = hex::decode(plaintext).unwrap();
            let aad_bytes = hex::decode(aad).unwrap();
            let sealed =
                DataKey::from_bytes(arr32(key)).seal_with_nonce(arr24(nonce), &pt, &aad_bytes);
            SealVector {
                key_hex: key.to_string(),
                nonce_hex: nonce.to_string(),
                aad_hex: aad.to_string(),
                plaintext_hex: plaintext.to_string(),
                sealed_hex: hex::encode(sealed.to_bytes()),
            }
        })
        .collect();

    let wrapping = WRAPPING
        .iter()
        .map(|&(seed, ephemeral, nonce, data_key)| {
            let recipient = Identity::from_seed(&hex::decode(seed).unwrap());
            let wrapped = wrap_key_with_ephemeral(
                &recipient.x25519_public(),
                &DataKey::from_bytes(arr32(data_key)),
                arr32(ephemeral),
                arr24(nonce),
            );
            WrapVector {
                recipient_seed_hex: seed.to_string(),
                recipient_x25519_public_hex: hex::encode(recipient.x25519_public().as_bytes()),
                ephemeral_secret_hex: ephemeral.to_string(),
                nonce_hex: nonce.to_string(),
                data_key_hex: data_key.to_string(),
                wrapped_hex: hex::encode(wrapped.to_bytes()),
            }
        })
        .collect();

    let file = VectorFile {
        contract_version: CONTRACT_VERSION,
        sealing,
        wrapping,
    };
    println!("{}", serde_json::to_string_pretty(&file).unwrap());
}
