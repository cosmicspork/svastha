# Svastha

Self-custodial, end-to-end-encrypted, local-first personal medical records.

Read `docs/ARCHITECTURE.md` before touching the trust contract (crypto envelope,
event schema, relay protocol). It is the source of truth.

## Shape

- `crates/core`: Rust trust contract (envelope and event schema), compiles to
  native and WASM. Single source of truth. The relay never decrypts.
- `crates/relay`: zero-knowledge store-and-forward server (Rust).
- `crates/node`: trusted processing client (Rust); delegates inference to an
  OpenAI-compatible endpoint. Later release.
- `web`: Svelte 5 PWA (bun + Vite), local-first, consumes `core` via WASM.

## Tooling

- Web: bun (`cd web && bun install`).
- Rust: rustup (`brew install rustup && rustup default stable`).
- Tasks: `just` (run `just` to list).

## Conventions

### Commits

[Conventional Commits](https://www.conventionalcommits.org). One-line subject, no
body:

```
type(scope): imperative summary
```

Types: feat, fix, docs, refactor, test, chore, ci, build, perf. Scope is
optional. Leave the details to the pull request.

### Branches

`type/short-kebab-summary`, e.g. `feat/relay-blob-endpoints`,
`chore/project-skeleton`.

### Pull requests

The diff shows what changed. The description covers the why and anything a
reviewer cannot infer from the code. No restating the change.

### Comments

Comment the non-obvious why: a constraint, a trade-off, a gotcha. Skip comments
that restate the code.

### Verify before committing

- Rust: `just check` (fmt-check, clippy) and `just test`.
- Web: `cd web && bun run check` and `bun run build`.
- `just all` runs everything CI runs.
