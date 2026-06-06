//! The encryption envelope: how vault data keys are wrapped to recipient public
//! keys and how event payloads are sealed. This is the most security-critical
//! code in the project; it must match `spec/` and its test vectors exactly.
//!
//! Planned primitives (wired in when implementation begins, see ARCHITECTURE):
//!   - XChaCha20-Poly1305 (`chacha20poly1305`) for payload sealing
//!   - X25519 (`x25519-dalek`) for wrapping vault keys to recipient public keys
//!   - Ed25519 (`ed25519-dalek`) for signing events
//!
//! Intentionally empty in the skeleton so the workspace builds with std + serde
//! only until the vetted crates are added.
