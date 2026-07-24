# svastha-node

The [Svastha](https://github.com/cosmicspork/svastha) node: a trusted processing
client that holds keys, syncs a vault's plaintext locally, and runs OCR and cited
Q&A by delegating inference to a user-supplied OpenAI-compatible endpoint. It ships
no models.

The node is a **keyed grantee**, not a service: each owner grants it whole-vault
read access from their app and hands off the keys through the relay's mailbox. It
can read plaintext (bounded, and revocable by key rotation) but holds no seed and
can never forge history — any writes it makes are *proposals* the owner reviews
and signs.

> Pre-1.0 and unstable.

## Enrollment & sync

This crate is the foundation the processing features sit on:

- **Identity & enrolment.** On first boot the node generates its own disposable
  identity, persists it (the only durable state), and prints its `svastha1:`
  identity code — as text and a QR — to the logs and a **loopback-only bootstrap
  page**. An owner grants the node and deposits a `key_handoff` into its mailbox;
  the node consumes it (verify-or-drop; typed envelope and the grandfathered bare
  wrapped-key form both), unwraps the keyring, and begins pulling that vault.
  Multi-tenant from day one: each owner's handoff enrols another vault, tracked
  independently.
- **Sync.** A pull loop per enrolled owner over the relay's shared-blob endpoints,
  driven by the SSE poke channel with a periodic-poll fallback (reconnect with
  backoff; pokes are lossy, the pull path is authoritative). Every blob is opened
  with the keyring (trial-decrypt across key epochs) and **verified-or-dropped**:
  event and curation signatures, and every content hash against its blob id. A
  re-delivered keyring (rotation) is merged, so the node keeps working with no
  ceremony.
- **Index.** An in-memory, curation-aware view of each vault: events folded into
  concepts with the owner's `status:`/`name:` overlay applied (current-vs-past and
  display-name overrides), attachments and documents by id, and provenance-ready
  lookups. By documented convention it **ignores `tag:`/`note:`/`hide:`/`fav:`**
  curation even though the grant delivers it (the relay cannot scope within the
  `cur-` namespace).
- **State model.** Decrypted plaintext lives only in the configured cache dir and
  is treated as ephemeral — a restart is a resync. The node identity keypair is
  the only durable state, and it is disposable: lose it, generate a fresh one, and
  re-grant.

The node holds no inbound ports beyond the bootstrap page; it reaches the relay
outbound only.

## OCR → proposals

Enabled when an inference endpoint is configured (see the config table). On each
reconcile the node OCRs newly-synced captured pages and deposits the results as
`proposal` envelopes into the owner's mailbox, for review in the PWA's proposal
inbox. It never signs anything as the owner — it proposes; the owner signs.

- **Vision inference.** Each captured page goes to the configured
  OpenAI-compatible chat-completions endpoint as a vision request with a
  structured-extraction prompt. Only a **synchronous** endpoint is allowed — a
  batch-style API path is rejected at config time, because batch outputs are
  retained server-side, beyond the trust boundary. The request necessarily
  carries the decrypted page to the endpoint you chose (the design's trust
  decision); the node's own logs never carry the image, prompt, or extracted
  text — only counts and blob ids.
- **Draft coded events.** Findings map into the same event model and the same
  terminology URIs `crates/import`'s C-CDA/FHIR mappers use — no parallel coding
  vocabulary — as **unsigned, schema-valid** drafts, each carrying its source
  blob, `method = "ocr"`, and the model id. Malformed inference output never
  becomes a malformed proposal: it is dropped and counted. Low confidence and
  handwriting are proposed anyway and lean on the approval loop by design.
- **Scope: `att-` image pages only.** This release OCRs `image/*` captured
  attachments. `att-` PDFs (which need rasterization first) and `doc-` source
  documents (structured EHR exports — narrative extraction is a separate roadmap
  item) are out of scope and left for follow-ups.
- **Idempotence.** A small **content-free journal** in the data dir (processed
  source blob ids and deposited message ids — both already relay-visible
  metadata, never plaintext) plus the `proposal_result`s the owner sends back
  ensure a page is proposed once: a restart never re-deposits, a resolved or
  rejected page is never re-proposed, and a re-shared page stays processed.
  Extraction and deposit failures back off per page so one bad page never wedges
  the queue. Job-status counters (queued / processed / failed) are exposed for
  the admin surface below.

## Cited Q&A and owner administration

The node side of the PWA's ask screen and node-admin surface. Both ride the typed
mailbox envelope; both accept traffic **only from an enrolled owner** (envelope
verify + the relay's `svastha-from` attestation + an enrolled-owner check),
mirroring the web's posture.

- **Cited Q&A.** A `chat_msg` question is answered by retrieving over **that
  owner's** curation-aware index and asking the configured endpoint to answer from
  the retrieved context. Retrieval is honest and personal-scale — keyword overlap
  with light recency and kind/intent signals, no embedding store — and
  **curation-aware**: the `name:` override supplies the shown name, and the
  `status:` current-vs-past distinction both shows to the model and re-ranks (a
  "what am I *currently* taking" question demotes resolved concepts). **Read-only**
  — no proposal loop.
- **Grounding is the contract.** Every answer carries the event content ids it
  actually drew from; a citation is always a subset of the context supplied to the
  model (they come from the context list itself), so an answer can never cite an
  event the model invented. If nothing retrieves, or the model returns malformed
  output or no usable citation, the node replies **honestly that it couldn't
  answer** rather than forwarding uncited prose.
- **Tenancy isolation is structural.** Retrieval is handed exactly one owner's
  index, so a question from owner A can only ever be answered from — and cite —
  A's vault, by construction rather than by discipline.
- **Admin commands.** An `admin_cmd` from an enrolled owner administers the node's
  work on *their* vault (design §2): `job_status` (this owner's index sizes, the
  global OCR counters, and the last reconcile time — all content-free),
  `log_tail` (recent lines of the node's own content-free logs), and
  `set_inference_endpoint` (updates the runtime endpoint, persisted so it survives
  a restart — the override takes precedence over the env boot default; still
  subject to the boot-time validation, so a Batch-API path answers `ok: false`
  with the reason). Node-global operations (restart, upgrade) are the host
  operator's, never commands. Each command gets a sealed `admin_reply`.
- **Idempotence.** Handled question/command message ids are recorded in the same
  content-free journal, so a restart never re-answers a question or re-runs a
  command, and the handled item is deleted from the node's mailbox.

## Packaging

A container image and a compose profile for self-hosters. No Kubernetes
manifests live in this repo; deploy configs elsewhere watch the same GHCR
image tags.

- **Image.** `ghcr.io/cosmicspork/svastha-node`, built from the repo's
  [`Dockerfile.node`](../../Dockerfile.node) and published alongside the relay
  image in the release pipeline. Same multi-stage pattern as the relay's, runs
  as `nobody`, no OpenSSL to carry (pure-Rust TLS).
- **Two mount points, opposite semantics.** `/data` is durable — the node
  identity keypair, the only state that survives a restart. `/cache` is
  ephemeral plaintext and must be safe to lose on any restart (a restart is a
  resync by design); the image and the compose example both treat it as
  disposable, mounting it `tmpfs`.
- **`SVASTHA_RELAY_URL` still has no image default.** The image sets path
  defaults only (`/data`, `/cache`); the relay URL is left for the operator to
  supply, so a missing one fails fast at boot rather than silently assuming a
  co-located relay.
- **The bootstrap page never leaves the container.** It binds loopback
  *inside* the container by design; reach it with `docker exec`/`compose
  exec` (or your runtime's equivalent), and never publish it — see
  [compose.yaml](../../compose.yaml) at the repo root for the reference
  profile and the main README's "Self-hosting with compose" section for the
  end-to-end walkthrough.

## Configuration (env)

| Variable | Required | Purpose |
|---|---|---|
| `SVASTHA_RELAY_URL` | **yes** | Relay base URL. Never assumed — the node reaches it outbound. |
| `SVASTHA_NODE_DATA_DIR` | no | Durable dir for the node identity (default `svastha-node/data`). |
| `SVASTHA_NODE_CACHE_DIR` | no | Ephemeral decrypted-plaintext dir (default `svastha-node/cache`). |
| `SVASTHA_NODE_INFERENCE_ENDPOINT` | no | OpenAI-compatible chat-completions endpoint (the **boot default** — a `set_inference_endpoint` admin command overrides it at runtime, persisted). Setting it **enables OCR and cited Q&A**. Must be synchronous — a Batch-API path is rejected (batch outputs are retained server-side). |
| `SVASTHA_NODE_INFERENCE_MODEL` | when endpoint set | Chat-completions model id (a vision model for OCR) sent in every request. |
| `SVASTHA_NODE_INFERENCE_API_KEY` | no | Inference API key; sent as a bearer token, never logged. |
| `SVASTHA_NODE_BOOTSTRAP_ADDR` | no | Bootstrap-page bind address, **loopback only** (default `127.0.0.1:7071`). |
| `SVASTHA_NODE_POLL_INTERVAL_SECS` | no | Fallback pull cadence when the SSE stream is down (default 60). |
| `SVASTHA_NODE_LABEL` | no | Label shown in the identity code (default `svastha-node`). |
| `RUST_LOG` | no | Tracing filter (default `svastha_node=info`). |

The node holds plaintext by design; its logs carry only counts and ids, never
record content.

Licensed under AGPL-3.0-only.
