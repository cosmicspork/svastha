//! Identity and key derivation. A BIP39 seed phrase derives an X25519 keypair
//! (encryption) and an Ed25519 keypair (signing). Each device and each person is
//! an identity; vault data keys are wrapped to identity public keys, and a grant
//! is a vault key wrapped to a recipient under a filter and terms.
//!
//! The derivation (BIP39 seed -> HKDF-SHA256 with version-tagged `info` labels)
//! is the trust contract; `spec/README.md` is its authoritative description and
//! `spec/vectors/key-derivation.json` pins the bytes. The labels embed
//! [`CONTRACT_VERSION`](crate::CONTRACT_VERSION), so bumping the contract version
//! deliberately changes the derived keys.

use crate::curation::{CurationRecord, SignedCurationRecord};
use crate::envelope::{DataKey, EnvelopeError, SealedBox, WrappedKey};
use crate::event::{Event, SignedEvent};
use ed25519_dalek::{Signature, Signer, SigningKey, Verifier, VerifyingKey};
use hkdf::Hkdf;
use sha2::Sha256;
use x25519_dalek::{PublicKey, SharedSecret, StaticSecret};

pub use bip39::Mnemonic;

/// Errors from constructing an [`Identity`] from user-supplied input.
#[derive(Debug, thiserror::Error)]
pub enum KeyError {
    /// The mnemonic failed BIP39 validation (bad word, length, or checksum), or
    /// entropy was unavailable while generating a new one.
    #[error("invalid BIP39 mnemonic: {0}")]
    Mnemonic(#[from] bip39::Error),
}

/// A derived identity: the X25519 (encryption) and Ed25519 (signing) keypairs for
/// one device or person. The secret halves zeroize on drop (dalek `zeroize`).
///
/// Not `Clone`/`Debug` on purpose: secret key material should not be casually
/// copied or logged.
pub struct Identity {
    encryption: StaticSecret,
    signing: SigningKey,
}

impl Identity {
    /// Derive an identity from a BIP39 mnemonic and an optional passphrase (pass
    /// `""` for none). Validates the mnemonic before deriving.
    pub fn from_mnemonic(phrase: &str, passphrase: &str) -> Result<Self, KeyError> {
        let mnemonic = Mnemonic::parse(phrase)?;
        Ok(Self::from_seed(&mnemonic.to_seed(passphrase)))
    }

    /// Generate a fresh 24-word identity. Returns the mnemonic (to show the user
    /// for backup) alongside the derived keys. Uses the OS RNG.
    pub fn generate() -> Result<(Mnemonic, Self), KeyError> {
        let mnemonic = Mnemonic::generate(24)?;
        let identity = Self::from_seed(&mnemonic.to_seed(""));
        Ok((mnemonic, identity))
    }

    /// Derive directly from a 64-byte BIP39 seed. This is the HKDF step shared by
    /// the mnemonic constructors; exposed so the spec test vectors can pin the
    /// seed → key mapping independently of the BIP39 step.
    pub fn from_seed(seed: &[u8]) -> Self {
        let hk = Hkdf::<Sha256>::new(None, seed);
        Self {
            encryption: StaticSecret::from(expand(&hk, &info("x25519"))),
            signing: SigningKey::from_bytes(&expand(&hk, &info("ed25519"))),
        }
    }

    /// The X25519 public key — the address other parties wrap vault keys to.
    pub fn x25519_public(&self) -> PublicKey {
        PublicKey::from(&self.encryption)
    }

    /// The Ed25519 public key — the identity's signing identity and relay-auth id.
    pub fn verifying_key(&self) -> VerifyingKey {
        self.signing.verifying_key()
    }

    /// Sign a message with this identity's Ed25519 key (events, relay handshake).
    pub fn sign(&self, message: &[u8]) -> Signature {
        self.signing.sign(message)
    }

    /// X25519 Diffie–Hellman against a peer's public key (basis of key wrapping).
    pub fn diffie_hellman(&self, their_public: &PublicKey) -> SharedSecret {
        self.encryption.diffie_hellman(their_public)
    }

    /// Unwrap a vault data key that was wrapped to this identity's X25519 public
    /// key. Fails with [`EnvelopeError::Aead`] if the wrapping was not addressed
    /// to this identity (or was tampered with).
    pub fn unwrap_key(&self, wrapped: &WrappedKey) -> Result<DataKey, EnvelopeError> {
        wrapped.open(&self.encryption, &self.x25519_public())
    }

    /// Open a [`SealedBox`] (a mailbox message body) that was sealed to this
    /// identity's X25519 public key. Keeps secret-key access inside `Identity`,
    /// exactly like [`unwrap_key`](Self::unwrap_key). Fails with
    /// [`EnvelopeError::Aead`] if the box was not sealed to this identity, the
    /// `aad` differs, or the ciphertext was tampered with.
    pub fn open_sealed_box(
        &self,
        sealed: &SealedBox,
        aad: &[u8],
    ) -> Result<Vec<u8>, EnvelopeError> {
        sealed.open(&self.encryption, &self.x25519_public(), aad)
    }

    /// Sign an event as this identity. Stamps the content-addressed id (so the
    /// stored id and the signed id always agree) and signs
    /// [`Event::signing_bytes`] with this identity's Ed25519 key.
    pub fn sign_event(&self, mut event: Event) -> SignedEvent {
        event.id = event.content_id();
        let signature = self.sign(&event.signing_bytes());
        SignedEvent::new(event, self.verifying_key().to_bytes(), signature.to_bytes())
    }

    /// Sign a curation record as this identity. Stamps `author` from this
    /// identity's Ed25519 key (so the stored author and the signing key always
    /// agree) and signs [`CurationRecord::signing_bytes`]. The same key that signs
    /// events, so a recipient of a doctor-share bundle can verify curation records
    /// against the owner identity they already know.
    pub fn sign_curation(
        &self,
        key: String,
        value: serde_json::Value,
        updated_at: i64,
    ) -> SignedCurationRecord {
        let record = CurationRecord {
            key,
            value,
            updated_at,
            author: self.verifying_key().to_bytes(),
        };
        let signature = self.sign(&record.signing_bytes());
        SignedCurationRecord::new(record, signature.to_bytes())
    }
}

/// Verify an Ed25519 signature against a public key. A free function so the relay
/// can check client auth signatures without holding any [`Identity`].
pub fn verify(verifying_key: &VerifyingKey, message: &[u8], signature: &Signature) -> bool {
    verifying_key.verify(message, signature).is_ok()
}

/// Per-key HKDF `info` label (see [`crate::version_label`]).
fn info(key: &str) -> Vec<u8> {
    crate::version_label(key).into_bytes()
}

/// Expand 32 bytes of key material for the given label. HKDF-SHA256 expand only
/// fails when the requested length exceeds 255 hashes; 32 bytes never does.
fn expand(hk: &Hkdf<Sha256>, info: &[u8]) -> [u8; 32] {
    let mut okm = [0u8; 32];
    hk.expand(info, &mut okm)
        .expect("HKDF expand of 32 bytes is always within bounds");
    okm
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::Deserialize;

    #[derive(Deserialize)]
    struct VectorFile {
        contract_version: u32,
        vectors: Vec<Vector>,
    }

    #[derive(Deserialize)]
    struct Vector {
        mnemonic: String,
        passphrase: String,
        seed_hex: String,
        x25519_public_hex: String,
        ed25519_public_hex: String,
    }

    const VECTORS: &str = include_str!("../../../spec/vectors/key-derivation.json");

    #[test]
    fn matches_spec_vectors() {
        let file: VectorFile = serde_json::from_str(VECTORS).expect("parse vectors");
        assert_eq!(
            file.contract_version,
            crate::CONTRACT_VERSION,
            "vectors are pinned to a different contract version"
        );

        for v in &file.vectors {
            let seed = hex::decode(&v.seed_hex).unwrap();

            let mnemonic = Mnemonic::parse(&v.mnemonic).unwrap();
            assert_eq!(
                mnemonic.to_seed(&v.passphrase).as_slice(),
                seed.as_slice(),
                "seed mismatch for {}",
                v.mnemonic
            );

            // Both entry points must produce the pinned public keys.
            let from_phrase = Identity::from_mnemonic(&v.mnemonic, &v.passphrase).unwrap();
            let from_seed = Identity::from_seed(&seed);
            for id in [&from_phrase, &from_seed] {
                assert_eq!(
                    hex::encode(id.x25519_public().as_bytes()),
                    v.x25519_public_hex,
                    "x25519 mismatch for {}",
                    v.mnemonic
                );
                assert_eq!(
                    hex::encode(id.verifying_key().as_bytes()),
                    v.ed25519_public_hex,
                    "ed25519 mismatch for {}",
                    v.mnemonic
                );
            }
        }
    }

    #[test]
    fn sign_verify_round_trip() {
        let id = Identity::from_seed(b"round-trip seed material");
        let msg = b"clinical event bytes";
        let sig = id.sign(msg);
        assert!(verify(&id.verifying_key(), msg, &sig));
        assert!(!verify(&id.verifying_key(), b"tampered", &sig));
    }

    #[test]
    fn diffie_hellman_agrees() {
        let a = Identity::from_seed(b"alice seed");
        let b = Identity::from_seed(b"bob seed");
        assert_eq!(
            a.diffie_hellman(&b.x25519_public()).as_bytes(),
            b.diffie_hellman(&a.x25519_public()).as_bytes(),
        );
    }

    #[test]
    fn derivation_is_deterministic_and_passphrase_separated() {
        let phrase = "legal winner thank year wave sausage worth useful legal winner thank yellow";
        let a = Identity::from_mnemonic(phrase, "").unwrap();
        let b = Identity::from_mnemonic(phrase, "").unwrap();
        assert_eq!(a.x25519_public().as_bytes(), b.x25519_public().as_bytes());

        let with_pass = Identity::from_mnemonic(phrase, "TREZOR").unwrap();
        assert_ne!(
            a.x25519_public().as_bytes(),
            with_pass.x25519_public().as_bytes(),
            "passphrase must change derivation"
        );
    }

    #[test]
    fn invalid_mnemonic_errors() {
        assert!(Identity::from_mnemonic("not a valid mnemonic at all", "").is_err());
    }

    #[test]
    fn generate_produces_usable_identity() {
        let (mnemonic, id) = Identity::generate().unwrap();
        let reparsed = Identity::from_mnemonic(&mnemonic.to_string(), "").unwrap();
        assert_eq!(
            id.x25519_public().as_bytes(),
            reparsed.x25519_public().as_bytes(),
        );
    }
}
