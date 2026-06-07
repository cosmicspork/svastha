//! The relay auth handshake: how a client proves a request to the relay.
//!
//! The relay is a zero-knowledge store-and-forward server — it holds no keys and
//! only verifies client auth signatures (see ARCHITECTURE). Each request is
//! authenticated statelessly by an Ed25519 signature over a canonical descriptor
//! of the request: there are no sessions, no server secrets, and no nonce store.
//! Replay is bounded by a signed `timestamp` the relay checks against a freshness
//! window (a server policy; this module only binds the timestamp into the bytes).
//!
//! Both the relay and the web client (through the WASM build of `core`) must
//! produce these bytes identically, so the canonicalization lives here in the
//! trust contract, like the envelope and event encodings. `spec/README.md` is the
//! authoritative description and `spec/vectors/relay-auth.json` pins the bytes.

use ed25519_dalek::{Signature, VerifyingKey};
use sha2::{Digest, Sha256};

use crate::keys::Identity;

/// A canonical descriptor of a relay request to be signed. `path` includes the
/// query string; `body_sha256` is SHA-256 of the (possibly empty) request body.
pub struct AuthRequest {
    method: String,
    path: String,
    body_sha256: [u8; 32],
    timestamp: u64,
}

impl AuthRequest {
    /// Build a descriptor, hashing the body. `timestamp` is Unix seconds, taken
    /// as input so this stays clock-free (and WASM-safe); the relay binds it.
    pub fn new(method: &str, path: &str, body: &[u8], timestamp: u64) -> Self {
        Self {
            method: method.to_string(),
            path: path.to_string(),
            body_sha256: Sha256::digest(body).into(),
            timestamp,
        }
    }

    /// The exact bytes a client signs and the relay verifies. A version-tagged
    /// domain label separates relay-auth signatures from event signatures and any
    /// other Ed25519 use; method, path, and body hash are all bound so a captured
    /// signature cannot be reused for a different verb, route, or payload.
    pub fn signing_bytes(&self) -> Vec<u8> {
        let mut out = Vec::new();
        out.extend_from_slice(crate::version_label("relay-auth").as_bytes());
        put_str(&mut out, &self.method);
        put_str(&mut out, &self.path);
        out.extend_from_slice(&self.body_sha256);
        out.extend_from_slice(&self.timestamp.to_be_bytes());
        out
    }
}

/// Sign a request as `identity` (client side). Returns the raw 64-byte Ed25519
/// signature, which travels in the `Svastha-Signature` header.
pub fn sign_request(identity: &Identity, request: &AuthRequest) -> [u8; 64] {
    identity.sign(&request.signing_bytes()).to_bytes()
}

/// Verify a request signature against the claimed public key (relay side). Takes
/// raw bytes so the relay depends on `core` only for the verify primitive and
/// never imports `ed25519-dalek`. Returns false on a malformed key or signature.
pub fn verify_request(public_key: &[u8; 32], signature: &[u8; 64], request: &AuthRequest) -> bool {
    let Ok(public_key) = VerifyingKey::from_bytes(public_key) else {
        return false;
    };
    let signature = Signature::from_bytes(signature);
    crate::keys::verify(&public_key, &request.signing_bytes(), &signature)
}

/// Length-prefixed string: u32 big-endian length followed by UTF-8 bytes (the
/// same scheme the event canonical encoding uses).
fn put_str(out: &mut Vec<u8>, s: &str) {
    out.extend_from_slice(&(s.len() as u32).to_be_bytes());
    out.extend_from_slice(s.as_bytes());
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::Deserialize;

    fn req() -> AuthRequest {
        AuthRequest::new("PUT", "/v0/blobs/abc?x=1", b"ciphertext", 1_767_366_245)
    }

    #[test]
    fn signing_bytes_are_deterministic() {
        assert_eq!(req().signing_bytes(), req().signing_bytes());
    }

    #[test]
    fn sign_verify_round_trip() {
        let id = Identity::from_seed(b"client seed");
        let r = req();
        let sig = sign_request(&id, &r);
        assert!(verify_request(&id.verifying_key().to_bytes(), &sig, &r));
    }

    #[test]
    fn verify_rejects_tampered_request() {
        let id = Identity::from_seed(b"client seed");
        let pk = id.verifying_key().to_bytes();
        let sig = sign_request(&id, &req());

        // Any change to the bound fields invalidates the signature.
        let tampered = [
            AuthRequest::new("GET", "/v0/blobs/abc?x=1", b"ciphertext", 1_767_366_245),
            AuthRequest::new("PUT", "/v0/blobs/xyz?x=1", b"ciphertext", 1_767_366_245),
            AuthRequest::new("PUT", "/v0/blobs/abc?x=1", b"tampered", 1_767_366_245),
            AuthRequest::new("PUT", "/v0/blobs/abc?x=1", b"ciphertext", 1_767_366_246),
        ];
        for t in &tampered {
            assert!(!verify_request(&pk, &sig, t));
        }
    }

    #[test]
    fn verify_rejects_wrong_key() {
        let id = Identity::from_seed(b"client seed");
        let attacker = Identity::from_seed(b"attacker seed");
        let sig = sign_request(&id, &req());
        assert!(!verify_request(
            &attacker.verifying_key().to_bytes(),
            &sig,
            &req()
        ));
    }

    #[test]
    fn verify_rejects_malformed_key() {
        let id = Identity::from_seed(b"client seed");
        let sig = sign_request(&id, &req());
        // An all-ones point is not a valid Ed25519 public key.
        assert!(!verify_request(&[0xff; 32], &sig, &req()));
    }

    // --- pinned spec vectors ---

    #[derive(Deserialize)]
    struct VectorFile {
        contract_version: u32,
        requests: Vec<RequestVector>,
    }

    #[derive(Deserialize)]
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

    const VECTORS: &str = include_str!("../../../spec/vectors/relay-auth.json");

    #[test]
    fn matches_spec_vectors() {
        let file: VectorFile = serde_json::from_str(VECTORS).expect("parse vectors");
        assert_eq!(
            file.contract_version,
            crate::CONTRACT_VERSION,
            "vectors are pinned to a different contract version"
        );

        for v in &file.requests {
            let body = hex::decode(&v.body_hex).unwrap();
            let request = AuthRequest::new(&v.method, &v.path, &body, v.timestamp);
            assert_eq!(hex::encode(request.signing_bytes()), v.canon_hex, "canon");

            let signer = Identity::from_seed(&hex::decode(&v.signer_seed_hex).unwrap());
            assert_eq!(
                hex::encode(signer.verifying_key().to_bytes()),
                v.public_key_hex,
                "public key",
            );

            let signature = sign_request(&signer, &request);
            assert_eq!(hex::encode(signature), v.signature_hex, "signature");

            let public_key: [u8; 32] = hex::decode(&v.public_key_hex).unwrap().try_into().unwrap();
            assert!(verify_request(&public_key, &signature, &request), "verify");
        }
    }
}
