# Svastha tasks. Run `just` to list.

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

# --- aggregate ---

check: fmt-check clippy web-check

all: check build test web-build
