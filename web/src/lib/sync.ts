// Relay sync engine: after every signed event, seal it under the vault key
// and push it to the relay; pull namespaces this device doesn't have yet.
// There is no manifest (see docs/ARCHITECTURE.md, "Sync and backup"): the
// relay only lists blob ids, and the diff below (against the local `sync`
// outbox and the `events` store) is what converges two devices.
//
// This module deliberately does not import session.svelte.ts (or events.ts's
// runtime — only its type), because both ultimately depend on Svelte's
// `$state` rune, which is compiled by Vite's svelte plugin. vitest.config.ts
// runs plain TS unit tests without that plugin (see its comment), so pulling
// a rune module in transitively would crash at import time. Callers pass the
// relay client and vault key in explicitly (`syncInit`), and the one
// unavoidable runtime hook into events.ts (`setOnEventsLogged`) is wired via
// a dynamic import, touched only by real app code, never by a test that
// imports this module to exercise the diff/queue functions below.
import { get, put, getAll } from './db'
import { verify_event } from './svastha'
import type { StoredEvent } from './events'
import { writable } from 'svelte/store'
import { checkMailboxForInvites, pullShared, teardownSharing } from './shared'
import { bytesToBase64, base64ToBytes } from './base64'

/** The relay surface this engine needs — narrower than `RelayClient` so
 * tests can supply an in-memory fake without fighting `RelayClient`'s
 * private-field nominal typing. `RelayClient` satisfies this structurally. */
export interface BlobClient {
  putBlob(id: string, blob: Uint8Array): Promise<void>
  getBlob(id: string): Promise<Uint8Array | null>
  listBlobs(): Promise<string[]>
}

/** The vault-key surface this engine needs. `WasmDataKey` satisfies this
 * structurally. */
export interface SealKey {
  seal(plaintext: Uint8Array, aad: Uint8Array): Uint8Array
  open(sealed: Uint8Array, aad: Uint8Array): Uint8Array
}

/** A namespace plug-in. `doc-` and `cur-` arrive in later PRs and register
 * here the same way the events codec (below) does. */
export interface Codec {
  prefix: string
  /**
   * `ev-`/`doc-` blob ids are content-addressed: once a device has pushed or
   * pulled one, that id's content can never change, so "already handled" is
   * permanent (`idsToPull`'s `doneIds` filtering, and `pullAll`'s
   * `localHas`-then-skip below, both lean on this). `cur-` blobs are the one
   * namespace where that's false — the SAME id gets `PUT` over with new
   * content on every write (see docs/ARCHITECTURE.md's "Curation overlay").
   * Setting `mutable: true` opts a codec out of both of those
   * once-and-done shortcuts: its ids are always re-pulled (never filtered by
   * `doneIds`), always re-fetched-and-applied (never skipped just because
   * `localHas` is true), and always re-enqueued by a fresh local write (never
   * skipped by `enqueue`'s "already done" check). Defaults to `false`.
   */
  mutable?: boolean
  localHas(id: string): Promise<boolean>
  localLoad(id: string): Promise<Uint8Array | null>
  remoteApply(id: string, plaintext: Uint8Array): Promise<void>
}

const codecs: Codec[] = []

export function registerCodec(codec: Codec): void {
  codecs.push(codec)
}

function codecFor(id: string): Codec | undefined {
  return codecs.find((c) => id.startsWith(c.prefix))
}

function isMutableId(id: string): boolean {
  return codecFor(id)?.mutable === true
}

/** Every vault-key-sealed blob is bound to its own id as AAD: a malicious
 * relay must not be able to swap ciphertext between two blob ids
 * undetected. */
function aad(blobId: string): Uint8Array {
  return new TextEncoder().encode(blobId)
}

// --- events codec ('ev-') ---

function eventBlobId(eventId: string): string {
  return `ev-${eventId}`
}

function eventIdFromBlobId(blobId: string): string {
  return blobId.slice('ev-'.length)
}

const eventsCodec: Codec = {
  prefix: 'ev-',
  async localHas(id) {
    return (await get('events', eventIdFromBlobId(id))) !== undefined
  },
  async localLoad(id) {
    const stored = await get<StoredEvent>('events', eventIdFromBlobId(id))
    return stored ? new TextEncoder().encode(JSON.stringify(stored)) : null
  },
  async remoteApply(id, plaintext) {
    const eventId = eventIdFromBlobId(id)
    const json = new TextDecoder().decode(plaintext)
    // A malicious relay must not be able to inject or swap events: the
    // signature must verify, AND the embedded id must equal the blob id it
    // was fetched under (`aad` above binds the sealing; this binds content).
    if (!verify_event(json)) throw new Error(`ev- blob ${id}: signature does not verify`)
    const signed = JSON.parse(json) as StoredEvent
    if (signed.event.id !== eventId) throw new Error(`ev- blob ${id}: embedded id does not match`)
    await put('events', signed)
  },
}
registerCodec(eventsCodec)

// --- provenance codec ('doc-') ---
//
// One entry per imported source document (see `import.ts`): the verbatim
// bytes, kept so parsers can re-derive facts as the mapping improves (see
// docs/ARCHITECTURE.md, "Data model and interop"), plus its display name. The
// wire payload is a small JSON envelope (name + base64 bytes) rather than raw
// bytes with an ad hoc binary header — it reuses the same "JSON blob, sealed
// under the vault key" shape as every other namespace here instead of
// inventing a framing just for this one.

export interface ProvenanceRecord {
  sha256: string
  name: string
  bytes: Uint8Array
  importedAt: string
}

function provenanceIdFromBlobId(blobId: string): string {
  return blobId.slice('doc-'.length)
}

/** Duplicated from import.ts's own `sha256Hex` rather than imported: import.ts
 * imports enqueue/drain from this module, and this module importing back from
 * import.ts would make the two circular. */
async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as BufferSource)
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')
}

const provenanceCodec: Codec = {
  prefix: 'doc-',
  async localHas(id) {
    return (await get<ProvenanceRecord>('provenance', provenanceIdFromBlobId(id))) !== undefined
  },
  async localLoad(id) {
    const doc = await get<ProvenanceRecord>('provenance', provenanceIdFromBlobId(id))
    if (!doc) return null
    const envelope = JSON.stringify({ name: doc.name, bytes: bytesToBase64(doc.bytes) })
    return new TextEncoder().encode(envelope)
  },
  async remoteApply(id, plaintext) {
    const sha256 = provenanceIdFromBlobId(id)
    const { name, bytes: b64 } = JSON.parse(new TextDecoder().decode(plaintext)) as { name: string; bytes: string }
    const bytes = base64ToBytes(b64)
    // Mirrors the ev- codec's embedded-id check: the AAD binding already
    // stops the relay from swapping ciphertext between blob ids, but this
    // additionally guards against a same-device bug (e.g. a document pushed
    // under the wrong sha256) ever landing silently.
    const actual = await sha256Hex(bytes)
    if (actual !== sha256) throw new Error(`doc- blob ${id}: content hash does not match the blob id`)
    await put('provenance', { sha256, name, bytes, importedAt: new Date().toISOString() })
  },
}
registerCodec(provenanceCodec)

// --- attachments codec ('att-') ---
//
// One entry per captured document page (see `attachments.ts`): the downscaled
// JPEG bytes of a photographed paper record, content-addressed by the SHA-256
// of those plaintext bytes. Modeled exactly on the `doc-` codec above — same
// "JSON envelope (mime + base64 bytes) sealed under the vault key, AAD = blob
// id" shape, same embedded-hash check — because a captured document is the same
// kind of opaque, immutable, content-addressed blob an imported source document
// is. The `attachment` event value carries the sha256, so a synced event points
// at the `att-` blob its bytes live in.

interface AttachmentRow {
  sha256: string
  mime: string
  size: number
  bytes: Uint8Array
  capturedAt: string
}

function attachmentIdFromBlobId(blobId: string): string {
  return blobId.slice('att-'.length)
}

const attachmentsCodec: Codec = {
  prefix: 'att-',
  async localHas(id) {
    return (await get<AttachmentRow>('attachments', attachmentIdFromBlobId(id))) !== undefined
  },
  async localLoad(id) {
    const att = await get<AttachmentRow>('attachments', attachmentIdFromBlobId(id))
    if (!att) return null
    const envelope = JSON.stringify({ mime: att.mime, bytes: bytesToBase64(att.bytes) })
    return new TextEncoder().encode(envelope)
  },
  async remoteApply(id, plaintext) {
    const sha256 = attachmentIdFromBlobId(id)
    const { mime, bytes: b64 } = JSON.parse(new TextDecoder().decode(plaintext)) as {
      mime: string
      bytes: string
    }
    const bytes = base64ToBytes(b64)
    // Same embedded-hash guard the doc- codec makes: the AAD binding already
    // stops the relay swapping ciphertext between ids, and this additionally
    // catches a same-device bug (bytes stored under the wrong sha256) rather
    // than letting it land silently.
    const actual = await sha256Hex(bytes)
    if (actual !== sha256) throw new Error(`att- blob ${id}: content hash does not match the blob id`)
    await put('attachments', {
      sha256,
      mime,
      size: bytes.length,
      bytes,
      capturedAt: new Date().toISOString(),
    })
  },
}
registerCodec(attachmentsCodec)

// --- pure diff functions (unit tested without wasm or a browser) ---

/** Blob ids on the relay this device should pull: known to a registered
 * codec, and either not already applied locally or (see `Codec.mutable`'s
 * doc comment) belonging to a namespace that must be re-checked every pull
 * regardless of `doneIds`. */
export function idsToPull(remoteIds: string[], doneIds: ReadonlySet<string>): string[] {
  return remoteIds.filter((id) => codecFor(id) !== undefined && (isMutableId(id) || !doneIds.has(id)))
}

/** Local events missing from the relay's list — these need pushing so a
 * second device converges without a manifest (restore-then-log-on-two-devices
 * agreement). */
export function idsToPush(
  localEventIds: string[],
  remoteIds: ReadonlySet<string>,
  doneIds: ReadonlySet<string>,
): string[] {
  return localEventIds
    .map(eventBlobId)
    .filter((blobId) => !remoteIds.has(blobId) && !doneIds.has(blobId))
}

// --- single-blob open/seal primitives ---
//
// The verify+store and load+seal steps of a pull/push, factored out of
// `pullAll`/`pushOne` so a file import (export.ts) can run each sealed blob
// through the exact same codec path a relay pull uses — same open, same
// embedded-id/signature checks, same LWW merge — without going through the
// outbox (which would mark applied ids `done` and wrongly suppress a later
// push of imported blobs). `aad`/`codecFor`/`codecs` stay private; these are
// the sanctioned entry points.

export type ApplyOutcome = 'new' | 'duplicate' | 'merged' | 'unknown'

/** Open one sealed blob (AAD = its id) and apply it through its codec's
 * verify+store path — the same path `pullAll` uses. Does NOT touch the outbox.
 * An immutable id already applied locally is a `duplicate` (opened bytes are
 * redundant, so it's skipped without opening); a mutable id is always opened
 * and re-merged (`merged`); anything else opened is `new`. Errors (bad open,
 * failed signature, hash mismatch) propagate. */
export async function applySealedBlob(id: string, sealed: Uint8Array, key: SealKey): Promise<ApplyOutcome> {
  const codec = codecFor(id)
  if (!codec) return 'unknown'
  if (!codec.mutable && (await codec.localHas(id))) return 'duplicate'
  const plaintext = key.open(sealed, aad(id))
  await codec.remoteApply(id, plaintext)
  return codec.mutable ? 'merged' : 'new'
}

/** Load one blob's local plaintext through its codec and seal it (AAD = id) —
 * `pushOne` minus the relay PUT. Null when nothing local exists under the id
 * (no codec, or the codec has no local record). */
export async function sealLocalBlob(id: string, key: SealKey): Promise<Uint8Array | null> {
  const codec = codecFor(id)
  const plaintext = codec ? await codec.localLoad(id) : null
  if (!plaintext) return null
  return key.seal(plaintext, aad(id))
}

/** Every blob id representable from this device's local data: an `ev-` per
 * event, a `doc-` per provenance record, an `att-` per captured attachment, a
 * `cur-` per curation key. `vault.key` is deliberately excluded — it is not a
 * codec (it is the wrapped key itself, carried separately by the export
 * container). */
export async function listLocalBlobIds(): Promise<string[]> {
  const events = (await getAll<StoredEvent>('events')).map((e) => eventBlobId(e.event.id))
  const docs = (await getAll<ProvenanceRecord>('provenance')).map((p) => `doc-${p.sha256}`)
  const attachments = (await getAll<AttachmentRow>('attachments')).map((a) => `att-${a.sha256}`)
  // Dynamic import for the same reason `configure` above imports curation.ts
  // dynamically: curation.ts statically imports this module, so a static
  // import back would form a cycle.
  const { curationBlobIdForKey } = await import('./curation')
  const curationRecords = await getAll<{ key: string }>('curation')
  const curation = await Promise.all(curationRecords.map((r) => curationBlobIdForKey(r.key)))
  return [...events, ...docs, ...attachments, ...curation]
}

// --- status surface ---
//
// A plain Svelte store (not a `.svelte.ts` rune module) for the same reason
// as the module doc comment above: `svelte/store`'s `writable` is a regular
// function export, not a compiler macro, so it works under plain vitest.
// Settings.svelte reads it with `$syncStatus`.

export interface SyncStatusValue {
  configured: boolean
  online: boolean
  pendingCount: number
  lastPullAt: string | null
  lastError: string | null
  // Applied-during-the-current-pull counter, reset at the start of each
  // `pullAll()`. Onboard's restore-with-relay flow reads this for a "N so
  // far" progress line; nothing else needs it, so it's not otherwise wired.
  pulledCount: number
}

// `navigator.onLine` is a browser API; under vitest/Node it's either absent
// or present-but-`undefined` (as opposed to explicitly `false`), so treat
// anything other than an explicit `false` as online.
function isOnline(): boolean {
  return typeof navigator === 'undefined' || navigator.onLine !== false
}

export const syncStatus = writable<SyncStatusValue>({
  configured: false,
  online: isOnline(),
  pendingCount: 0,
  lastPullAt: null,
  lastError: null,
  pulledCount: 0,
})

function patchStatus(partial: Partial<SyncStatusValue>): void {
  syncStatus.update((s) => ({ ...s, ...partial }))
}

// --- outbox ---

interface SyncRecord {
  id: string
  state: 'pending' | 'done'
  updated_at: string
}

/** Capped exponential backoff for a failing push: 1s, 5s, 30s, then give up
 * and wait for the next external trigger (an enqueue, the 'online' event, or
 * the next scheduled pull) rather than retrying forever unattended. */
export const BACKOFF_SCHEDULE_MS = [1000, 5000, 30_000]

async function refreshPendingCount(): Promise<void> {
  const all = await getAll<SyncRecord>('sync')
  patchStatus({ pendingCount: all.filter((r) => r.state === 'pending').length })
}

async function markDone(id: string): Promise<void> {
  await put('sync', { id, state: 'done', updated_at: new Date().toISOString() })
}

/** Queue blobs for push. Already-`done` ids are left alone — re-enqueuing a
 * blob that is already confirmed on the relay would just re-push identical
 * ciphertext (harmless, but pointless).
 *
 * Deliberately does not kick `drain()` itself: callers that want the queue
 * drained right away (the events hook, `pullAll`'s reconcile step, the
 * 'online' handler) do so explicitly, one line after their `enqueue` call.
 * This keeps `enqueue` awaitable to a clean, fully-settled state — useful
 * for tests, and for anything that wants to know the queue write landed
 * without racing `drain`'s own reentrancy guard. */
export async function enqueue(blobIds: string[]): Promise<void> {
  const now = new Date().toISOString()
  for (const id of blobIds) {
    const existing = await get<SyncRecord>('sync', id)
    // A mutable id (see `Codec.mutable`) can be 'done' from a stale pull or
    // an earlier push of an older value; a fresh local write always has
    // something new to push regardless, so it bypasses the "already done"
    // skip that's correct for a content-addressed (immutable) blob id.
    if (existing?.state === 'done' && !isMutableId(id)) continue
    await put('sync', { id, state: 'pending', updated_at: now })
  }
  await refreshPendingCount()
}

async function nextPending(): Promise<SyncRecord | undefined> {
  const all = await getAll<SyncRecord>('sync')
  return all.find((r) => r.state === 'pending')
}

let relayClient: BlobClient | null = null
let vaultKey: SealKey | null = null
let draining = false

/** Wire the relay client and vault key the engine pushes/pulls through.
 * Split out from `syncInit` so tests can drive `enqueue`/`drain`/`pullAll`
 * against a mock relay without the browser-only wiring (event listeners,
 * timers, the events-hook dynamic import) `syncInit` also does. */
export function configure(relay: BlobClient, key: SealKey): void {
  relayClient = relay
  vaultKey = key
  // Dynamic import: curation.ts registers its own 'cur-' codec as a
  // top-level side effect (mirrors this file's own ev-/doc- registration
  // above) once this module is loaded. Loading it dynamically rather than
  // with a static import avoids a circular import back to this file (which
  // curation.ts imports for `registerCodec`/`enqueue`/`drain`) — the same
  // shape as `installEventsHook` below, and for the same reason.
  void import('./curation')
}

/** Push every pending outbox entry, one at a time (concurrency 1 is fine at
 * this scale — quick-log rarely produces more than a handful of events per
 * save). Stops and waits for the next trigger once a push has exhausted
 * `BACKOFF_SCHEDULE_MS`, rather than retrying unattended forever. */
export async function drain(): Promise<void> {
  if (draining || !relayClient || !vaultKey) return
  if (!isOnline()) return
  draining = true
  try {
    for (;;) {
      const pending = await nextPending()
      if (!pending) return

      let attempt = 0
      for (;;) {
        try {
          await pushOne(pending.id)
          break
        } catch (err) {
          patchStatus({ lastError: String(err) })
          if (attempt >= BACKOFF_SCHEDULE_MS.length) return // wait for the next trigger
          await new Promise((resolve) => setTimeout(resolve, BACKOFF_SCHEDULE_MS[attempt]))
          attempt++
        }
      }
    }
  } finally {
    draining = false
    await refreshPendingCount()
  }
}

async function pushOne(blobId: string): Promise<void> {
  const sealed = await sealLocalBlob(blobId, vaultKey!)
  if (!sealed) {
    // Nothing to push — deleted locally, or an id with no registered codec.
    // Mark it done so it isn't retried forever.
    await markDone(blobId)
    return
  }
  await relayClient!.putBlob(blobId, sealed)
  await markDone(blobId)
}

/** List the relay, pull anything new, and enqueue any local event missing
 * remotely (the reconcile step that makes two devices converge). */
export async function pullAll(): Promise<void> {
  if (!relayClient || !vaultKey) return

  let remoteIds: string[]
  try {
    remoteIds = await relayClient.listBlobs()
  } catch (err) {
    patchStatus({ lastError: String(err) })
    return
  }

  const syncRecords = await getAll<SyncRecord>('sync')
  const doneIds = new Set(syncRecords.filter((r) => r.state === 'done').map((r) => r.id))

  patchStatus({ pulledCount: 0 })
  for (const id of idsToPull(remoteIds, doneIds)) {
    const codec = codecFor(id)! // idsToPull only returns ids with a registered codec
    try {
      // The localHas-then-skip shortcut only makes sense for an immutable
      // id: "already have it" and "have the latest version of it" are the
      // same fact there. For a mutable id they're not (someone else may have
      // PUT a newer value over the same id), so always fetch and let the
      // codec's own remoteApply (LWW merge, for cur-) decide. This mirrors
      // `applySealedBlob`'s own duplicate check, but is kept here too so a
      // duplicate skips the `getBlob` round trip entirely.
      if (!codec.mutable && (await codec.localHas(id))) {
        // Already have it (e.g. logged before sync was configured) — record
        // done without a redundant round trip.
        await markDone(id)
        continue
      }
      const blob = await relayClient.getBlob(id)
      if (!blob) continue
      await applySealedBlob(id, blob, vaultKey)
      await markDone(id)
      syncStatus.update((s) => ({ ...s, pulledCount: s.pulledCount + 1 }))
    } catch (err) {
      // Left un-done on failure (bad open, failed verify, network hiccup) —
      // retried on the next pull rather than dropped.
      patchStatus({ lastError: String(err) })
    }
  }

  const localEventIds = (await getAll<StoredEvent>('events')).map((e) => e.event.id)
  const toPush = idsToPush(localEventIds, new Set(remoteIds), doneIds)
  if (toPush.length) {
    await enqueue(toPush)
    void drain()
  }

  // Sharing rides the same pull cycle: surface any new mailbox invites, then
  // pull whatever accepted shares have new events, after this device's own
  // pull/push reconcile above.
  await checkMailboxForInvites()
  await pullShared()

  patchStatus({ lastPullAt: new Date().toISOString() })
}

// --- lifecycle ---

const PULL_INTERVAL_MS = 5 * 60 * 1000
let pullTimer: ReturnType<typeof setInterval> | null = null

/** Dynamically imported (see the module doc comment) so this file never
 * statically depends on events.ts's runtime. */
async function installEventsHook(): Promise<void> {
  const { setOnEventsLogged } = await import('./events')
  setOnEventsLogged((events) => {
    void enqueue(events.map((e) => eventBlobId(e.event.id))).then(() => drain())
  })
}

async function clearEventsHook(): Promise<void> {
  const { setOnEventsLogged } = await import('./events')
  setOnEventsLogged(() => {})
}

function handleOnline(): void {
  patchStatus({ online: true })
  void drain()
}

function handleOffline(): void {
  patchStatus({ online: false })
}

function handleVisibility(): void {
  if (document.visibilityState === 'visible') void pullAll()
}

/**
 * Start the sync engine for an unlocked, relay-configured session. Idempotent
 * — a second call while already configured is a no-op.
 *
 * Callers MUST have already reconciled the vault key against the relay
 * (`vault.ts`'s `ensureVaultKeyBlob`) before calling this: pushing an event
 * sealed under the wrong vault key is unrecoverable. `vault.ts`'s
 * `connectRelay` is the one place that enforces this ordering — call that,
 * not this function directly, from UI code.
 */
export function syncInit(relay: BlobClient, key: SealKey): void {
  if (relayClient) return
  configure(relay, key)
  patchStatus({
    configured: true,
    online: isOnline(),
    lastError: null,
  })

  void installEventsHook()
  if (typeof window !== 'undefined') {
    window.addEventListener('online', handleOnline)
    window.addEventListener('offline', handleOffline)
  }
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', handleVisibility)
  }

  void pullAll()
  pullTimer = setInterval(() => void pullAll(), PULL_INTERVAL_MS)
}

/** Stop the engine and forget the relay/vault key — called on lock/logout. */
export function syncTeardown(): void {
  relayClient = null
  vaultKey = null
  draining = false
  patchStatus({ configured: false })
  teardownSharing()
  void clearEventsHook()
  if (typeof window !== 'undefined') {
    window.removeEventListener('online', handleOnline)
    window.removeEventListener('offline', handleOffline)
  }
  if (typeof document !== 'undefined') {
    document.removeEventListener('visibilitychange', handleVisibility)
  }
  if (pullTimer) clearInterval(pullTimer)
  pullTimer = null
}
