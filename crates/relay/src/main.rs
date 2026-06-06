//! Svastha relay (skeleton).
//!
//! The relay is deliberately dumb: it stores and forwards encrypted blobs it
//! cannot read, holds no keys, and only verifies client auth signatures. The HTTP
//! server (planned: axum + tokio) lands in a follow-up; this stub keeps the
//! workspace building until then. See `docs/ARCHITECTURE.md`.

fn main() {
    println!(
        "svastha-relay skeleton (trust contract v{})",
        svastha_core::CONTRACT_VERSION
    );
}
