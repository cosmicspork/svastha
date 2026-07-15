# Svastha tasks. Run `just` to list.

# Recipes read `.env` (relay-run's SVASTHA_RELAY_ADDR, decrypt's
# SVASTHA_MNEMONIC/SVASTHA_RELAY_URL, etc.) — see .env.example.
set dotenv-load

default:
    @just --list

# --- web (Svelte PWA) ---

web-install:
    cd web && bun install

web-dev:
    cd web && bun run dev

web-build:
    cd web && bun run build

web-check:
    cd web && bun run check

# --- rust workspace (core, relay, node) ---

build:
    cargo build --workspace

# run the relay server (SVASTHA_RELAY_ADDR, SVASTHA_RELAY_MAX_SKEW_SECS)
relay-run:
    cargo run -p svastha-relay

test:
    cargo test --workspace

fmt:
    cargo fmt --all

fmt-check:
    cargo fmt --all --check

clippy:
    cargo clippy --workspace --all-targets -- -D warnings

# end-to-end PWA <-> relay browser smoke (local only; intentionally NOT in `all`
# or CI). Builds the relay, then Playwright starts the relay + Vite dev server and
# drives a real browser. Needs `cargo` and `wasm-pack` on PATH.
e2e:
    cargo build -p svastha-relay
    cd web && bun install && bunx playwright install chromium && bun run e2e

# --- dev tooling ---

# pull this identity's relay blobs and decrypt into SVASTHA_DECRYPT_OUT
# (default private/decrypt — gitignored PHI). Wipes the out dir each run.
# Needs SVASTHA_MNEMONIC and SVASTHA_RELAY_URL; see .env.example.
decrypt:
    cargo run -p svastha-devtool

# re-derive events from the relay's stored source documents and push only the
# new ones (dev-only, no browser or export files). Same SVASTHA_MNEMONIC and
# SVASTHA_RELAY_URL as `just decrypt`. Pass `--dry-run` to print what would push
# without writing: `just import-derive --dry-run`.
import-derive *args:
    cargo run -p svastha-devtool -- import {{args}}

# --- aggregate ---

check: fmt-check clippy web-check

all: check build test web-build
