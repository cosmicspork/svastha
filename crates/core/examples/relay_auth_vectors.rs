//! Generates `spec/vectors/relay-auth.json` from the implementation. Run:
//!   cargo run -p svastha-core --example relay_auth_vectors > spec/vectors/relay-auth.json
//! The committed vectors are the frozen output of this; rerun only on a
//! deliberate, version-bumped contract change.
//!
//! Each entry fixes a request and a signer seed; Ed25519 signing is deterministic
//! (RFC 8032), so the canonical bytes and signature are reproducible. Includes a
//! GET (empty body) and a PUT (non-empty body).

use serde::Serialize;
use svastha_core::keys::Identity;
use svastha_core::relay::{sign_request, AuthRequest};
use svastha_core::CONTRACT_VERSION;

// (method, path, body hex, timestamp).
const REQUESTS: &[(&str, &str, &str, u64)] = &[
    ("GET", "/v0/blobs/abc123?since=0", "", 1_767_366_245),
    (
        "PUT",
        "/v0/blobs/abc123",
        "deadbeefcafe", // opaque ciphertext bytes
        1_767_366_245,
    ),
];

// Fixed signer seed (HKDF IKM bytes, not a BIP39 seed).
const SIGNER_SEED_HEX: &str = "0102030405060708090a0b0c0d0e0f10";

#[derive(Serialize)]
struct VectorFile {
    contract_version: u32,
    requests: Vec<RequestVector>,
}

#[derive(Serialize)]
struct RequestVector {
    method: String,
    path: String,
    body_hex: String,
    timestamp: u64,
    signer_seed_hex: String,
    canon_hex: String,
    public_key_hex: String,
    signature_hex: String,
}

fn main() {
    let signer = Identity::from_seed(&hex::decode(SIGNER_SEED_HEX).unwrap());
    let public_key_hex = hex::encode(signer.verifying_key().to_bytes());

    let requests = REQUESTS
        .iter()
        .map(|&(method, path, body_hex, timestamp)| {
            let body = hex::decode(body_hex).unwrap();
            let request = AuthRequest::new(method, path, &body, timestamp);
            RequestVector {
                method: method.to_string(),
                path: path.to_string(),
                body_hex: body_hex.to_string(),
                timestamp,
                signer_seed_hex: SIGNER_SEED_HEX.to_string(),
                canon_hex: hex::encode(request.signing_bytes()),
                public_key_hex: public_key_hex.clone(),
                signature_hex: hex::encode(sign_request(&signer, &request)),
            }
        })
        .collect();

    let file = VectorFile {
        contract_version: CONTRACT_VERSION,
        requests,
    };
    println!("{}", serde_json::to_string_pretty(&file).unwrap());
}
