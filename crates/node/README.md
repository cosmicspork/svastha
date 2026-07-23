# svastha-node

The [Svastha](https://github.com/cosmicspork/svastha) node: a trusted processing
client that holds keys, syncs a vault's plaintext locally, and (in later releases)
runs OCR, extraction, and retrieval by delegating inference to a user-supplied
OpenAI-compatible endpoint. It ships no models.

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

## What later releases add

- **D2 — OCR → proposals.** Captured `att-` pages (and `doc-` source documents)
  through vision inference into draft coded events, each with source-blob
  provenance, deposited as `proposal` envelopes for the owner to approve.
- **D3 — cited Q&A.** Retrieval over the decrypted, curation-aware index; every
  answer cites the event ids it drew from. Read-only, no approval loop.
- **D4 — packaging.** Deployment images and manifests, plus relay-list pagination.

## Configuration (env)

| Variable | Required | Purpose |
|---|---|---|
| `SVASTHA_RELAY_URL` | **yes** | Relay base URL. Never assumed — the node reaches it outbound. |
| `SVASTHA_NODE_DATA_DIR` | no | Durable dir for the node identity (default `svastha-node/data`). |
| `SVASTHA_NODE_CACHE_DIR` | no | Ephemeral decrypted-plaintext dir (default `svastha-node/cache`). |
| `SVASTHA_NODE_INFERENCE_ENDPOINT` | no | OpenAI-compatible endpoint; **validated but unused until D2/D3** (a Batch-API path is rejected — batch outputs are retained server-side). |
| `SVASTHA_NODE_INFERENCE_API_KEY` | no | Inference API key; unused until D2/D3, never logged. |
| `SVASTHA_NODE_BOOTSTRAP_ADDR` | no | Bootstrap-page bind address, **loopback only** (default `127.0.0.1:7071`). |
| `SVASTHA_NODE_POLL_INTERVAL_SECS` | no | Fallback pull cadence when the SSE stream is down (default 60). |
| `SVASTHA_NODE_LABEL` | no | Label shown in the identity code (default `svastha-node`). |
| `RUST_LOG` | no | Tracing filter (default `svastha_node=info`). |

The node holds plaintext by design; its logs carry only counts and ids, never
record content.

Licensed under AGPL-3.0-only.
