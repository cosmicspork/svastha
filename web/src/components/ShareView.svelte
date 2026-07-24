<script lang="ts">
  // The cold-load share view: what a doctor sees when they open a share link in
  // a browser that has never run Svastha (or the owner's own browser, without
  // disturbing their vault). Everything here lives in memory for the tab's
  // life — App.svelte routes to this before any onboarding/unlock/IndexedDB
  // path runs. See shareRecipient.ts for the parse/fetch/open/verify pipeline.
  import { onMount } from 'svelte'
  import { initSvastha } from '../lib/svastha'
  import { loadShare, type ShareLoadResult } from '../lib/shareRecipient'
  import { inspectFileShare, openWithPassphrase } from '../lib/fileShare'
  import { statusMapFrom, nameMapFrom } from '../lib/curation'
  import { fingerprint } from '../lib/exchange'
  import { base64ToBytes } from '../lib/base64'
  import { buildTimeline, type TimelineEntry, type AttachmentRef } from '../lib/timeline'
  import { mimeForDocName } from '../lib/provenance'
  import ClinicianSummary from './ClinicianSummary.svelte'
  import AttachmentViewer from './AttachmentViewer.svelte'

  // null = still loading; the pipeline is wasm-gated, so nothing is shown until
  // initSvastha resolves. A successfully-opened file share is folded into the
  // same `{ status: 'ok', bundle }` shape, so the whole viewer below renders it
  // identically to a link — the format only changes how the bytes and key arrive.
  let result = $state<ShareLoadResult | null>(null)

  // Two entry shapes share this cold view: a link (`#/s/{token}.{key}.{relay}`,
  // a real fetch-and-open) and the relay-less file path (`#/s`, no fragment — a
  // file the recipient was handed out of band). A present-but-malformed fragment
  // stays a link attempt (→ the invalid-link error), so only a truly fragment-
  // less hash opens the file picker.
  function isLinkAttempt(hash: string): boolean {
    const s = hash.replace(/^#/, '')
    return s.startsWith('/s/') && s.slice(3).length > 0
  }
  const linkMode = isLinkAttempt(window.location.hash)

  // File-open state (file mode only): a damaged-file flag, drag styling, and —
  // for a passphrase-protected file — the retained sealed body + KDF params so a
  // wrong phrase can be retried without re-reading the file.
  let fileDamaged = $state(false)
  let dragOver = $state(false)
  let phrasePrompt = $state<{ body: Uint8Array; salt: Uint8Array; iterations: number } | null>(null)
  let phraseInput = $state('')
  let phraseError = $state(false)
  let phraseBusy = $state(false)

  async function openFile(file: File): Promise<void> {
    fileDamaged = false
    phraseError = false
    const bytes = new Uint8Array(await file.arrayBuffer())
    const inspection = inspectFileShare(bytes)
    if (inspection.status === 'ok') {
      result = { status: 'ok', bundle: inspection.bundle }
    } else if (inspection.status === 'passphrase') {
      phrasePrompt = { body: inspection.body, salt: inspection.salt, iterations: inspection.iterations }
    } else {
      fileDamaged = true
    }
  }

  function onFileInput(e: Event): void {
    const file = (e.currentTarget as HTMLInputElement).files?.[0]
    if (file) void openFile(file)
  }

  function onDrop(e: DragEvent): void {
    e.preventDefault()
    dragOver = false
    const file = e.dataTransfer?.files?.[0]
    if (file) void openFile(file)
  }

  async function submitPhrase(): Promise<void> {
    if (!phrasePrompt || phraseBusy) return
    phraseBusy = true
    phraseError = false
    const bundle = await openWithPassphrase(
      phrasePrompt.body,
      phrasePrompt.salt,
      phrasePrompt.iterations,
      phraseInput,
    )
    phraseBusy = false
    if (bundle) {
      result = { status: 'ok', bundle }
      phrasePrompt = null
      phraseInput = ''
    } else {
      phraseError = true
    }
  }

  function resetFile(): void {
    phrasePrompt = null
    phraseInput = ''
    phraseError = false
    fileDamaged = false
  }

  // The paper records the shared events reference, and the open viewer entry.
  // The loader reads the bundle's own in-memory attachments map (base64 → bytes)
  // — a recipient has no vault key and no relay, so the bytes travel inline.
  let viewerEntry = $state<TimelineEntry | null>(null)

  const paperEntries = $derived.by<TimelineEntry[]>(() => {
    if (result?.status !== 'ok') return []
    return buildTimeline(result.bundle.events, 'note')
      .flatMap((day) => day.entries)
      .filter((e) => e.attachments && e.attachments.length > 0)
  })

  // The imported source documents (`doc-`) the shared events point at, distinct
  // by sha256 (several events commonly share one imported source document).
  // Mirrors Spine.svelte's own `sourceDocViewer`, over the bundle's inlined
  // `documents` map instead of the local `provenance` store.
  interface SourceDocEntry {
    sha256: string
    name: string
    recordedIso: string
  }
  interface SourceDocViewer {
    page: AttachmentRef
    caption: string
    recordedIso: string
  }
  let sourceDocViewer = $state<SourceDocViewer | null>(null)

  const sourceDocEntries = $derived.by<SourceDocEntry[]>(() => {
    if (result?.status !== 'ok') return []
    const { events, documents } = result.bundle
    const seen = new Map<string, string>() // sha256 -> a representative effective_at
    for (const se of events) {
      const sha = se.event.provenance.source_doc
      if (!sha || !documents[sha] || seen.has(sha)) continue
      seen.set(sha, se.event.effective_at ?? result.bundle.createdAt)
    }
    return [...seen.entries()]
      .map(([sha256, recordedIso]) => ({ sha256, name: documents[sha256].name, recordedIso }))
      .sort((a, b) => a.name.localeCompare(b.name))
  })

  function openSourceDoc(entry: SourceDocEntry): void {
    const doc = result?.status === 'ok' ? result.bundle.documents[entry.sha256] : undefined
    sourceDocViewer = {
      page: { sha256: entry.sha256, mime: doc ? mimeForDocName(doc.name) : 'text/plain' },
      caption: entry.name,
      recordedIso: entry.recordedIso,
    }
  }

  // The verified `status:`/`name:` overlay the share carried, folded into the
  // concept maps the summary renders from — so a recipient sees the owner's
  // real Current/Past split and name overrides, not a flat all-active list.
  const statusMap = $derived(result?.status === 'ok' ? statusMapFrom(result.bundle.curation) : new Map())
  const nameMap = $derived(result?.status === 'ok' ? nameMapFrom(result.bundle.curation) : new Map())

  function loadSharedBytes(sha256: string): Promise<Uint8Array | null> {
    const b64 = result?.status === 'ok' ? result.bundle.attachments[sha256] : undefined
    return Promise.resolve(b64 ? base64ToBytes(b64) : null)
  }

  function loadSharedDocBytes(sha256: string): Promise<Uint8Array | null> {
    const b64 = result?.status === 'ok' ? result.bundle.documents[sha256]?.bytes : undefined
    return Promise.resolve(b64 ? base64ToBytes(b64) : null)
  }

  async function load() {
    result = null
    await initSvastha()
    // Link mode fetches and opens; file mode leaves `result` null so the picker
    // renders (initSvastha still had to run — inspecting a file needs wasm).
    if (linkMode) result = await loadShare(window.location.hash)
  }

  onMount(load)

  const ERROR_COPY: Record<string, string> = {
    expired:
      'This shared record has expired or was withdrawn by the sender. Ask them for a new link.',
    invalid: 'This link is invalid or incomplete.',
    damaged: 'This link is damaged — ask the sender to resend it.',
    network: "Can't reach the record right now. Check your connection and try again.",
  }

  function sharedOn(iso: string): string {
    const d = new Date(iso)
    if (Number.isNaN(d.getTime())) return iso
    return d.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' })
  }
</script>

<div class="share">
  {#if result === null && !linkMode}
    <!-- Relay-less file path: no fragment in the URL, so offer to open a share
         file the recipient was handed out of band. -->
    <div class="state file-open" data-testid="share-file-open">
      <h1>Open a shared record</h1>
      {#if phrasePrompt}
        <p class="lede">
          This file is protected by a passphrase. Enter the words the sender gave you separately.
        </p>
        <div class="phrase-row">
          <input
            type="text"
            autocomplete="off"
            autocapitalize="none"
            spellcheck="false"
            placeholder="seven words"
            bind:value={phraseInput}
            onkeydown={(e) => e.key === 'Enter' && submitPhrase()}
            data-testid="file-passphrase-input"
          />
          <button
            class="primary"
            onclick={submitPhrase}
            disabled={phraseBusy || phraseInput.trim().length === 0}
            data-testid="file-passphrase-submit"
          >
            Open
          </button>
        </div>
        {#if phraseError}
          <p class="error-msg" data-testid="file-passphrase-error">
            That passphrase didn’t open the file. Check the words and try again.
          </p>
        {/if}
        <button class="link" onclick={resetFile} data-testid="file-choose-another">
          Choose a different file
        </button>
      {:else}
        <p class="lede">Choose the share file the sender gave you, or drop it here.</p>
        <label
          class="dropzone"
          class:over={dragOver}
          ondragover={(e) => {
            e.preventDefault()
            dragOver = true
          }}
          ondragleave={() => (dragOver = false)}
          ondrop={onDrop}
          data-testid="file-share-dropzone"
        >
          <input type="file" accept=".svashare" onchange={onFileInput} data-testid="file-share-input" />
          <span>Choose a file or drop it here</span>
        </label>
        {#if fileDamaged}
          <p class="error-msg" data-testid="file-share-damaged">
            This file isn’t a valid Svastha share, or it’s damaged. Ask the sender to resend it.
          </p>
        {/if}
      {/if}
    </div>
  {:else if result === null}
    <p class="muted" data-testid="share-loading">Opening shared record…</p>
  {:else if result.status === 'error'}
    <div class="state" data-testid="share-error" data-error={result.error}>
      <h1>Shared record</h1>
      <p class="error-msg">{ERROR_COPY[result.error]}</p>
      {#if result.error === 'network'}
        <button onclick={load} data-testid="share-retry">Try again</button>
      {/if}
    </div>
  {:else}
    {@const bundle = result.bundle}
    <header class="share-head">
      <h1>Shared medical record</h1>
      <p class="muted meta" data-testid="share-meta">Shared on {sharedOn(bundle.createdAt)}</p>
      <p class="verify" data-testid="share-verify">
        {bundle.verified}
        {bundle.verified === 1 ? 'record' : 'records'} verified · key
        <span class="fp">{fingerprint(bundle.signerHex)}</span>
      </p>
      {#if bundle.dropped > 0}
        <p class="warn" data-testid="share-warning">
          {bundle.dropped}
          {bundle.dropped === 1 ? 'entry' : 'entries'} could not be verified and {bundle.dropped === 1
            ? 'was'
            : 'were'} left out.
        </p>
      {/if}
      {#if bundle.droppedCuration > 0}
        <p class="warn" data-testid="share-curation-warning">
          {bundle.droppedCuration}
          status or name {bundle.droppedCuration === 1 ? 'label' : 'labels'} could not be verified and {bundle.droppedCuration ===
          1
            ? 'was'
            : 'were'} left out.
        </p>
      {/if}
    </header>

    <ClinicianSummary events={bundle.events} readonly status={statusMap} names={nameMap} />

    {#if paperEntries.length > 0}
      <section class="documents" data-testid="share-documents">
        <h2 class="doc-head">Documents</h2>
        <ul class="doc-list">
          {#each paperEntries as entry (entry.effective_at)}
            <li>
              <button
                type="button"
                class="doc-row"
                onclick={() => (viewerEntry = entry)}
                data-testid="share-doc-row"
              >
                <span class="doc-glyph" aria-hidden="true">📷</span>
                <span class="doc-label">{entry.label}</span>
                <span class="doc-hint muted">{entry.hint}</span>
              </button>
            </li>
          {/each}
        </ul>
      </section>
    {/if}

    {#if sourceDocEntries.length > 0}
      <section class="documents" data-testid="share-source-docs">
        <h2 class="doc-head">Source documents</h2>
        <ul class="doc-list">
          {#each sourceDocEntries as entry (entry.sha256)}
            <li>
              <button
                type="button"
                class="doc-row"
                onclick={() => openSourceDoc(entry)}
                data-testid="share-source-doc-row"
              >
                <span class="doc-glyph" aria-hidden="true">📄</span>
                <span class="doc-label">{entry.name}</span>
              </button>
            </li>
          {/each}
        </ul>
      </section>
    {/if}
  {/if}
</div>

{#if viewerEntry?.attachments}
  <AttachmentViewer
    pages={viewerEntry.attachments}
    caption={viewerEntry.label}
    recordedIso={viewerEntry.effective_at}
    source={viewerEntry.detail.source}
    loadBytes={loadSharedBytes}
    onclose={() => (viewerEntry = null)}
  />
{/if}

{#if sourceDocViewer}
  <AttachmentViewer
    pages={[sourceDocViewer.page]}
    caption={sourceDocViewer.caption}
    recordedIso={sourceDocViewer.recordedIso}
    loadBytes={loadSharedDocBytes}
    onclose={() => (sourceDocViewer = null)}
  />
{/if}

<style>
  .share {
    max-width: 40rem;
    margin: 0 auto;
  }

  .share-head {
    margin-bottom: var(--space-5);
  }

  .share-head h1 {
    margin-bottom: var(--space-2);
  }

  .meta {
    font-size: var(--text-sm);
    margin-bottom: var(--space-2);
  }

  .verify {
    font-size: var(--text-sm);
    color: var(--muted);
    margin: 0;
  }

  /* The fingerprint is the out-of-band anchor a reader confirms with the
     sender, so it wants to be legible and copyable, not chrome. */
  .fp {
    font-family: var(--font-data);
    color: var(--text);
    white-space: nowrap;
  }

  .warn {
    margin: var(--space-3) 0 0;
    font-size: var(--text-sm);
    color: var(--danger);
  }

  .documents {
    margin-top: var(--space-6);
  }

  .doc-head {
    font-size: var(--text-lg);
    margin-bottom: var(--space-3);
  }

  .doc-list {
    list-style: none;
    padding: 0;
    margin: 0;
  }

  .doc-list li {
    border-top: 1px solid var(--border);
  }

  .doc-row {
    width: 100%;
    display: flex;
    align-items: baseline;
    gap: var(--space-2);
    min-height: 44px;
    padding: var(--space-2) 0;
    border: none;
    background: none;
    color: inherit;
    text-align: left;
  }

  .doc-glyph {
    flex: none;
  }

  .doc-label {
    flex: 1;
    min-width: 0;
    overflow-wrap: anywhere;
  }

  .doc-hint {
    flex: none;
    font-size: var(--text-xs);
  }

  .state {
    padding: var(--space-6) 0;
  }

  .error-msg {
    font-size: var(--text-base);
    margin-bottom: var(--space-4);
  }

  .file-open .lede {
    color: var(--muted);
    margin-bottom: var(--space-4);
  }

  /* A labelled file input styled as a drop target: the native input sits inside
     the label so a click anywhere opens the picker, and the label is also the
     drag-and-drop surface. */
  .dropzone {
    display: flex;
    align-items: center;
    justify-content: center;
    min-height: 8rem;
    padding: var(--space-5);
    border: 2px dashed var(--border);
    border-radius: var(--radius-lg);
    background: var(--surface);
    color: var(--muted);
    text-align: center;
    cursor: pointer;
  }

  .dropzone.over {
    border-color: var(--action);
    color: var(--text);
  }

  .dropzone input[type='file'] {
    /* Keep the native input reachable (Playwright, keyboard) but out of the
       layout — the whole label is the visible target. */
    position: absolute;
    width: 1px;
    height: 1px;
    opacity: 0;
    pointer-events: none;
  }

  .phrase-row {
    display: flex;
    gap: var(--space-2);
    margin-bottom: var(--space-3);
  }

  .phrase-row input {
    flex: 1;
    min-width: 0;
  }

  .link {
    display: inline;
    padding: 0;
    border: none;
    background: none;
    color: var(--action);
    text-decoration: underline;
    font: inherit;
  }
</style>
