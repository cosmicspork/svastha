<script lang="ts">
  // The cold-load share view: what a doctor sees when they open a share link in
  // a browser that has never run Svastha (or the owner's own browser, without
  // disturbing their vault). Everything here lives in memory for the tab's
  // life — App.svelte routes to this before any onboarding/unlock/IndexedDB
  // path runs. See shareRecipient.ts for the parse/fetch/open/verify pipeline.
  import { onMount } from 'svelte'
  import { initSvastha } from '../lib/svastha'
  import { loadShare, type ShareLoadResult } from '../lib/shareRecipient'
  import { fingerprint } from '../lib/exchange'
  import { base64ToBytes } from '../lib/base64'
  import { buildTimeline, type TimelineEntry } from '../lib/timeline'
  import ClinicianSummary from './ClinicianSummary.svelte'
  import AttachmentViewer from './AttachmentViewer.svelte'

  // null = still loading; the pipeline is wasm-gated, so nothing is shown until
  // initSvastha resolves.
  let result = $state<ShareLoadResult | null>(null)

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

  function loadSharedBytes(sha256: string): Promise<Uint8Array | null> {
    const b64 = result?.status === 'ok' ? result.bundle.attachments[sha256] : undefined
    return Promise.resolve(b64 ? base64ToBytes(b64) : null)
  }

  async function load() {
    result = null
    await initSvastha()
    result = await loadShare(window.location.hash)
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
  {#if result === null}
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
    </header>

    <ClinicianSummary events={bundle.events} readonly />

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
</style>
