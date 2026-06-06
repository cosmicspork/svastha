# Svastha

[![ci](https://github.com/cosmicspork/svastha/actions/workflows/ci.yml/badge.svg)](https://github.com/cosmicspork/svastha/actions/workflows/ci.yml)

Self-custodial, end-to-end-encrypted, local-first personal medical records. Your
health history lives encrypted on your devices, syncs through a relay that cannot
read it, and is yours to keep, carry, and share on your terms.

## About the name

**Svastha** comes from the Sanskrit स्वस्थ (*sva-stha*): *sva*, "self," and
*stha*, "abiding" or "standing." It means being established in oneself, and it is
Ayurveda's word for health. Self plus health is the whole idea: your records,
held by you.

## Why

Patients are often the only ones holding a complete picture of their own care,
whether because records are handed to them on paper or because they are scattered
across portals that each see one slice. Svastha is a place to gather that picture
and own it outright, encrypted with keys derived from a seed phrase only you hold,
so whoever runs the sync infrastructure (including a hosted Svastha) knows nothing
and holds nothing.

## Stack

- **Rust spine**: a shared `core` crate (the crypto envelope and event schema)
  compiled to native and WASM, a zero-knowledge `relay`, and a trusted `node`.
- **Svelte 5 PWA** (bun + Vite), local-first, consuming `core` over WASM.
- **AGPL-3.0**.

## Layout

| Path | What |
|---|---|
| `crates/core` | Trust contract: encryption envelope and event schema. Native and WASM. |
| `crates/relay` | Zero-knowledge store-and-forward server for encrypted blobs. |
| `crates/node` | Trusted processing client; delegates inference to an OpenAI-compatible endpoint. Later release. |
| `web` | Svelte 5 PWA, local-first, consumes `core` via WASM. |
| `spec` | Versioned wire contract and test vectors. |
| `fixtures` | Synthetic, PHI-free test data. |
| `docs/ARCHITECTURE.md` | Source of truth for the design. |

## Getting started

Web:

```bash
cd web
bun install
bun run dev
```

Rust (via rustup):

```bash
brew install rustup && rustup default stable
cargo build --workspace
```

## Common tasks

Recipes live in the [`justfile`](justfile):

```bash
just            # list recipes
just web-dev    # run the web app
just check      # fmt-check + clippy + svelte-check
just test       # cargo test
just all        # everything CI runs
```

