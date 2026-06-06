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
