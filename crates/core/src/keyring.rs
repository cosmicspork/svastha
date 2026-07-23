//! Key epochs: the vault key becomes a *keyring* of epoch keys so revocation can
//! rotate for real without ever bulk re-encrypting the log.
//!
//! An append-only event log earns an append-only key history. The original vault
//! data key is **epoch 0** (the *genesis* epoch). Rotation mints a fresh epoch
//! key; new blobs seal under the newest epoch, and existing blobs are never
//! re-sealed — their epoch key simply stays in the ring so they keep opening. The
//! `vault.key` blob, once a single self-wrapped key, becomes a [`Keyring`]: every
//! epoch key wrapped to the owner, serialized into one blob, still stored as-is
//! (it is how a restoring device obtains the keys, so it cannot itself be sealed
//! under them).
//!
//! ## Opaque, mergeable epoch ids
//!
//! Epoch ids are **opaque** (random for a rotation, a fixed zero sentinel for
//! genesis), never a sequence counter. Ordering lives in the keyring structure
//! ([`created_at`](KeyringEntry::created_at), tie-broken by id), not in the id
//! itself, so two replicas that rotate independently mint distinct ids instead of
//! colliding on the same integer. That is what lets keyrings from independent
//! sources [`merge`](Keyring::merge) by union: no id ever means two different
//! keys, so the union is unambiguous and every epoch key is retained.
//!
//! ## Epoch marker in the AAD (backward-compatible)
//!
//! A sealed blob binds its epoch to the ciphertext through the AEAD **associated
//! data**, so the relay never sees a rotation marker (it stays as blind to
//! rotation cadence as to everything else) yet a blob cannot be replayed under the
//! wrong epoch. The scheme is deliberately backward compatible:
//!
//! - **Genesis epoch** (id all-zero): `aad = blob_id` — byte-identical to the
//!   pre-epoch contract, so every blob sealed before epochs existed still opens.
//! - **Any rotated epoch**: `aad = blob_id ‖ 0x1f ‖ epoch_id`. The `0x1f` (unit
//!   separator) is outside the relay's blob-id charset `[A-Za-z0-9._-]`, so a
//!   marked AAD can never collide with a bare blob-id AAD of some other blob.
//!
//! The marker is not stored anywhere; [`open_blob`](Keyring::open_blob) simply
//! tries each epoch's `(key, aad)` pair until the AEAD authenticates. Because each
//! epoch has a distinct key, only the correct pair opens, so there is no epoch
//! confusion and nothing new leaks to the relay.
//!
//! ## Grandfathering the single-key `vault.key`
//!
//! A legacy `vault.key` is a bare [`WrappedKey`]. [`Keyring::from_bytes`] reads it
//! as a one-epoch genesis keyring (same posture as the mailbox's grandfathered
//! bare wrapped-key deposit): the container format carries a magic prefix a random
//! wrapped key does not, and a legacy key always falls back to the bare-wrapped
//! parse, so nothing an owner already stored becomes unreadable within the major.
//!
//! `spec/README.md` is the authoritative description and
//! `spec/vectors/keyring.json` pins the bytes.

use serde::{Deserialize, Serialize};
use x25519_dalek::PublicKey;

use crate::envelope::{
    wrap_key, wrap_key_with_ephemeral, DataKey, EnvelopeError, Sealed, WrappedKey,
};
use crate::keys::Identity;

/// Length of an opaque epoch id.
pub const EPOCH_ID_LEN: usize = 16;

/// The genesis epoch's id: all zero. Fixed (not random) so every device restored
/// from the same seed names epoch 0 identically and a union merge dedupes it to
/// one entry instead of forking the un-rotated vault.
const GENESIS_EPOCH_ID: [u8; EPOCH_ID_LEN] = [0u8; EPOCH_ID_LEN];

/// Magic prefix marking the keyring container, distinguishing it from a legacy
/// bare [`WrappedKey`] (whose leading bytes are a uniformly random X25519 public
/// key). See [`Keyring::from_bytes`].
const KEYRING_MAGIC: &[u8; 4] = b"svkr";

/// Keyring container format byte, bumped only if the *container framing* changes
/// (independent of [`crate::CONTRACT_VERSION`], like the mailbox envelope's `v`).
const KEYRING_FORMAT: u8 = 1;

/// Separator between the blob id and the epoch id in a rotated epoch's AAD. `0x1f`
/// (ASCII unit separator) is outside the relay's blob-id charset `[A-Za-z0-9._-]`,
/// so it can never appear inside a blob id — the marked and bare AAD forms stay
/// unambiguous.
const EPOCH_AAD_SEP: u8 = 0x1f;

/// Failures parsing a keyring from untrusted bytes.
#[derive(Debug, thiserror::Error)]
pub enum KeyringError {
    /// The bytes are neither a well-formed keyring container nor a bare
    /// [`WrappedKey`] (legacy `vault.key`).
    #[error("malformed keyring bytes")]
    Format,
}

/// One epoch in a [`Keyring`]: an epoch key wrapped to a recipient, tagged with an
/// opaque id and a creation clock. The wrapped recipient is the owner in a stored
/// `vault.key`, or a grantee in a re-wrapped handoff — the entry itself does not
/// record which.
#[derive(Clone, Debug)]
pub struct KeyringEntry {
    id: [u8; EPOCH_ID_LEN],
    created_at: i64,
    wrapped: WrappedKey,
}

impl KeyringEntry {
    /// The opaque epoch id.
    pub fn id(&self) -> [u8; EPOCH_ID_LEN] {
        self.id
    }

    /// The epoch id as lowercase hex.
    pub fn id_hex(&self) -> String {
        hex::encode(self.id)
    }

    /// The epoch's creation clock (Unix milliseconds); the merge ordering key.
    pub fn created_at(&self) -> i64 {
        self.created_at
    }

    /// Whether this is the genesis epoch (epoch 0), which seals with the bare
    /// `blob_id` AAD for backward compatibility.
    pub fn is_genesis(&self) -> bool {
        self.id == GENESIS_EPOCH_ID
    }

    /// The wrapped epoch key as its canonical wire bytes.
    pub fn wrapped_bytes(&self) -> Vec<u8> {
        self.wrapped.to_bytes()
    }
}

/// A keyring: the set of epoch keys behind one vault, newest sealing future blobs
/// while every earlier epoch keeps opening its own. Always holds at least one
/// entry (the genesis epoch).
#[derive(Clone, Debug)]
pub struct Keyring {
    entries: Vec<KeyringEntry>,
}

impl Keyring {
    /// Build a genesis keyring wrapping `key` (the vault's original data key) to
    /// `recipient`. This is the epoch-0 form a fresh vault publishes and the shape
    /// a legacy `vault.key` is read as.
    pub fn genesis(recipient: &PublicKey, key: &DataKey) -> Self {
        Self {
            entries: vec![KeyringEntry {
                id: GENESIS_EPOCH_ID,
                created_at: 0,
                wrapped: wrap_key(recipient, key),
            }],
        }
    }

    /// Genesis with a caller-supplied ephemeral secret and nonce — reproducible,
    /// so only for test vectors; production callers use [`genesis`](Self::genesis).
    pub fn genesis_with(
        recipient: &PublicKey,
        key: &DataKey,
        ephemeral_secret: [u8; 32],
        nonce: [u8; 24],
    ) -> Self {
        Self {
            entries: vec![KeyringEntry {
                id: GENESIS_EPOCH_ID,
                created_at: 0,
                wrapped: wrap_key_with_ephemeral(recipient, key, ephemeral_secret, nonce),
            }],
        }
    }

    /// The epochs in canonical order: ascending `(created_at, id)`. Serialization
    /// and merge both use this so the same set of epochs always produces the same
    /// bytes regardless of insertion order.
    pub fn entries(&self) -> Vec<&KeyringEntry> {
        let mut refs: Vec<&KeyringEntry> = self.entries.iter().collect();
        refs.sort_by_key(|e| (e.created_at, e.id));
        refs
    }

    /// The newest epoch: the maximum by `(created_at, id)`. Future blobs seal under
    /// it. Deterministic across replicas that hold the same epochs, so a merged
    /// keyring agrees on which epoch is current without a shared clock.
    pub fn newest(&self) -> &KeyringEntry {
        self.entries
            .iter()
            .max_by(|a, b| (a.created_at, a.id).cmp(&(b.created_at, b.id)))
            .expect("a keyring always holds at least the genesis epoch")
    }

    /// The AAD for a blob sealed under `entry`: bare `blob_id` for genesis (the
    /// pre-epoch contract), or `blob_id ‖ 0x1f ‖ epoch_id` for a rotated epoch.
    fn entry_aad(entry: &KeyringEntry, blob_id: &[u8]) -> Vec<u8> {
        if entry.is_genesis() {
            blob_id.to_vec()
        } else {
            let mut aad = Vec::with_capacity(blob_id.len() + 1 + EPOCH_ID_LEN);
            aad.extend_from_slice(blob_id);
            aad.push(EPOCH_AAD_SEP);
            aad.extend_from_slice(&entry.id);
            aad
        }
    }

    /// Unwrap the newest epoch's data key with the owner's identity — the key new
    /// blobs seal under.
    pub fn newest_key(&self, owner: &Identity) -> Result<DataKey, EnvelopeError> {
        owner.unwrap_key(&self.newest().wrapped)
    }

    /// Seal `plaintext` for `blob_id` under the newest epoch, binding the epoch
    /// marker into the AAD. Returns the sealed wire bytes (`nonce ‖ ciphertext`).
    pub fn seal_blob(
        &self,
        owner: &Identity,
        blob_id: &[u8],
        plaintext: &[u8],
    ) -> Result<Vec<u8>, EnvelopeError> {
        let entry = self.newest();
        let key = owner.unwrap_key(&entry.wrapped)?;
        let aad = Self::entry_aad(entry, blob_id);
        Ok(key.seal(plaintext, &aad).to_bytes())
    }

    /// Seal with a caller-supplied nonce — reproducible, so only for test vectors;
    /// production callers use [`seal_blob`](Self::seal_blob).
    pub fn seal_blob_with_nonce(
        &self,
        owner: &Identity,
        blob_id: &[u8],
        plaintext: &[u8],
        nonce: [u8; 24],
    ) -> Result<Vec<u8>, EnvelopeError> {
        let entry = self.newest();
        let key = owner.unwrap_key(&entry.wrapped)?;
        let aad = Self::entry_aad(entry, blob_id);
        Ok(key.seal_with_nonce(nonce, plaintext, &aad).to_bytes())
    }

    /// Open a blob sealed under *some* epoch of this ring: try each epoch's
    /// `(key, aad)` pair until the AEAD authenticates. A pre-epoch blob opens under
    /// the genesis pair (bare `blob_id`); a rotated blob under its marked pair.
    /// Only the correct pair authenticates, so trial decryption cannot cross
    /// epochs. Returns [`EnvelopeError::Aead`] if no epoch opens it.
    pub fn open_blob(
        &self,
        owner: &Identity,
        blob_id: &[u8],
        sealed_wire: &[u8],
    ) -> Result<Vec<u8>, EnvelopeError> {
        let sealed = Sealed::from_bytes(sealed_wire)?;
        // Newest-first: the common case is a freshly-sealed blob under the current
        // epoch, so try it before older ones.
        let mut candidates = self.entries();
        candidates.reverse();
        for entry in candidates {
            let Ok(key) = owner.unwrap_key(&entry.wrapped) else {
                continue;
            };
            let aad = Self::entry_aad(entry, blob_id);
            if let Ok(plaintext) = key.open(&sealed, &aad) {
                return Ok(plaintext);
            }
        }
        Err(EnvelopeError::Aead)
    }

    /// Mint the next epoch: a fresh random data key wrapped to `recipient` under a
    /// fresh random id, marked `created_at`. Returns the extended keyring and the
    /// new data key (so the caller can seal immediately without re-unwrapping).
    pub fn rotate(&self, recipient: &PublicKey, created_at: i64) -> (Self, DataKey) {
        let new_key = DataKey::generate();
        let id = random_epoch_id();
        let ring = self.with_new_epoch(id, created_at, wrap_key(recipient, &new_key));
        (ring, new_key)
    }

    /// Rotate with caller-supplied new key, id, ephemeral secret, and nonce —
    /// reproducible, so only for test vectors; production callers use
    /// [`rotate`](Self::rotate).
    pub fn rotate_with(
        &self,
        recipient: &PublicKey,
        new_key: &DataKey,
        id: [u8; EPOCH_ID_LEN],
        created_at: i64,
        ephemeral_secret: [u8; 32],
        nonce: [u8; 24],
    ) -> Self {
        let wrapped = wrap_key_with_ephemeral(recipient, new_key, ephemeral_secret, nonce);
        self.with_new_epoch(id, created_at, wrapped)
    }

    fn with_new_epoch(&self, id: [u8; EPOCH_ID_LEN], created_at: i64, wrapped: WrappedKey) -> Self {
        let mut entries = self.entries.clone();
        entries.push(KeyringEntry {
            id,
            created_at,
            wrapped,
        });
        Self { entries }
    }

    /// Merge two keyrings by **union of epochs**, keyed on the opaque id. Two
    /// entries can never share an id unless they name the same epoch key, so the
    /// union keeps every distinct key and loses none — the property that lets
    /// keyrings from independent sources reconcile. Commutative and deterministic:
    /// where both rings carry an id, the entry with the lexicographically greater
    /// wrapped bytes wins (an arbitrary but order-independent tiebreak; such
    /// entries wrap the same key, so the choice affects only the exact bytes).
    pub fn merge(a: &Keyring, b: &Keyring) -> Keyring {
        let mut merged: Vec<KeyringEntry> = Vec::new();
        for entry in a.entries.iter().chain(b.entries.iter()) {
            match merged.iter_mut().find(|e| e.id == entry.id) {
                Some(existing) => {
                    if entry.wrapped.to_bytes() > existing.wrapped.to_bytes() {
                        *existing = entry.clone();
                    }
                }
                None => merged.push(entry.clone()),
            }
        }
        Keyring { entries: merged }
    }

    /// Re-wrap every epoch key from the owner to a grantee, preserving ids and
    /// creation clocks. This is the keyring a still-trusted grantee receives in a
    /// `key_handoff` on re-keying: it can open every past and current epoch. A
    /// revoked identity is simply never handed the new ring. Errors if any epoch
    /// fails to unwrap under `owner` (not the owner's ring).
    pub fn wrap_for_grantee(
        &self,
        owner: &Identity,
        grantee: &PublicKey,
    ) -> Result<Keyring, EnvelopeError> {
        let mut entries = Vec::with_capacity(self.entries.len());
        for entry in self.entries() {
            let key = owner.unwrap_key(&entry.wrapped)?;
            entries.push(KeyringEntry {
                id: entry.id,
                created_at: entry.created_at,
                wrapped: wrap_key(grantee, &key),
            });
        }
        Ok(Keyring { entries })
    }

    /// Wrap-for-grantee with a caller-supplied ephemeral secret and nonce per epoch
    /// (in canonical [`entries`](Self::entries) order) — reproducible, so only for
    /// test vectors; production callers use
    /// [`wrap_for_grantee`](Self::wrap_for_grantee).
    pub fn wrap_for_grantee_with(
        &self,
        owner: &Identity,
        grantee: &PublicKey,
        ephemerals: &[([u8; 32], [u8; 24])],
    ) -> Result<Keyring, EnvelopeError> {
        let ordered = self.entries();
        assert_eq!(
            ordered.len(),
            ephemerals.len(),
            "one ephemeral pair per epoch is required"
        );
        let mut entries = Vec::with_capacity(ordered.len());
        for (entry, &(ephemeral_secret, nonce)) in ordered.iter().zip(ephemerals) {
            let key = owner.unwrap_key(&entry.wrapped)?;
            entries.push(KeyringEntry {
                id: entry.id,
                created_at: entry.created_at,
                wrapped: wrap_key_with_ephemeral(grantee, &key, ephemeral_secret, nonce),
            });
        }
        Ok(Keyring { entries })
    }

    /// Serialize to the canonical container form:
    /// `magic ‖ format ‖ count(u32) ‖ [ id(16) ‖ created_at(i64) ‖ len(u32) ‖
    /// wrapped ]…`, epochs in canonical order (integers big-endian). Deterministic,
    /// so re-serializing the same epochs yields identical `vault.key` bytes.
    pub fn to_bytes(&self) -> Vec<u8> {
        let ordered = self.entries();
        let mut out = Vec::new();
        out.extend_from_slice(KEYRING_MAGIC);
        out.push(KEYRING_FORMAT);
        out.extend_from_slice(&(ordered.len() as u32).to_be_bytes());
        for entry in ordered {
            out.extend_from_slice(&entry.id);
            out.extend_from_slice(&entry.created_at.to_be_bytes());
            let wrapped = entry.wrapped.to_bytes();
            out.extend_from_slice(&(wrapped.len() as u32).to_be_bytes());
            out.extend_from_slice(&wrapped);
        }
        out
    }

    /// Parse `vault.key` bytes: the typed keyring container, or a legacy bare
    /// [`WrappedKey`] read as a one-epoch genesis keyring. The container's magic
    /// prefix disambiguates the two; a legacy key always falls back to the
    /// bare-wrapped parse, so a `vault.key` written before epochs stays readable
    /// (grandfathering within the major).
    pub fn from_bytes(bytes: &[u8]) -> Result<Keyring, KeyringError> {
        if bytes.len() >= KEYRING_MAGIC.len() && &bytes[..KEYRING_MAGIC.len()] == KEYRING_MAGIC {
            if let Ok(ring) = parse_container(bytes) {
                return Ok(ring);
            }
            // Fall through: an (astronomically unlikely) legacy key whose random
            // leading bytes equal the magic still recovers via the bare parse.
        }
        match WrappedKey::from_bytes(bytes) {
            Ok(wrapped) => Ok(Keyring {
                entries: vec![KeyringEntry {
                    id: GENESIS_EPOCH_ID,
                    created_at: 0,
                    wrapped,
                }],
            }),
            Err(_) => Err(KeyringError::Format),
        }
    }
}

/// Parse the typed container. Errors on any framing inconsistency (bad format
/// byte, truncation, trailing bytes, or a wrapped key that will not parse).
fn parse_container(bytes: &[u8]) -> Result<Keyring, KeyringError> {
    let mut cur = &bytes[KEYRING_MAGIC.len()..];
    let format = take(&mut cur, 1)?[0];
    if format != KEYRING_FORMAT {
        return Err(KeyringError::Format);
    }
    let count = u32::from_be_bytes(take(&mut cur, 4)?.try_into().unwrap());
    let mut entries = Vec::with_capacity(count as usize);
    for _ in 0..count {
        let id: [u8; EPOCH_ID_LEN] = take(&mut cur, EPOCH_ID_LEN)?.try_into().unwrap();
        let created_at = i64::from_be_bytes(take(&mut cur, 8)?.try_into().unwrap());
        let len = u32::from_be_bytes(take(&mut cur, 4)?.try_into().unwrap()) as usize;
        let wrapped =
            WrappedKey::from_bytes(take(&mut cur, len)?).map_err(|_| KeyringError::Format)?;
        entries.push(KeyringEntry {
            id,
            created_at,
            wrapped,
        });
    }
    if !cur.is_empty() || entries.is_empty() {
        return Err(KeyringError::Format);
    }
    Ok(Keyring { entries })
}

/// Split `n` bytes off the front of `cur`, advancing it; error on truncation.
fn take<'a>(cur: &mut &'a [u8], n: usize) -> Result<&'a [u8], KeyringError> {
    if cur.len() < n {
        return Err(KeyringError::Format);
    }
    let (head, tail) = cur.split_at(n);
    *cur = tail;
    Ok(head)
}

/// A fresh random epoch id. Opaque by design (see the module docs): ordering is
/// carried by the keyring, not the id, so two replicas never collide on a counter.
fn random_epoch_id() -> [u8; EPOCH_ID_LEN] {
    use rand_core::{OsRng, RngCore};
    let mut id = [0u8; EPOCH_ID_LEN];
    OsRng.fill_bytes(&mut id);
    id
}

/// Serde adapter for the wire form of a keyring inside JSON (the `key_handoff`
/// body carries a wrapped keyring as hex). The keyring itself serializes through
/// [`Keyring::to_bytes`]/[`Keyring::from_bytes`]; this lets a [`Keyring`] ride as a
/// hex string field where that is convenient.
impl Serialize for Keyring {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&hex::encode(self.to_bytes()))
    }
}

impl<'de> Deserialize<'de> for Keyring {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let s = String::deserialize(deserializer)?;
        let bytes = hex::decode(&s).map_err(serde::de::Error::custom)?;
        Keyring::from_bytes(&bytes).map_err(serde::de::Error::custom)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn owner() -> Identity {
        Identity::from_seed(b"keyring owner seed")
    }

    fn grantee() -> Identity {
        Identity::from_seed(b"keyring grantee seed")
    }

    #[test]
    fn genesis_round_trips_through_bytes() {
        let owner = owner();
        let key = DataKey::generate();
        let key_bytes = key.to_bytes();
        let ring = Keyring::genesis(&owner.x25519_public(), &key);
        assert!(ring.newest().is_genesis());

        let parsed = Keyring::from_bytes(&ring.to_bytes()).unwrap();
        assert_eq!(parsed.newest_key(&owner).unwrap().to_bytes(), key_bytes);
    }

    #[test]
    fn legacy_wrapped_key_reads_as_genesis() {
        // A bare WrappedKey (today's vault.key) parses as a one-epoch genesis ring.
        let owner = owner();
        let key = DataKey::generate();
        let key_bytes = key.to_bytes();
        let wrapped = wrap_key(&owner.x25519_public(), &key);

        let ring = Keyring::from_bytes(&wrapped.to_bytes()).unwrap();
        assert_eq!(ring.entries().len(), 1);
        assert!(ring.newest().is_genesis());
        assert_eq!(ring.newest_key(&owner).unwrap().to_bytes(), key_bytes);
    }

    #[test]
    fn pre_epoch_blob_opens_under_genesis() {
        // A blob sealed the old way (bare blob_id AAD, under the vault key) must
        // still open once that key is the genesis epoch.
        let owner = owner();
        let key = DataKey::generate();
        let blob_id = b"ev-abc123";
        let sealed = key.seal(b"blood pressure 118/76", blob_id).to_bytes();

        let ring = Keyring::genesis(&owner.x25519_public(), &key);
        assert_eq!(
            ring.open_blob(&owner, blob_id, &sealed).unwrap(),
            b"blood pressure 118/76"
        );
    }

    #[test]
    fn rotate_seals_new_and_opens_old() {
        let owner = owner();
        let pk = owner.x25519_public();
        let genesis_key = DataKey::generate();
        let ring = Keyring::genesis(&pk, &genesis_key);

        // A blob under genesis (bare AAD).
        let old_blob = b"ev-old";
        let old_sealed = ring.seal_blob(&owner, old_blob, b"old payload").unwrap();

        // Rotate; a new blob seals under the new epoch (marked AAD).
        let (rotated, _new_key) = ring.rotate(&pk, 1_753_000_000_000);
        assert!(!rotated.newest().is_genesis());
        let new_blob = b"ev-new";
        let new_sealed = rotated.seal_blob(&owner, new_blob, b"new payload").unwrap();

        // Both open through the rotated ring; neither opens under the wrong AAD.
        assert_eq!(
            rotated.open_blob(&owner, old_blob, &old_sealed).unwrap(),
            b"old payload"
        );
        assert_eq!(
            rotated.open_blob(&owner, new_blob, &new_sealed).unwrap(),
            b"new payload"
        );
    }

    #[test]
    fn rotated_blob_binds_its_epoch() {
        // A blob sealed under a rotated epoch must NOT open if presented under a
        // different blob id (the AAD carries both the id and the epoch marker).
        let owner = owner();
        let pk = owner.x25519_public();
        let ring = Keyring::genesis(&pk, &DataKey::generate());
        let (rotated, _k) = ring.rotate(&pk, 1);
        let sealed = rotated.seal_blob(&owner, b"ev-real", b"payload").unwrap();
        assert!(rotated.open_blob(&owner, b"ev-swapped", &sealed).is_err());
    }

    #[test]
    fn newest_selection_ignores_id_order() {
        // The newest epoch is chosen by created_at, not by id magnitude: an epoch
        // with a small id but a later clock still wins.
        let owner = owner();
        let pk = owner.x25519_public();
        let ring = Keyring::genesis(&pk, &DataKey::generate());
        let later = DataKey::generate();
        let later_bytes = later.to_bytes();
        let ring = ring.rotate_with(
            &pk,
            &later,
            [0x01; EPOCH_ID_LEN],
            2_000,
            [9u8; 32],
            [8u8; 24],
        );
        let earlier = DataKey::generate();
        let ring = ring.rotate_with(
            &pk,
            &earlier,
            [0xff; EPOCH_ID_LEN],
            1_000,
            [7u8; 32],
            [6u8; 24],
        );
        // Highest created_at (2000) wins even though its id (0x01…) is smaller.
        assert_eq!(ring.newest().created_at(), 2_000);
        assert_eq!(ring.newest_key(&owner).unwrap().to_bytes(), later_bytes);
    }

    #[test]
    fn merge_is_union_and_commutative() {
        let owner = owner();
        let pk = owner.x25519_public();
        let genesis_key = DataKey::generate();
        let base = Keyring::genesis(&pk, &genesis_key);

        // Two independent rotations off the same genesis (diverged replicas).
        let a = base.rotate_with(
            &pk,
            &DataKey::generate(),
            [0xaa; EPOCH_ID_LEN],
            10,
            [1u8; 32],
            [1u8; 24],
        );
        let b = base.rotate_with(
            &pk,
            &DataKey::generate(),
            [0xbb; EPOCH_ID_LEN],
            20,
            [2u8; 32],
            [2u8; 24],
        );

        let ab = Keyring::merge(&a, &b);
        let ba = Keyring::merge(&b, &a);
        // Union: genesis + both rotations = 3 epochs.
        assert_eq!(ab.entries().len(), 3);
        // Commutative: byte-identical regardless of argument order.
        assert_eq!(ab.to_bytes(), ba.to_bytes());
        // Newest is the later rotation (created_at 20).
        assert_eq!(ab.newest().created_at(), 20);
        assert_eq!(ab.newest().id(), [0xbb; EPOCH_ID_LEN]);
    }

    #[test]
    fn merge_dedupes_genesis() {
        // Two devices each build their own genesis wrapping of the same key: the
        // fixed genesis id dedupes them to one epoch instead of forking the vault.
        let owner = owner();
        let pk = owner.x25519_public();
        let key = DataKey::generate();
        let a = Keyring::genesis(&pk, &key);
        let b = Keyring::genesis(&pk, &key);
        let merged = Keyring::merge(&a, &b);
        assert_eq!(merged.entries().len(), 1);
        assert!(merged.newest().is_genesis());
    }

    #[test]
    fn grantee_can_open_every_epoch_after_rekey() {
        let owner = owner();
        let grantee = grantee();
        let pk = owner.x25519_public();

        // Owner's ring: genesis + one rotation, with a blob under each epoch.
        let ring = Keyring::genesis(&pk, &DataKey::generate());
        let genesis_blob = ring.seal_blob(&owner, b"ev-g", b"genesis data").unwrap();
        let (ring, _k) = ring.rotate(&pk, 100);
        let rotated_blob = ring.seal_blob(&owner, b"ev-r", b"rotated data").unwrap();

        // Re-key to the grantee; it opens both epochs' blobs.
        let for_grantee = ring
            .wrap_for_grantee(&owner, &grantee.x25519_public())
            .unwrap();
        assert_eq!(
            for_grantee
                .open_blob(&grantee, b"ev-g", &genesis_blob)
                .unwrap(),
            b"genesis data"
        );
        assert_eq!(
            for_grantee
                .open_blob(&grantee, b"ev-r", &rotated_blob)
                .unwrap(),
            b"rotated data"
        );
        // The owner's ring does not open for the grantee (wrapped to the owner).
        assert!(ring.open_blob(&grantee, b"ev-g", &genesis_blob).is_err());
    }

    #[test]
    fn from_bytes_rejects_garbage() {
        assert!(matches!(
            Keyring::from_bytes(b"short"),
            Err(KeyringError::Format)
        ));
        // Magic present but truncated container: recovers via bare-wrapped parse or
        // errors — never panics.
        let mut bad = KEYRING_MAGIC.to_vec();
        bad.push(KEYRING_FORMAT);
        let _ = Keyring::from_bytes(&bad);
    }

    // --- pinned spec vectors ---

    #[derive(Deserialize)]
    struct VectorFile {
        contract_version: u32,
        genesis_legacy: LegacyGenesisVector,
        multi_epoch: MultiEpochVector,
        rotated_blob: BlobVector,
        pre_epoch_blob: BlobVector,
        merge: MergeVector,
    }

    #[derive(Deserialize)]
    struct LegacyGenesisVector {
        note: String,
        owner_seed_hex: String,
        data_key_hex: String,
        /// The legacy bare WrappedKey bytes (today's vault.key).
        legacy_vault_key_hex: String,
    }

    #[derive(Deserialize)]
    struct EpochSpec {
        id_hex: String,
        created_at: i64,
        data_key_hex: String,
        ephemeral_secret_hex: String,
        nonce_hex: String,
    }

    #[derive(Deserialize)]
    struct MultiEpochVector {
        note: String,
        owner_seed_hex: String,
        owner_x25519_public_hex: String,
        /// Genesis first, then rotations in order.
        epochs: Vec<EpochSpec>,
        /// The serialized keyring container.
        keyring_hex: String,
        /// The id the newest-selection must pick.
        newest_id_hex: String,
    }

    #[derive(Deserialize)]
    struct BlobVector {
        note: String,
        owner_seed_hex: String,
        blob_id: String,
        plaintext_hex: String,
        seal_nonce_hex: String,
        /// The AAD the seal binds (bare blob id, or blob id ‖ 0x1f ‖ epoch id).
        aad_hex: String,
        /// The keyring the blob seals/opens under.
        keyring_hex: String,
        /// The sealed wire bytes.
        sealed_hex: String,
    }

    #[derive(Deserialize)]
    struct MergeVector {
        note: String,
        owner_seed_hex: String,
        keyring_a_hex: String,
        keyring_b_hex: String,
        merged_hex: String,
        newest_id_hex: String,
    }

    const VECTORS: &str = include_str!("../../../spec/vectors/keyring.json");

    fn arr16(s: &str) -> [u8; 16] {
        hex::decode(s).unwrap().try_into().unwrap()
    }

    fn arr24(s: &str) -> [u8; 24] {
        hex::decode(s).unwrap().try_into().unwrap()
    }

    fn arr32(s: &str) -> [u8; 32] {
        hex::decode(s).unwrap().try_into().unwrap()
    }

    /// Rebuild the multi-epoch keyring from its pinned epoch specs.
    fn build_multi(v: &MultiEpochVector, owner: &Identity) -> Keyring {
        let pk = owner.x25519_public();
        let mut it = v.epochs.iter();
        let g = it.next().unwrap();
        let mut ring = Keyring::genesis_with(
            &pk,
            &DataKey::from_bytes(arr32(&g.data_key_hex)),
            arr32(&g.ephemeral_secret_hex),
            arr24(&g.nonce_hex),
        );
        for e in it {
            ring = ring.rotate_with(
                &pk,
                &DataKey::from_bytes(arr32(&e.data_key_hex)),
                arr16(&e.id_hex),
                e.created_at,
                arr32(&e.ephemeral_secret_hex),
                arr24(&e.nonce_hex),
            );
        }
        ring
    }

    #[test]
    fn matches_spec_vectors() {
        let file: VectorFile = serde_json::from_str(VECTORS).expect("parse vectors");
        assert_eq!(
            file.contract_version,
            crate::CONTRACT_VERSION,
            "vectors are pinned to a different contract version"
        );

        // Legacy single-key vault.key parses as genesis and unwraps.
        {
            let v = &file.genesis_legacy;
            let owner = Identity::from_seed(&hex::decode(&v.owner_seed_hex).unwrap());
            let ring = Keyring::from_bytes(&hex::decode(&v.legacy_vault_key_hex).unwrap()).unwrap();
            assert_eq!(ring.entries().len(), 1, "{}", v.note);
            assert!(ring.newest().is_genesis(), "{}", v.note);
            assert_eq!(
                hex::encode(ring.newest_key(&owner).unwrap().to_bytes()),
                v.data_key_hex,
                "{}",
                v.note
            );
        }

        // Multi-epoch keyring: pinned bytes and newest selection.
        {
            let v = &file.multi_epoch;
            let owner = Identity::from_seed(&hex::decode(&v.owner_seed_hex).unwrap());
            assert_eq!(
                hex::encode(owner.x25519_public().as_bytes()),
                v.owner_x25519_public_hex,
                "{}",
                v.note
            );
            let ring = build_multi(v, &owner);
            assert_eq!(
                hex::encode(ring.to_bytes()),
                v.keyring_hex,
                "keyring: {}",
                v.note
            );
            assert_eq!(
                hex::encode(ring.newest().id()),
                v.newest_id_hex,
                "newest: {}",
                v.note
            );
            // Re-parse reproduces the same newest key.
            let parsed = Keyring::from_bytes(&hex::decode(&v.keyring_hex).unwrap()).unwrap();
            assert_eq!(
                hex::encode(parsed.newest().id()),
                v.newest_id_hex,
                "{}",
                v.note
            );
        }

        // A blob sealed under a non-zero epoch: AAD binding and sealed bytes pinned.
        {
            let v = &file.rotated_blob;
            let owner = Identity::from_seed(&hex::decode(&v.owner_seed_hex).unwrap());
            let ring = Keyring::from_bytes(&hex::decode(&v.keyring_hex).unwrap()).unwrap();
            let plaintext = hex::decode(&v.plaintext_hex).unwrap();
            // The newest (rotated) epoch's marked AAD is what pins here.
            assert!(!ring.newest().is_genesis(), "{}", v.note);
            assert_eq!(
                hex::encode(Keyring::entry_aad(ring.newest(), v.blob_id.as_bytes())),
                v.aad_hex,
                "aad: {}",
                v.note
            );
            let sealed = ring
                .seal_blob_with_nonce(
                    &owner,
                    v.blob_id.as_bytes(),
                    &plaintext,
                    arr24(&v.seal_nonce_hex),
                )
                .unwrap();
            assert_eq!(hex::encode(&sealed), v.sealed_hex, "sealed: {}", v.note);
            assert_eq!(
                ring.open_blob(
                    &owner,
                    v.blob_id.as_bytes(),
                    &hex::decode(&v.sealed_hex).unwrap()
                )
                .unwrap(),
                plaintext,
                "open: {}",
                v.note
            );
        }

        // A pre-epoch blob (bare blob_id AAD) still opens under genesis.
        {
            let v = &file.pre_epoch_blob;
            let owner = Identity::from_seed(&hex::decode(&v.owner_seed_hex).unwrap());
            let ring = Keyring::from_bytes(&hex::decode(&v.keyring_hex).unwrap()).unwrap();
            let plaintext = hex::decode(&v.plaintext_hex).unwrap();
            assert!(ring.newest().is_genesis(), "{}", v.note);
            assert_eq!(
                v.aad_hex,
                hex::encode(v.blob_id.as_bytes()),
                "bare aad: {}",
                v.note
            );
            let sealed = ring
                .seal_blob_with_nonce(
                    &owner,
                    v.blob_id.as_bytes(),
                    &plaintext,
                    arr24(&v.seal_nonce_hex),
                )
                .unwrap();
            assert_eq!(hex::encode(&sealed), v.sealed_hex, "sealed: {}", v.note);
            assert_eq!(
                ring.open_blob(
                    &owner,
                    v.blob_id.as_bytes(),
                    &hex::decode(&v.sealed_hex).unwrap()
                )
                .unwrap(),
                plaintext,
                "open: {}",
                v.note
            );
        }

        // Union merge: pinned merged bytes and newest selection.
        {
            let v = &file.merge;
            let _owner = Identity::from_seed(&hex::decode(&v.owner_seed_hex).unwrap());
            let a = Keyring::from_bytes(&hex::decode(&v.keyring_a_hex).unwrap()).unwrap();
            let b = Keyring::from_bytes(&hex::decode(&v.keyring_b_hex).unwrap()).unwrap();
            let merged = Keyring::merge(&a, &b);
            assert_eq!(
                hex::encode(merged.to_bytes()),
                v.merged_hex,
                "merged: {}",
                v.note
            );
            assert_eq!(
                hex::encode(merged.newest().id()),
                v.newest_id_hex,
                "newest: {}",
                v.note
            );
            // Commutative.
            assert_eq!(
                Keyring::merge(&b, &a).to_bytes(),
                merged.to_bytes(),
                "{}",
                v.note
            );
        }
    }
}
