//! The encryption envelope: symmetric payload sealing under a vault data key,
//! and wrapping that data key to a recipient's X25519 public key. This is the
//! most security-critical code in the project; it must match `spec/` and its
//! test vectors exactly.
//!
//! Two operations, one AEAD:
//!
//! - **Sealing.** [`DataKey::seal`] encrypts a payload with XChaCha20-Poly1305
//!   under a 256-bit vault data key. Callers pass associated data (`aad`) to bind
//!   context (e.g. an event id) that is authenticated but not encrypted.
//! - **Wrapping.** [`wrap_key`] wraps a [`DataKey`] to a recipient's X25519
//!   public key (ECIES / sealed-box): an ephemeral X25519 key does DH with the
//!   recipient, HKDF-SHA256 derives a wrapping key, and the data key is sealed
//!   under it with the same AEAD. Only the recipient's secret can unwrap it
//!   ([`crate::keys::Identity::unwrap_key`]); the relay never sees an unwrapped
//!   key.
//!
//! The HKDF label embeds [`CONTRACT_VERSION`](crate::CONTRACT_VERSION), so a
//! contract bump deliberately invalidates old wrappings. `spec/README.md` is the
//! authoritative description and `spec/vectors/envelope.json` pins the bytes.

use chacha20poly1305::{
    aead::{Aead, Payload},
    Key, KeyInit, XChaCha20Poly1305, XNonce,
};
use hkdf::Hkdf;
use rand_core::{OsRng, RngCore};
use serde::{Deserialize, Serialize};
use sha2::Sha256;
use x25519_dalek::{PublicKey, StaticSecret};
use zeroize::Zeroize;

/// XChaCha20 nonce length (192-bit, large enough to pick at random).
const NONCE_LEN: usize = 24;
/// Key length for both the data key and the derived wrapping key.
const KEY_LEN: usize = 32;
/// Poly1305 authentication tag length, appended to the ciphertext by the AEAD.
const TAG_LEN: usize = 16;

/// Failure modes for opening an envelope.
#[derive(Debug, thiserror::Error)]
pub enum EnvelopeError {
    /// Authentication failed: wrong key, wrong associated data, or tampered
    /// ciphertext. Deliberately opaque so it leaks nothing about the cause.
    #[error("authenticated decryption failed")]
    Aead,
    /// The bytes are too short or otherwise not a well-formed envelope.
    #[error("malformed envelope bytes")]
    Format,
}

/// A symmetric vault data key (XChaCha20-Poly1305, 256-bit). It is the unit of
/// sharing: events are sealed under it, and it is what gets wrapped to a
/// recipient.
///
/// Zeroizes on drop and is intentionally not `Clone`/`Debug` so key material is
/// not casually copied or logged (matching [`crate::keys::Identity`]).
pub struct DataKey([u8; KEY_LEN]);

impl Drop for DataKey {
    fn drop(&mut self) {
        self.0.zeroize();
    }
}

impl DataKey {
    /// Generate a fresh random data key from the OS RNG.
    pub fn generate() -> Self {
        let mut key = [0u8; KEY_LEN];
        OsRng.fill_bytes(&mut key);
        Self(key)
    }

    /// Reconstruct a data key from raw bytes (e.g. after unwrapping).
    pub fn from_bytes(bytes: [u8; KEY_LEN]) -> Self {
        Self(bytes)
    }

    /// Expose the raw key bytes. Narrow escape hatch for callers that must seal
    /// the key itself under another key (e.g. wrapping a vault key into local
    /// keyvault storage); prefer wrapping/sealing APIs everywhere else.
    pub fn to_bytes(&self) -> [u8; KEY_LEN] {
        self.0
    }

    /// Seal a payload under this key with a fresh random nonce. `aad` is
    /// authenticated but not encrypted.
    pub fn seal(&self, plaintext: &[u8], aad: &[u8]) -> Sealed {
        self.seal_with_nonce(random_nonce(), plaintext, aad)
    }

    /// Seal with a caller-supplied nonce. The nonce must never repeat under a
    /// given key, so this exists only for reproducible test vectors; production
    /// callers use [`seal`](Self::seal).
    pub fn seal_with_nonce(&self, nonce: [u8; NONCE_LEN], plaintext: &[u8], aad: &[u8]) -> Sealed {
        Sealed {
            nonce,
            ciphertext: aead_seal(&self.0, &nonce, plaintext, aad),
        }
    }

    /// Open a sealed payload. The same `aad` passed at seal time must be
    /// supplied; any mismatch or tampering yields [`EnvelopeError::Aead`].
    pub fn open(&self, sealed: &Sealed, aad: &[u8]) -> Result<Vec<u8>, EnvelopeError> {
        aead_open(&self.0, &sealed.nonce, &sealed.ciphertext, aad)
    }
}

/// A sealed payload: nonce plus AEAD ciphertext (the Poly1305 tag is appended to
/// the ciphertext). The canonical wire form is [`to_bytes`](Self::to_bytes):
/// `nonce(24) ‖ ciphertext+tag`.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Sealed {
    nonce: [u8; NONCE_LEN],
    ciphertext: Vec<u8>,
}

impl Sealed {
    /// Serialize to the canonical `nonce ‖ ciphertext+tag` byte form.
    pub fn to_bytes(&self) -> Vec<u8> {
        let mut out = Vec::with_capacity(NONCE_LEN + self.ciphertext.len());
        out.extend_from_slice(&self.nonce);
        out.extend_from_slice(&self.ciphertext);
        out
    }

    /// Parse the canonical byte form. Errors if shorter than a nonce plus tag.
    pub fn from_bytes(bytes: &[u8]) -> Result<Self, EnvelopeError> {
        if bytes.len() < NONCE_LEN + TAG_LEN {
            return Err(EnvelopeError::Format);
        }
        let mut nonce = [0u8; NONCE_LEN];
        nonce.copy_from_slice(&bytes[..NONCE_LEN]);
        Ok(Self {
            nonce,
            ciphertext: bytes[NONCE_LEN..].to_vec(),
        })
    }
}

/// A data key wrapped to a recipient's X25519 public key. Carries the ephemeral
/// public key the recipient needs to redo the DH. Canonical wire form is
/// `ephemeral_public(32) ‖ sealed_bytes`.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct WrappedKey {
    ephemeral_public: [u8; KEY_LEN],
    sealed: Sealed,
}

impl WrappedKey {
    /// Serialize to the canonical `ephemeral_public ‖ sealed` byte form.
    pub fn to_bytes(&self) -> Vec<u8> {
        let sealed = self.sealed.to_bytes();
        let mut out = Vec::with_capacity(KEY_LEN + sealed.len());
        out.extend_from_slice(&self.ephemeral_public);
        out.extend_from_slice(&sealed);
        out
    }

    /// Parse the canonical byte form.
    pub fn from_bytes(bytes: &[u8]) -> Result<Self, EnvelopeError> {
        if bytes.len() < KEY_LEN {
            return Err(EnvelopeError::Format);
        }
        let mut ephemeral_public = [0u8; KEY_LEN];
        ephemeral_public.copy_from_slice(&bytes[..KEY_LEN]);
        Ok(Self {
            ephemeral_public,
            sealed: Sealed::from_bytes(&bytes[KEY_LEN..])?,
        })
    }

    /// Unwrap with the recipient's X25519 secret and public key. Crate-internal;
    /// the public entry point is [`crate::keys::Identity::unwrap_key`], which
    /// keeps secret-key access inside `Identity`.
    pub(crate) fn open(
        &self,
        secret: &StaticSecret,
        recipient_public: &PublicKey,
    ) -> Result<DataKey, EnvelopeError> {
        let ephemeral_public = PublicKey::from(self.ephemeral_public);
        let shared = secret.diffie_hellman(&ephemeral_public);
        let mut wrap_key = derive_box_key(
            shared.as_bytes(),
            &self.ephemeral_public,
            recipient_public.as_bytes(),
            "wrap",
        );
        let plaintext = aead_open(&wrap_key, &self.sealed.nonce, &self.sealed.ciphertext, &[]);
        wrap_key.zeroize();

        let plaintext = plaintext?;
        let bytes: [u8; KEY_LEN] = plaintext.try_into().map_err(|_| EnvelopeError::Format)?;
        Ok(DataKey::from_bytes(bytes))
    }
}

/// Wrap a data key to a recipient's X25519 public key, using a fresh ephemeral
/// keypair and nonce. Only the holder of the recipient's secret can unwrap it.
pub fn wrap_key(recipient: &PublicKey, key: &DataKey) -> WrappedKey {
    let mut ephemeral_secret = [0u8; KEY_LEN];
    OsRng.fill_bytes(&mut ephemeral_secret);
    let wrapped = wrap_key_with_ephemeral(recipient, key, ephemeral_secret, random_nonce());
    ephemeral_secret.zeroize();
    wrapped
}

/// Wrap with a caller-supplied ephemeral secret and nonce. Both must be fresh
/// per wrap in production, so this exists only for reproducible test vectors;
/// production callers use [`wrap_key`].
pub fn wrap_key_with_ephemeral(
    recipient: &PublicKey,
    key: &DataKey,
    ephemeral_secret: [u8; KEY_LEN],
    nonce: [u8; NONCE_LEN],
) -> WrappedKey {
    let ephemeral_secret = StaticSecret::from(ephemeral_secret);
    let ephemeral_public = PublicKey::from(&ephemeral_secret);
    let shared = ephemeral_secret.diffie_hellman(recipient);
    let mut wrap_key = derive_box_key(
        shared.as_bytes(),
        ephemeral_public.as_bytes(),
        recipient.as_bytes(),
        "wrap",
    );
    let ciphertext = aead_seal(&wrap_key, &nonce, &key.0, &[]);
    wrap_key.zeroize();
    WrappedKey {
        ephemeral_public: ephemeral_public.to_bytes(),
        sealed: Sealed { nonce, ciphertext },
    }
}

/// The label domain-separating the mailbox message-body seal from the vault-key
/// wrap (both are ECIES to an X25519 recipient over the same primitives). Kept
/// beside the `"wrap"` uses above so the two operations stay visibly distinct.
const MAILBOX_BOX_LABEL: &str = "mailbox-box";

/// A payload sealed to a recipient's X25519 public key (ECIES / sealed box): the
/// same construction as [`WrappedKey`], generalized from a fixed 32-byte data key
/// to an arbitrary-length body. Carries the ephemeral public key the recipient
/// redoes the DH against. Canonical wire form is `ephemeral_public(32) ‖
/// sealed_bytes` (the same layout as [`WrappedKey`]). Used for the typed mailbox
/// message body (see [`crate::mailbox`]); only the recipient's X25519 secret can
/// open it, so the relay only ever forwards ciphertext.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SealedBox {
    ephemeral_public: [u8; KEY_LEN],
    sealed: Sealed,
}

impl SealedBox {
    /// Serialize to the canonical `ephemeral_public ‖ sealed` byte form.
    pub fn to_bytes(&self) -> Vec<u8> {
        let sealed = self.sealed.to_bytes();
        let mut out = Vec::with_capacity(KEY_LEN + sealed.len());
        out.extend_from_slice(&self.ephemeral_public);
        out.extend_from_slice(&sealed);
        out
    }

    /// Parse the canonical byte form.
    pub fn from_bytes(bytes: &[u8]) -> Result<Self, EnvelopeError> {
        if bytes.len() < KEY_LEN {
            return Err(EnvelopeError::Format);
        }
        let mut ephemeral_public = [0u8; KEY_LEN];
        ephemeral_public.copy_from_slice(&bytes[..KEY_LEN]);
        Ok(Self {
            ephemeral_public,
            sealed: Sealed::from_bytes(&bytes[KEY_LEN..])?,
        })
    }

    /// Open with the recipient's X25519 secret and public key. Crate-internal; the
    /// public entry point is [`crate::keys::Identity::open_sealed_box`], which
    /// keeps secret-key access inside `Identity` (mirroring [`WrappedKey::open`]).
    pub(crate) fn open(
        &self,
        secret: &StaticSecret,
        recipient_public: &PublicKey,
        aad: &[u8],
    ) -> Result<Vec<u8>, EnvelopeError> {
        let ephemeral_public = PublicKey::from(self.ephemeral_public);
        let shared = secret.diffie_hellman(&ephemeral_public);
        let mut box_key = derive_box_key(
            shared.as_bytes(),
            &self.ephemeral_public,
            recipient_public.as_bytes(),
            MAILBOX_BOX_LABEL,
        );
        let plaintext = aead_open(&box_key, &self.sealed.nonce, &self.sealed.ciphertext, aad);
        box_key.zeroize();
        plaintext
    }
}

/// Seal an arbitrary payload to a recipient's X25519 public key, using a fresh
/// ephemeral keypair and nonce. Only the holder of the recipient's secret can
/// open it. `aad` is authenticated but not encrypted.
pub fn seal_to(recipient: &PublicKey, plaintext: &[u8], aad: &[u8]) -> SealedBox {
    let mut ephemeral_secret = [0u8; KEY_LEN];
    OsRng.fill_bytes(&mut ephemeral_secret);
    let sealed =
        seal_to_with_ephemeral(recipient, plaintext, aad, ephemeral_secret, random_nonce());
    ephemeral_secret.zeroize();
    sealed
}

/// Seal with a caller-supplied ephemeral secret and nonce. Both must be fresh per
/// seal in production, so this exists only for reproducible test vectors;
/// production callers use [`seal_to`].
pub fn seal_to_with_ephemeral(
    recipient: &PublicKey,
    plaintext: &[u8],
    aad: &[u8],
    ephemeral_secret: [u8; KEY_LEN],
    nonce: [u8; NONCE_LEN],
) -> SealedBox {
    let ephemeral_secret = StaticSecret::from(ephemeral_secret);
    let ephemeral_public = PublicKey::from(&ephemeral_secret);
    let shared = ephemeral_secret.diffie_hellman(recipient);
    let mut box_key = derive_box_key(
        shared.as_bytes(),
        ephemeral_public.as_bytes(),
        recipient.as_bytes(),
        MAILBOX_BOX_LABEL,
    );
    let ciphertext = aead_seal(&box_key, &nonce, plaintext, aad);
    box_key.zeroize();
    SealedBox {
        ephemeral_public: ephemeral_public.to_bytes(),
        sealed: Sealed { nonce, ciphertext },
    }
}

/// Derive the 32-byte content-encryption key from the DH shared secret. The two
/// public keys are bound in as the HKDF salt, so the derivation is pinned to this
/// exchange; the `operation` label (via [`crate::version_label`]) both embeds the
/// contract major and domain-separates the two ECIES uses — wrapping a data key
/// (`"wrap"`) versus sealing a mailbox message body (`"mailbox-box"`) — so a
/// key-wrap can never be opened as a message-seal or vice versa.
fn derive_box_key(
    shared: &[u8],
    ephemeral_public: &[u8; KEY_LEN],
    recipient_public: &[u8; KEY_LEN],
    operation: &str,
) -> [u8; KEY_LEN] {
    let mut salt = [0u8; KEY_LEN * 2];
    salt[..KEY_LEN].copy_from_slice(ephemeral_public);
    salt[KEY_LEN..].copy_from_slice(recipient_public);
    let hk = Hkdf::<Sha256>::new(Some(&salt), shared);
    let info = crate::version_label(operation);
    let mut okm = [0u8; KEY_LEN];
    hk.expand(info.as_bytes(), &mut okm)
        .expect("HKDF expand of 32 bytes is always within bounds");
    okm
}

/// XChaCha20-Poly1305 seal. Infallible for in-memory buffers (it only errors on
/// absurdly large inputs that cannot occur here).
fn aead_seal(
    key: &[u8; KEY_LEN],
    nonce: &[u8; NONCE_LEN],
    plaintext: &[u8],
    aad: &[u8],
) -> Vec<u8> {
    XChaCha20Poly1305::new(Key::from_slice(key))
        .encrypt(
            XNonce::from_slice(nonce),
            Payload {
                msg: plaintext,
                aad,
            },
        )
        .expect("XChaCha20-Poly1305 sealing of an in-memory buffer cannot fail")
}

/// XChaCha20-Poly1305 open. Any authentication failure maps to the opaque
/// [`EnvelopeError::Aead`].
fn aead_open(
    key: &[u8; KEY_LEN],
    nonce: &[u8; NONCE_LEN],
    ciphertext: &[u8],
    aad: &[u8],
) -> Result<Vec<u8>, EnvelopeError> {
    XChaCha20Poly1305::new(Key::from_slice(key))
        .decrypt(
            XNonce::from_slice(nonce),
            Payload {
                msg: ciphertext,
                aad,
            },
        )
        .map_err(|_| EnvelopeError::Aead)
}

fn random_nonce() -> [u8; NONCE_LEN] {
    let mut nonce = [0u8; NONCE_LEN];
    OsRng.fill_bytes(&mut nonce);
    nonce
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::keys::Identity;

    #[test]
    fn seal_open_round_trip() {
        let key = DataKey::generate();
        let sealed = key.seal(b"blood pressure 118/76", b"event-id-1");
        assert_eq!(
            key.open(&sealed, b"event-id-1").unwrap(),
            b"blood pressure 118/76"
        );
    }

    #[test]
    fn open_rejects_tampered_ciphertext() {
        let key = DataKey::generate();
        let mut sealed = key.seal(b"secret", b"");
        sealed.ciphertext[0] ^= 0x01;
        assert!(matches!(key.open(&sealed, b""), Err(EnvelopeError::Aead)));
    }

    #[test]
    fn open_rejects_wrong_key() {
        let key = DataKey::generate();
        let sealed = key.seal(b"secret", b"");
        let other = DataKey::generate();
        assert!(matches!(other.open(&sealed, b""), Err(EnvelopeError::Aead)));
    }

    #[test]
    fn open_rejects_wrong_aad() {
        let key = DataKey::generate();
        let sealed = key.seal(b"secret", b"context-a");
        assert!(matches!(
            key.open(&sealed, b"context-b"),
            Err(EnvelopeError::Aead)
        ));
    }

    #[test]
    fn sealed_bytes_round_trip() {
        let key = DataKey::generate();
        let sealed = key.seal(b"payload", b"aad");
        let parsed = Sealed::from_bytes(&sealed.to_bytes()).unwrap();
        assert_eq!(key.open(&parsed, b"aad").unwrap(), b"payload");
    }

    #[test]
    fn sealed_from_bytes_rejects_short_input() {
        assert!(matches!(
            Sealed::from_bytes(&[0u8; 8]),
            Err(EnvelopeError::Format)
        ));
    }

    #[test]
    fn wrap_unwrap_round_trip() {
        let recipient = Identity::from_seed(b"recipient seed");
        let data_key = DataKey::generate();
        let key_bytes = *data_key_bytes(&data_key);

        let wrapped = wrap_key(&recipient.x25519_public(), &data_key);
        let unwrapped = recipient.unwrap_key(&wrapped).unwrap();
        assert_eq!(data_key_bytes(&unwrapped), &key_bytes);
    }

    #[test]
    fn wrapped_bytes_round_trip() {
        let recipient = Identity::from_seed(b"recipient seed");
        let data_key = DataKey::generate();
        let key_bytes = *data_key_bytes(&data_key);

        let wrapped = wrap_key(&recipient.x25519_public(), &data_key);
        let parsed = WrappedKey::from_bytes(&wrapped.to_bytes()).unwrap();
        let unwrapped = recipient.unwrap_key(&parsed).unwrap();
        assert_eq!(data_key_bytes(&unwrapped), &key_bytes);
    }

    #[test]
    fn unwrap_rejects_wrong_recipient() {
        let recipient = Identity::from_seed(b"recipient seed");
        let attacker = Identity::from_seed(b"attacker seed");
        let wrapped = wrap_key(&recipient.x25519_public(), &DataKey::generate());
        assert!(matches!(
            attacker.unwrap_key(&wrapped),
            Err(EnvelopeError::Aead)
        ));
    }

    /// Test-only peek at a data key's bytes, to assert wrap/unwrap preserves it.
    fn data_key_bytes(key: &DataKey) -> &[u8; KEY_LEN] {
        &key.0
    }

    #[test]
    fn sealed_box_round_trip() {
        let recipient = Identity::from_seed(b"recipient seed");
        let sealed = seal_to(
            &recipient.x25519_public(),
            b"a mailbox message body",
            b"aad",
        );
        let parsed = SealedBox::from_bytes(&sealed.to_bytes()).unwrap();
        assert_eq!(
            recipient.open_sealed_box(&parsed, b"aad").unwrap(),
            b"a mailbox message body"
        );
    }

    #[test]
    fn sealed_box_rejects_wrong_recipient() {
        let recipient = Identity::from_seed(b"recipient seed");
        let attacker = Identity::from_seed(b"attacker seed");
        let sealed = seal_to(&recipient.x25519_public(), b"secret", b"");
        assert!(matches!(
            attacker.open_sealed_box(&sealed, b""),
            Err(EnvelopeError::Aead)
        ));
    }

    #[test]
    fn sealed_box_rejects_wrong_aad() {
        let recipient = Identity::from_seed(b"recipient seed");
        let sealed = seal_to(&recipient.x25519_public(), b"secret", b"context-a");
        assert!(matches!(
            recipient.open_sealed_box(&sealed, b"context-b"),
            Err(EnvelopeError::Aead)
        ));
    }

    #[test]
    fn sealed_box_and_wrapped_key_are_domain_separated() {
        // A 32-byte payload sealed as a message body must NOT open as a wrapped
        // vault key even though both are ECIES to the same recipient: the two
        // derivations use different HKDF labels ("mailbox-box" vs "wrap").
        let recipient = Identity::from_seed(b"recipient seed");
        let key_bytes = [7u8; KEY_LEN];
        let sealed = seal_to(&recipient.x25519_public(), &key_bytes, b"");
        // Reinterpret the sealed-box bytes as a WrappedKey and try to unwrap.
        let as_wrapped = WrappedKey::from_bytes(&sealed.to_bytes()).unwrap();
        assert!(matches!(
            recipient.unwrap_key(&as_wrapped),
            Err(EnvelopeError::Aead)
        ));
    }

    // --- pinned spec vectors ---

    #[derive(serde::Deserialize)]
    struct VectorFile {
        contract_version: u32,
        sealing: Vec<SealVector>,
        wrapping: Vec<WrapVector>,
    }

    #[derive(serde::Deserialize)]
    struct SealVector {
        key_hex: String,
        nonce_hex: String,
        aad_hex: String,
        plaintext_hex: String,
        sealed_hex: String,
    }

    #[derive(serde::Deserialize)]
    struct WrapVector {
        recipient_seed_hex: String,
        recipient_x25519_public_hex: String,
        ephemeral_secret_hex: String,
        nonce_hex: String,
        data_key_hex: String,
        wrapped_hex: String,
    }

    const VECTORS: &str = include_str!("../../../spec/vectors/envelope.json");

    fn arr32(hex_str: &str) -> [u8; 32] {
        hex::decode(hex_str).unwrap().try_into().unwrap()
    }

    fn arr24(hex_str: &str) -> [u8; 24] {
        hex::decode(hex_str).unwrap().try_into().unwrap()
    }

    #[test]
    fn matches_spec_vectors() {
        let file: VectorFile = serde_json::from_str(VECTORS).expect("parse vectors");
        assert_eq!(
            file.contract_version,
            crate::CONTRACT_VERSION,
            "vectors are pinned to a different contract version"
        );

        for v in &file.sealing {
            let key = DataKey::from_bytes(arr32(&v.key_hex));
            let plaintext = hex::decode(&v.plaintext_hex).unwrap();
            let aad = hex::decode(&v.aad_hex).unwrap();

            // The construction must reproduce the pinned bytes exactly...
            let sealed = key.seal_with_nonce(arr24(&v.nonce_hex), &plaintext, &aad);
            assert_eq!(hex::encode(sealed.to_bytes()), v.sealed_hex, "seal bytes");

            // ...and the pinned ciphertext must open back to the plaintext.
            let from_pinned = Sealed::from_bytes(&hex::decode(&v.sealed_hex).unwrap()).unwrap();
            assert_eq!(key.open(&from_pinned, &aad).unwrap(), plaintext, "open");
        }

        for v in &file.wrapping {
            let recipient = Identity::from_seed(&hex::decode(&v.recipient_seed_hex).unwrap());
            assert_eq!(
                hex::encode(recipient.x25519_public().as_bytes()),
                v.recipient_x25519_public_hex,
                "recipient public",
            );
            let data_key_bytes = arr32(&v.data_key_hex);

            let wrapped = wrap_key_with_ephemeral(
                &recipient.x25519_public(),
                &DataKey::from_bytes(data_key_bytes),
                arr32(&v.ephemeral_secret_hex),
                arr24(&v.nonce_hex),
            );
            assert_eq!(hex::encode(wrapped.to_bytes()), v.wrapped_hex, "wrap bytes");

            let from_pinned =
                WrappedKey::from_bytes(&hex::decode(&v.wrapped_hex).unwrap()).unwrap();
            let unwrapped = recipient.unwrap_key(&from_pinned).unwrap();
            assert_eq!(unwrapped.0, data_key_bytes, "unwrap");
        }
    }
}
