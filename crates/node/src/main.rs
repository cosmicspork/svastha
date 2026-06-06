//! Svastha node (skeleton).
//!
//! The node is a trusted client: it holds keys, syncs plaintext locally, and runs
//! the OCR / extraction / de-identification / RAG pipeline by delegating inference
//! to a user-supplied OpenAI-compatible endpoint (it ships no models). This is a
//! later release; the stub keeps the workspace building. See `docs/ARCHITECTURE.md`.

fn main() {
    println!(
        "svastha-node skeleton (trust contract v{})",
        svastha_core::CONTRACT_VERSION
    );
}
