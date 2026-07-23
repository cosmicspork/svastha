# svastha-node

The [Svastha](https://github.com/cosmicspork/svastha) node: a trusted processing
client that holds keys, syncs a vault's plaintext locally, and runs OCR (with
extraction and retrieval in later releases) by delegating inference to a
user-supplied OpenAI-compatible endpoint. It ships no models.

The node is a **keyed grantee**, not a service: each owner grants it whole-vault
read access from their app and hands off the keys through the relay's mailbox. It
can read plaintext (bounded, and revocable by key rotation) but holds no seed and
can never forge history — any writes it makes are *proposals* the owner reviews
and signs.

> Pre-1.0 and unstable.

## What runs today (D1 — substrate)

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

## What runs today (D2 — OCR → proposals)

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
  the later admin surface.

## What later releases add

- **D3 — cited Q&A.** Retrieval over the decrypted, curation-aware index; every
  answer cites the event ids it drew from. Read-only, no approval loop.
- **D4 — packaging.** Deployment images and manifests, plus relay-list pagination.

## Configuration (env)

| Variable | Required | Purpose |
|---|---|---|
| `SVASTHA_RELAY_URL` | **yes** | Relay base URL. Never assumed — the node reaches it outbound. |
| `SVASTHA_NODE_DATA_DIR` | no | Durable dir for the node identity (default `svastha-node/data`). |
| `SVASTHA_NODE_CACHE_DIR` | no | Ephemeral decrypted-plaintext dir (default `svastha-node/cache`). |
| `SVASTHA_NODE_INFERENCE_ENDPOINT` | no | OpenAI-compatible chat-completions endpoint. Setting it **enables OCR**. Must be synchronous — a Batch-API path is rejected (batch outputs are retained server-side). |
| `SVASTHA_NODE_INFERENCE_MODEL` | when endpoint set | Chat-completions model id (e.g. a vision model) sent in every request. |
| `SVASTHA_NODE_INFERENCE_API_KEY` | no | Inference API key; sent as a bearer token, never logged. |
| `SVASTHA_NODE_BOOTSTRAP_ADDR` | no | Bootstrap-page bind address, **loopback only** (default `127.0.0.1:7071`). |
| `SVASTHA_NODE_POLL_INTERVAL_SECS` | no | Fallback pull cadence when the SSE stream is down (default 60). |
| `SVASTHA_NODE_LABEL` | no | Label shown in the identity code (default `svastha-node`). |
| `RUST_LOG` | no | Tracing filter (default `svastha_node=info`). |

The node holds plaintext by design; its logs carry only counts and ids, never
record content.

Licensed under AGPL-3.0-only.
