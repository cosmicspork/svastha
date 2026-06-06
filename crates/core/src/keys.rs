//! Identity and key derivation. A BIP39 seed phrase derives an X25519 keypair
//! (encryption) and an Ed25519 keypair (signing). Each device and each person is
//! an identity; vault data keys are wrapped to identity public keys, and a grant
//! is a vault key wrapped to a recipient under a filter and terms.
//!
//! Planned: `bip39` plus an HKDF over the seed to derive the two keypairs. Empty
//! in the skeleton (see `envelope.rs`).
