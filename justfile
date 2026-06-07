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

# --- aggregate ---

check: fmt-check clippy web-check

all: check build test web-build
