//! Generates `spec/vectors/key-derivation.json` from the implementation. Run:
//!   cargo run -p svastha-core --example derive_vectors > spec/vectors/key-derivation.json
//! The committed vectors are the frozen output of this; rerun only on a
//! deliberate, version-bumped contract change.

use serde::Serialize;
use svastha_core::keys::{Identity, Mnemonic};
use svastha_core::CONTRACT_VERSION;

// (mnemonic, passphrase) — standard BIP39 test phrases, 12 and 24 words, with and
// without a passphrase, so a reimplementation exercises every input dimension.
const INPUTS: &[(&str, &str)] = &[
    (
        "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
        "",
    ),
    (
        "legal winner thank year wave sausage worth useful legal winner thank yellow",
        "TREZOR",
    ),
    (
        "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon art",
        "TREZOR",
    ),
];

#[derive(Serialize)]
struct VectorFile {
    contract_version: u32,
    vectors: Vec<Vector>,
}

#[derive(Serialize)]
struct Vector {
    mnemonic: String,
    passphrase: String,
    seed_hex: String,
    x25519_public_hex: String,
    ed25519_public_hex: String,
}

fn main() {
    let vectors = INPUTS
        .iter()
        .map(|&(phrase, passphrase)| {
            let seed = Mnemonic::parse(phrase).unwrap().to_seed(passphrase);
            let id = Identity::from_seed(&seed);
            Vector {
                mnemonic: phrase.to_string(),
                passphrase: passphrase.to_string(),
                seed_hex: hex::encode(seed),
                x25519_public_hex: hex::encode(id.x25519_public().as_bytes()),
                ed25519_public_hex: hex::encode(id.verifying_key().as_bytes()),
            }
        })
        .collect();
    let file = VectorFile {
        contract_version: CONTRACT_VERSION,
        vectors,
    };
    println!("{}", serde_json::to_string_pretty(&file).unwrap());
}
