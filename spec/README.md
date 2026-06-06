# Trust contract (spec)

The formal, versioned contract every component agrees on, independent of
language:

- the encryption envelope (key wrapping, payload sealing),
- the event schema,
- the relay wire protocol (auth handshake, blob endpoints).

`crates/core` is the executable contract for the Rust spine and its WASM build.
This directory holds the written spec and language-neutral test vectors, so a
non-Rust reimplementation or an auditor can validate against the same bytes.

`svastha_core::CONTRACT_VERSION` tracks breaking changes; clients and relays
negotiate on it so independently deployed and self-hosted pieces can coexist.

Status: placeholder. The envelope and protocol are documented here as they are
implemented.
