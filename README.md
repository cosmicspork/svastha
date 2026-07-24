# Svastha

[![ci](https://github.com/cosmicspork/svastha/actions/workflows/ci.yml/badge.svg)](https://github.com/cosmicspork/svastha/actions/workflows/ci.yml)

Self-custodial, end-to-end-encrypted, local-first personal medical records.
Your health history lives encrypted on your devices, syncs through a relay that
cannot read it, and is yours to keep, carry, and share on your terms.

Patients are often the only ones holding a complete picture of their own care —
records get handed over on paper, or scattered across portals that each see one
slice. Svastha is a place to gather that picture and own it outright: encrypted
with keys derived from a seed phrase only you hold, so whoever runs the sync
infrastructure holds nothing readable.

## What it does

- **Import your records.** Client-side C-CDA and FHIR import (the formats US
  patient-access exports actually produce) maps documents into typed, coded
  events — allergies, medications, labs, immunizations, problems, procedures,
  narrative notes — deduplicated by content, with the source document kept.
- **Capture paper.** Photograph or attach paper records (including PDFs); pages
  are encrypted as attachment blobs with an in-app viewer.
- **One timeline.** Imported facts and self-tracked data (symptoms, vitals,
  meds, food, exercise, cycle tracking that records and never predicts) live on
  a single chronological spine, with curation — current-vs-past status, display
  names, tags — layered on without ever rewriting history. Sensitive categories
  are sensitive by default, everywhere they surface.
- **Share with a doctor.** A scoped share (date range, categories; sensitive
  categories stay out unless named) travels as a link + QR the clinician opens
  cold in any browser, or as an encrypted file handed over with no relay
  involved (optional passphrase). Shares are revocable where that's honest and
  labeled unrevocable where it isn't.
- **Share with someone you trust.** Grant another person ongoing read access
  to your record, scoped to the categories they actually need; revoking a
  grant really rotates keys.
- **Multi-device.** Restore any device from your seed phrase; devices converge
  through the relay. A devices & grants screen shows both directions of the
  sharing graph, with revoke-and-rotate as one action.
- **Ask your record.** An optional self-hosted processing node adds OCR and
  cited Q&A over your own record — see [AI on your terms](#ai-on-your-terms-the-processing-node)
  below for what it does and exactly what it's trusted with.
- **Know when something's waiting.** Real-time sync pokes over SSE, plus Web
  Push to a locked phone — notifications are deliberately generic, because
  medical content never belongs on a lock screen.
- **Local-first.** Your device holds the primary copy (a static PWA over
  IndexedDB); the app works fully offline, and the relay is a sync channel,
  never a source of truth.
- **No lock-in.** A one-way plaintext JSON export puts everything you hold in
  an open format whenever you want out; the trust boundary stays exit-only —
  there is deliberately no plaintext import back in.

## Who can read what

| Party | Sees |
|---|---|
| You (seed phrase) | Everything. Keys derive from a mnemonic only you hold; unlock via passphrase or passkey. |
| The relay | Ciphertext and routing metadata only. It stores sealed blobs it cannot open — zero-knowledge by construction, verified by a written contract and test vectors. |
| Someone you granted ongoing access | The namespaces you granted (relay-enforced), until you revoke — and revoking rotates keys, so it means something. |
| A doctor with a share link | Only the sealed bundle behind that link's key, scoped to what you selected. |
| Your processing node (optional) | Plaintext of vaults that enrolled it — it's *trusted* infrastructure you run, inside your boundary. It holds no seed and cannot forge history: its writes are proposals you sign. |

The design is honest about limits rather than quiet about them: a revoked
reader keeps what it already decrypted (rotation protects everything after), a
handed-over file is a copy like paper, and the relay necessarily sees traffic
timing and blob-id prefixes. `docs/ARCHITECTURE.md` states each caveat next to
the mechanism it belongs to.

## AI on your terms: the processing node

AI features and end-to-end encryption are usually a contradiction — someone's
server has to read your data. Svastha resolves it by making the AI a **grantee
you enroll, not a service you're opted into**. The processing node is an
optional container you run; nothing about the app requires it.

What it adds:

- **OCR → proposals.** Captured paper pages become *draft* coded events in an
  approval inbox — the source page shown beside each extracted fact — and you
  approve, edit, or reject. Nothing enters your record unsigned; every
  approved event permanently attests what proposed it, from which page, with
  which model.
- **Cited Q&A.** Ask questions of your own record; every answer cites the
  events it drew from, and the citations link straight to them. An answer that
  can't be grounded in your record comes back as an honest "couldn't answer",
  never uncited prose. Clearly labeled retrieval, not medical advice.

What it's trusted with, exactly:

- The node earns access the way a person does: it has its own identity, you
  grant it read access from your app after verifying its fingerprint, and
  **revoke-and-rotate cuts it off** the same as any other grantee. It holds no
  seed and cannot sign as you — a compromised node can leak what it has read,
  but can never forge your history.
- Plaintext reaches two places you chose by name: the node's host, and the
  OpenAI-compatible inference endpoint you configure. Point it at local
  Ollama/vLLM and plaintext never leaves your machines; point it at a cloud
  endpoint and that's your explicit, revocable decision — the relay stays
  zero-knowledge either way, and the node ships no models of its own.
- Its design assumes it will be discarded: durable state is one disposable
  identity keypair, decrypted data lives in an ephemeral cache that re-syncs
  on restart, and it makes no inbound connections at all.

## Run it yourself

Everything self-hosts from this repo: a static PWA, a relay image, and an
optional node image.

**Relay** — keyless; anyone can run it:

```bash
docker compose up -d          # relay on :8080, data in a named volume
```

**Processing node** — trusted; opt in deliberately:

```bash
docker compose --profile node up -d
```

The node wires itself to the compose relay by service name. Enroll it by
reading its `svastha1:` identity code from `docker compose logs node` and
granting it from the PWA's devices & grants screen; set
`SVASTHA_NODE_INFERENCE_ENDPOINT`/`_MODEL`/`_API_KEY` to your own
OpenAI-compatible endpoint to turn on OCR and Q&A. Its mounts tell the trust
story: `/data` holds only a disposable identity keypair, `/cache` is tmpfs —
decrypted plaintext lives there and nowhere else, resynced from the relay on
every restart. No inbound ports; the node only dials out. Running a node means
running trusted infrastructure — see `docs/ARCHITECTURE.md`'s "Self-hosting".

**PWA** — any static host:

```bash
cd web && bun install && bun run build   # deployable web/dist/
```

(`web/wrangler.jsonc` deploys that build to Cloudflare Workers, but nothing
depends on it.)

**Status:** pre-1.0 and moving. The wire contract is versioned
(`svastha_core::CONTRACT_VERSION`, documented in `spec/`) and changes are
additive within the major, but expect sharp edges. It is a personal project in daily real use, not a medical device,
and it gives no medical advice.

## About the name

**Svastha** comes from the Sanskrit स्वस्थ (*sva-stha*): *sva*, "self," and
*stha*, "abiding." Being established in oneself — Ayurveda's word for health.
Self plus health is the whole idea: your records, held by you.

---

## Under the hood

**The trust contract is a first-class artifact.** `spec/README.md` documents
the key derivation, encryption envelope, event schema, curation records, typed
mailbox envelope, key epochs, and the full relay wire protocol; `spec/vectors/`
pins them with test vectors that `crates/core` must reproduce byte-for-byte.
The contract version is split from the crypto major deliberately, so the wire
can grow additively while proving — via byte-identical vectors — that no key
ever rotates by accident.

**One Rust core, everywhere.** `crates/core` implements the contract once and
compiles to native (relay, node, CLI) and WASM (`@svastha/core` on npm), so the
browser runs the exact same envelope code as the servers. No SSR anywhere — a
server that can't read the data can't render it.

**The data model matches the domain.** Clinical history is immutable, so the
store is an append-only log of signed, content-addressed events — the same
immunization imported from two providers collapses to one id — with a thin
last-writer-wins curation overlay (signed, verify-or-drop) for the few things
that genuinely change: status, names, tags. Events proposed by software carry
owner-signed provenance (proposer, source page, model) and keep the same
content id as the directly-logged fact.

**The relay stays dumb on purpose.** Ed25519-authenticated requests with
replay protection; sealed blobs under prefix-namespaced ids; grants with
relay-enforced prefix scopes and optional expiry, where an expired, revoked,
and never-existing grant are deliberately indistinguishable (two-404 rule);
payload-free push (SSE + VAPID Web Push — the push services learn timing,
never content); cursor pagination and curation etags. No inter-relay protocol,
no manifests, no server-side smarts that would need to see anything.

**Trusted compute is modeled as a grantee, not a backdoor.** The processing
node earns plaintext access the same way a human does — an owner grants it —
and loses it the same way — revoke-and-rotate. Its writes ride a
proposer-agnostic approval loop, so a future human caregiver reuses the same
mechanism, envelope, and inbox. Key rotation is epoch-based (append-only key
history, mergeable keyrings, epoch marker sealed into the AAD) — never bulk
re-encryption.

**Tested at the layer that matters.** Contract test vectors; Rust unit and
integration tests that boot the real relay in-process (the node's enrollment,
sync, tampering, and rotation tests run against the actual server code);
Playwright end-to-end suites driving multi-device flows — two browser
contexts converging through a real relay, cold-recipient share opens,
revocation actually locking a stale grantee out.

**Boring, automated releases.** Conventional commits; release-please cuts
tags, a changelog, six crates.io crates, the npm SDK, and two GHCR images from
one workflow. CI gates every PR with fmt/clippy, the full Rust workspace,
svelte-check + vitest, and the browser e2e suite.

### Layout

| Path | What |
|---|---|
| `crates/core` | Trust contract: envelope, event schema, mailbox messages, keyrings. Native + WASM. |
| `crates/import` | Client-side C-CDA/FHIR mapping into the event model. |
| `crates/relay` | Zero-knowledge store-and-forward server. |
| `crates/node` | Trusted processing client: OCR → proposals, cited Q&A. |
| `crates/wasm` | WASM bindings (`@svastha/core` on npm). |
| `crates/svastha` | Umbrella crate re-exporting `core`. |
| `web` | Svelte 5 PWA (bun + Vite), local-first. |
| `spec` | Written wire contract + test vectors. |
| `fixtures` | Synthetic, PHI-free test data. |
| `docs/ARCHITECTURE.md` | Source of truth for the design. |
| `docs/ROADMAP.md` | Pending work; removed by the PR that ships it. |

### Developing

Issues and PRs are welcome. Conventional commits, one-line subjects; run
`just all` (everything CI runs) before pushing.

```bash
cd web && bun install && bun run dev   # web app
cargo build --workspace                # rust (rustup, stable)

just            # list recipes
just check      # fmt-check + clippy + svelte-check
just test       # cargo test
just all        # everything CI runs
just e2e        # PWA <-> relay browser smoke
```

### Releasing

[release-please](https://github.com/googleapis/release-please) turns
conventional commits on `main` into a release PR; merging it tags the version,
cuts the GitHub release, and publishes the crates
([`svastha-core`](https://crates.io/crates/svastha-core),
[`svastha-import`](https://crates.io/crates/svastha-import),
[`svastha`](https://crates.io/crates/svastha),
[`svastha-wasm`](https://crates.io/crates/svastha-wasm),
[`svastha-relay`](https://crates.io/crates/svastha-relay),
[`svastha-node`](https://crates.io/crates/svastha-node)), the npm SDK
([`@svastha/core`](https://www.npmjs.com/package/@svastha/core)), and the
container images (`ghcr.io/cosmicspork/svastha-relay`,
`ghcr.io/cosmicspork/svastha-node`). Pre-1.0, `feat` bumps the minor and `fix`
the patch. Each publish job is safe to re-dispatch by hand if one fails.

## Reporting a security issue

Please don't open a public issue for anything security-sensitive — report it
privately via [GitHub security advisories](https://github.com/cosmicspork/svastha/security/advisories/new).
See [SECURITY.md](SECURITY.md).

## License

[AGPL-3.0](LICENSE).
