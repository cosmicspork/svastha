//! Generates `spec/vectors/keyring.json` from the implementation. Run:
//!   cargo run -p svastha-core --example keyring_vectors > spec/vectors/keyring.json
//! The committed vectors are the frozen output of this; rerun only on a
//! deliberate, version-bumped contract change.
//!
//! Inputs (seeds, data keys, epoch ids, ephemeral secrets, nonces) are fixed so
//! the output is reproducible; production code draws all of these from the OS RNG.

use serde_json::{json, Value};
use svastha_core::envelope::{wrap_key_with_ephemeral, DataKey};
use svastha_core::keyring::{Keyring, EPOCH_ID_LEN};
use svastha_core::keys::Identity;
use svastha_core::CONTRACT_VERSION;

const OWNER_SEED: &str = "2121212121212121212121212121212121212121212121212121212121212121";

// Epoch marker separator, mirrored from the contract (keyring.rs EPOCH_AAD_SEP)
// so the vector pins the exact AAD a rotated epoch binds.
const EPOCH_AAD_SEP: u8 = 0x1f;

fn arr16(s: &str) -> [u8; 16] {
    hex::decode(s).unwrap().try_into().unwrap()
}

fn arr24(s: &str) -> [u8; 24] {
    hex::decode(s).unwrap().try_into().unwrap()
}

fn arr32(s: &str) -> [u8; 32] {
    hex::decode(s).unwrap().try_into().unwrap()
}

/// The AAD a keyring binds for `blob_id` under `epoch_id`: bare id for genesis
/// (all-zero id), else `blob_id ‖ 0x1f ‖ epoch_id`.
fn aad(blob_id: &str, epoch_id: &[u8; EPOCH_ID_LEN]) -> Vec<u8> {
    if *epoch_id == [0u8; EPOCH_ID_LEN] {
        blob_id.as_bytes().to_vec()
    } else {
        let mut out = blob_id.as_bytes().to_vec();
        out.push(EPOCH_AAD_SEP);
        out.extend_from_slice(epoch_id);
        out
    }
}

fn owner() -> Identity {
    Identity::from_seed(&hex::decode(OWNER_SEED).unwrap())
}

// Genesis epoch material, shared across several vectors.
const GENESIS_KEY: &str = "a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0";
const GENESIS_EPHEMERAL: &str = "3030303030303030303030303030303030303030303030303030303030303030";
const GENESIS_NONCE: &str = "404040404040404040404040404040404040404040404040";

// Rotation 1.
const ROT1_ID: &str = "11111111111111111111111111111111";
const ROT1_KEY: &str = "b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1";
const ROT1_EPHEMERAL: &str = "3131313131313131313131313131313131313131313131313131313131313131";
const ROT1_NONCE: &str = "414141414141414141414141414141414141414141414141";
const ROT1_CREATED_AT: i64 = 1_753_300_000_000;

// Rotation 2 (the newest — later created_at).
const ROT2_ID: &str = "22222222222222222222222222222222";
const ROT2_KEY: &str = "c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2";
const ROT2_EPHEMERAL: &str = "3232323232323232323232323232323232323232323232323232323232323232";
const ROT2_NONCE: &str = "424242424242424242424242424242424242424242424242";
const ROT2_CREATED_AT: i64 = 1_753_400_000_000;

fn genesis_ring() -> Keyring {
    Keyring::genesis_with(
        &owner().x25519_public(),
        &DataKey::from_bytes(arr32(GENESIS_KEY)),
        arr32(GENESIS_EPHEMERAL),
        arr24(GENESIS_NONCE),
    )
}

fn rot1(ring: &Keyring) -> Keyring {
    ring.rotate_with(
        &owner().x25519_public(),
        &DataKey::from_bytes(arr32(ROT1_KEY)),
        arr16(ROT1_ID),
        ROT1_CREATED_AT,
        arr32(ROT1_EPHEMERAL),
        arr24(ROT1_NONCE),
    )
}

fn rot2(ring: &Keyring) -> Keyring {
    ring.rotate_with(
        &owner().x25519_public(),
        &DataKey::from_bytes(arr32(ROT2_KEY)),
        arr16(ROT2_ID),
        ROT2_CREATED_AT,
        arr32(ROT2_EPHEMERAL),
        arr24(ROT2_NONCE),
    )
}

fn genesis_legacy() -> Value {
    // A legacy single-key vault.key: a bare WrappedKey a client wrote before
    // epochs existed. It must read as a one-epoch genesis keyring.
    let data_key = "d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3";
    let wrapped = wrap_key_with_ephemeral(
        &owner().x25519_public(),
        &DataKey::from_bytes(arr32(data_key)),
        arr32("3535353535353535353535353535353535353535353535353535353535353535"),
        arr24("505050505050505050505050505050505050505050505050"),
    );
    json!({
        "note": "legacy single-key vault.key parses as an epoch-0 genesis keyring",
        "owner_seed_hex": OWNER_SEED,
        "data_key_hex": data_key,
        "legacy_vault_key_hex": hex::encode(wrapped.to_bytes()),
    })
}

fn multi_epoch() -> Value {
    let ring = rot2(&rot1(&genesis_ring()));
    json!({
        "note": "genesis + two rotations; newest is the later-created rotation, not the larger id",
        "owner_seed_hex": OWNER_SEED,
        "owner_x25519_public_hex": hex::encode(owner().x25519_public().as_bytes()),
        "epochs": [
            { "id_hex": "00000000000000000000000000000000", "created_at": 0,
              "data_key_hex": GENESIS_KEY, "ephemeral_secret_hex": GENESIS_EPHEMERAL, "nonce_hex": GENESIS_NONCE },
            { "id_hex": ROT1_ID, "created_at": ROT1_CREATED_AT,
              "data_key_hex": ROT1_KEY, "ephemeral_secret_hex": ROT1_EPHEMERAL, "nonce_hex": ROT1_NONCE },
            { "id_hex": ROT2_ID, "created_at": ROT2_CREATED_AT,
              "data_key_hex": ROT2_KEY, "ephemeral_secret_hex": ROT2_EPHEMERAL, "nonce_hex": ROT2_NONCE },
        ],
        "keyring_hex": hex::encode(ring.to_bytes()),
        "newest_id_hex": ROT2_ID,
    })
}

fn rotated_blob() -> Value {
    // A blob sealed under the newest (rotated) epoch of the multi-epoch ring: the
    // marker rides in the AAD, cryptographically bound.
    let ring = rot2(&rot1(&genesis_ring()));
    let blob_id = "ev-rotated01";
    let plaintext = b"sealed under a rotated epoch";
    let nonce = "555555555555555555555555555555555555555555555555";
    let sealed = ring
        .seal_blob_with_nonce(&owner(), blob_id.as_bytes(), plaintext, arr24(nonce))
        .unwrap();
    json!({
        "note": "blob sealed under a non-zero epoch: AAD = blob_id ‖ 0x1f ‖ epoch_id",
        "owner_seed_hex": OWNER_SEED,
        "blob_id": blob_id,
        "plaintext_hex": hex::encode(plaintext),
        "seal_nonce_hex": nonce,
        "aad_hex": hex::encode(aad(blob_id, &arr16(ROT2_ID))),
        "keyring_hex": hex::encode(ring.to_bytes()),
        "sealed_hex": hex::encode(sealed),
    })
}

fn pre_epoch_blob() -> Value {
    // A blob sealed under genesis (bare blob_id AAD) — the pre-epoch form; it must
    // still open once the vault key is the genesis epoch of a keyring.
    let ring = genesis_ring();
    let blob_id = "ev-preepoch1";
    let plaintext = b"sealed before any rotation";
    let nonce = "666666666666666666666666666666666666666666666666";
    let sealed = ring
        .seal_blob_with_nonce(&owner(), blob_id.as_bytes(), plaintext, arr24(nonce))
        .unwrap();
    json!({
        "note": "pre-epoch blob: genesis binds the bare blob_id AAD, byte-identical to the pre-keyring contract",
        "owner_seed_hex": OWNER_SEED,
        "blob_id": blob_id,
        "plaintext_hex": hex::encode(plaintext),
        "seal_nonce_hex": nonce,
        "aad_hex": hex::encode(aad(blob_id, &[0u8; EPOCH_ID_LEN])),
        "keyring_hex": hex::encode(ring.to_bytes()),
        "sealed_hex": hex::encode(sealed),
    })
}

fn merge() -> Value {
    // Two replicas that diverged: each rotated the same genesis independently. The
    // union merge keeps both rotations and dedupes the shared genesis.
    let base = genesis_ring();
    let a = rot1(&base);
    let b = rot2(&base);
    let merged = Keyring::merge(&a, &b);
    json!({
        "note": "union merge of two independently-rotated replicas; genesis dedupes, newest is the later rotation",
        "owner_seed_hex": OWNER_SEED,
        "keyring_a_hex": hex::encode(a.to_bytes()),
        "keyring_b_hex": hex::encode(b.to_bytes()),
        "merged_hex": hex::encode(merged.to_bytes()),
        "newest_id_hex": ROT2_ID,
    })
}

fn main() {
    let file = json!({
        "contract_version": CONTRACT_VERSION,
        "genesis_legacy": genesis_legacy(),
        "multi_epoch": multi_epoch(),
        "rotated_blob": rotated_blob(),
        "pre_epoch_blob": pre_epoch_blob(),
        "merge": merge(),
    });
    println!("{}", serde_json::to_string_pretty(&file).unwrap());
}
