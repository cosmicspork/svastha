<script lang="ts">
  import { onMount } from 'svelte'
  import { renderSVG } from 'uqr'
  import Sheet from './Sheet.svelte'
  import ClinicianSummary from './ClinicianSummary.svelte'
  import type { RelayClient } from '../lib/relay'
  import { normalizeRelayUrl } from '../lib/relay'
  import { session } from '../lib/session.svelte'
  import { allEvents, type StoredEvent } from '../lib/events'
  import { CATEGORIES, CATEGORY_META, type Category } from '../lib/category'
  import {
    createDoctorShare,
    filterEventsForScope,
    referencedAttachmentShas,
    listDoctorShares,
    revokeDoctorShare,
    shareLinkFor,
    shareStatus,
    EXPIRY_CHOICES,
    DEFAULT_EXPIRY_DAYS,
    type DoctorShareRecord,
    type ShareScope,
  } from '../lib/doctorShare'

  let { relay, relayUrl, onclose }: { relay: RelayClient; relayUrl: string; onclose: () => void } =
    $props()

  // Verbatim on every screen that mints or manages a link: revocation and
  // expiry are honest about what they can and can't take back.
  const HONEST_COPY =
    "Revoking stops anyone from opening this link again. It can't take back what " +
    "they've already seen, saved, or printed. For anything highly sensitive, share " +
    'it in person.'

  const relayOrigin = normalizeRelayUrl(relayUrl)
  const appOrigin = window.location.origin

  let events = $state<StoredEvent[]>([])
  let loaded = $state(false)

  // --- scope ---
  let fromDate = $state('')
  let toDate = $state('')
  let selected = $state<Set<Category>>(new Set())
  let expiryDays = $state<number>(DEFAULT_EXPIRY_DAYS)
  let showPreview = $state(false)

  function toggle(cat: Category) {
    const next = new Set(selected)
    if (next.has(cat)) next.delete(cat)
    else next.add(cat)
    selected = next
    showPreview = false
  }

  const scope = $derived<ShareScope>({
    // A day-granularity picker: include the whole "to" day, from the start of
    // the "from" day. Left local (no offset) — isoToMillis parses either way.
    fromIso: fromDate ? `${fromDate}T00:00:00` : null,
    toIso: toDate ? `${toDate}T23:59:59.999` : null,
    categories: selected.size > 0 ? [...selected] : null,
  })

  const filtered = $derived(filterEventsForScope(events, scope))
  // Paper records travel inside the share bundle (their bytes are inlined), so
  // surface the page count honestly — it's what can push a share toward the
  // relay's size cap.
  const pageCount = $derived(referencedAttachmentShas(filtered).length)

  const scopeDescription = $derived.by(() => {
    const cats =
      selected.size === 0
        ? 'All categories'
        : CATEGORIES.filter((c) => selected.has(c))
            .map((c) => CATEGORY_META[c].label)
            .join(', ')
    let dates = 'all dates'
    if (fromDate && toDate) dates = `${fromDate} to ${toDate}`
    else if (fromDate) dates = `from ${fromDate}`
    else if (toDate) dates = `through ${toDate}`
    return `${cats}; ${dates}`
  })

  // --- create / result ---
  let busy = $state(false)
  let error = $state('')
  let result = $state<{ link: string; record: DoctorShareRecord } | null>(null)
  let copied = $state(false)

  async function create() {
    if (!session.identity) return
    busy = true
    error = ''
    try {
      const { record, link } = await createDoctorShare({
        relay,
        identity: session.identity,
        events: filtered,
        scopeDescription,
        expiryDays,
        appOrigin,
        relayOrigin,
      })
      result = { link, record }
      await refreshShares()
    } catch (err) {
      error = err instanceof Error ? err.message : 'Could not create the share.'
    } finally {
      busy = false
    }
  }

  async function copy(link: string) {
    await navigator.clipboard.writeText(link)
    copied = true
    setTimeout(() => (copied = false), 2000)
  }

  function reset() {
    result = null
    showPreview = false
    error = ''
  }

  // --- manage ---
  let shares = $state<DoctorShareRecord[]>([])
  let qrFor = $state<string | null>(null)

  async function refreshShares() {
    shares = await listDoctorShares()
  }

  async function revoke(token: string) {
    try {
      await revokeDoctorShare(relay, token)
    } catch (err) {
      error = err instanceof Error ? err.message : 'Could not revoke the share.'
    }
    if (qrFor === token) qrFor = null
    await refreshShares()
  }

  function statusLabel(record: DoctorShareRecord): string {
    return shareStatus(record)
  }

  function linkFor(record: DoctorShareRecord): string | null {
    return shareLinkFor(record, appOrigin, relayOrigin)
  }

  onMount(async () => {
    events = await allEvents()
    await refreshShares()
    loaded = true
  })
</script>

<Sheet {onclose}>
  {#if result}
    <!-- Result screen: the link, a QR, and the honest guarantee. -->
    <h2>Share ready</h2>
    <p class="muted">{result.record.scopeDescription}</p>

    <!-- App-generated link, never user input; the string is a URL this app just
         built, so there is nothing here for a hostile value to exploit. -->
    <!-- eslint-disable-next-line svelte/no-at-html-tags -->
    <div class="qr" data-testid="share-qr">{@html renderSVG(result.link, { border: 2 })}</div>

    <p class="data link" data-testid="share-link">{result.link}</p>
    <div class="row">
      <button class="primary" onclick={() => copy(result!.link)} data-testid="copy-share-link">
        {copied ? 'Copied' : 'Copy link'}
      </button>
    </div>

    <p class="honest" data-testid="share-honest">{HONEST_COPY}</p>

    <div class="row">
      <button class="ghost" onclick={reset} data-testid="share-another">Share something else</button>
      <button onclick={onclose} data-testid="share-done">Done</button>
    </div>
  {:else}
    <h2>Share with a doctor</h2>
    <p class="muted">
      Package part of your record under a fresh key and hand over a link (or QR) that only opens
      what you picked. No account needed on their end.
    </p>

    <section class="stack">
      <h3>What to include</h3>
      <div class="dates">
        <label>
          From
          <input
            type="date"
            bind:value={fromDate}
            onchange={() => (showPreview = false)}
            data-testid="share-from"
          />
        </label>
        <label>
          To
          <input
            type="date"
            bind:value={toDate}
            onchange={() => (showPreview = false)}
            data-testid="share-to"
          />
        </label>
      </div>
      <p class="hint muted">Leave dates empty for your whole history.</p>

      <div class="chips" role="group" aria-label="Categories">
        {#each CATEGORIES as cat (cat)}
          <button
            type="button"
            class="chip {CATEGORY_META[cat].hueClass}"
            aria-pressed={selected.has(cat)}
            onclick={() => toggle(cat)}
            data-testid="share-cat-{cat}"
          >
            <span class="glyph">{CATEGORY_META[cat].glyph}</span>
            {CATEGORY_META[cat].label}
          </button>
        {/each}
      </div>
      <p class="hint muted">No category selected means every category.</p>
    </section>

    <section class="stack">
      <h3>Link expires</h3>
      <div class="seg" style:max-width="18rem">
        {#each EXPIRY_CHOICES as choice (choice.days)}
          <button
            type="button"
            aria-pressed={expiryDays === choice.days}
            onclick={() => (expiryDays = choice.days)}
            data-testid="share-expiry-{choice.days}"
          >
            {choice.label}
          </button>
        {/each}
      </div>
    </section>

    <section class="stack">
      <p class="count" data-testid="share-count">
        {filtered.length} entr{filtered.length === 1 ? 'y' : 'ies'} selected
        {#if pageCount > 0}
          <span class="muted" data-testid="share-pages"
            >· includes 📷 {pageCount} photo {pageCount === 1 ? 'page' : 'pages'}</span
          >
        {/if}
      </p>
      <button
        class="ghost"
        onclick={() => (showPreview = !showPreview)}
        data-testid="share-preview-toggle"
      >
        {showPreview ? 'Hide preview' : 'Preview what they see'}
      </button>
      {#if showPreview}
        <div class="preview" data-testid="share-preview">
          {#key filtered}
            <ClinicianSummary events={filtered} readonly />
          {/key}
        </div>
      {/if}
    </section>

    {#if error}
      <p class="error" data-testid="share-error">{error}</p>
    {/if}

    <div class="row">
      <button
        class="primary"
        disabled={busy || filtered.length === 0}
        onclick={create}
        data-testid="share-create"
      >
        Create share
      </button>
      <button class="ghost" onclick={onclose}>Cancel</button>
    </div>
    <p class="honest" data-testid="share-honest-create">{HONEST_COPY}</p>

    {#if shares.length > 0}
      <section class="stack">
        <h3>Your shares</h3>
        <ul class="share-list">
          {#each shares as record (record.token)}
            {@const status = statusLabel(record)}
            {@const link = linkFor(record)}
            <li>
              <div class="share-head">
                <span class="scope">{record.scopeDescription}</span>
                <span class="status status-{status}" data-testid="share-status-{record.token}">
                  {status}
                </span>
              </div>
              <p class="hint muted">
                Created {record.createdAt.slice(0, 10)} · expires {record.expiresAt.slice(0, 10)}
              </p>
              {#if status === 'active'}
                <div class="row">
                  {#if link}
                    <button class="ghost" onclick={() => copy(link)} data-testid="reshow-copy-{record.token}">
                      Copy link
                    </button>
                    <button
                      class="ghost"
                      onclick={() => (qrFor = qrFor === record.token ? null : record.token)}
                      data-testid="reshow-qr-{record.token}"
                    >
                      {qrFor === record.token ? 'Hide QR' : 'Show QR'}
                    </button>
                  {/if}
                  <button
                    class="danger-outline"
                    onclick={() => revoke(record.token)}
                    data-testid="revoke-{record.token}"
                  >
                    Revoke
                  </button>
                </div>
                {#if qrFor === record.token && link}
                  <!-- eslint-disable-next-line svelte/no-at-html-tags -->
                  <div class="qr small" data-testid="reshow-qr-svg-{record.token}">
                    {@html renderSVG(link, { border: 2 })}
                  </div>
                {/if}
              {/if}
            </li>
          {/each}
        </ul>
      </section>
    {/if}
  {/if}
</Sheet>

<style>
  h2 {
    margin: 0 0 var(--space-2);
  }

  h3 {
    font-size: var(--text-sm);
    color: var(--muted);
    margin: 0 0 var(--space-2);
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  section {
    margin-top: var(--space-5);
  }

  .stack {
    display: block;
  }

  .dates {
    display: flex;
    gap: var(--space-3);
  }

  .dates label {
    flex: 1;
    display: block;
    font-size: var(--text-sm);
    color: var(--muted);
  }

  .dates input {
    width: 100%;
  }

  .hint {
    font-size: var(--text-xs);
    margin: var(--space-1) 0 0;
  }

  .chips {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
    margin-top: var(--space-3);
  }

  .chip {
    display: inline-flex;
    align-items: center;
    gap: var(--space-1);
    min-height: 36px;
    padding: 0 var(--space-3);
    border: 1px solid var(--border);
    border-radius: var(--radius-full);
    background: var(--surface);
    color: var(--muted);
    font-size: var(--text-sm);
  }

  .chip[aria-pressed='true'] {
    background: var(--action-muted);
    color: var(--text);
    box-shadow: inset 0 0 0 1px var(--action);
  }

  .chip .glyph {
    /* Inherit the category hue class's color for just the glyph. */
    color: currentColor;
  }

  .count {
    font-size: var(--text-sm);
    margin: 0 0 var(--space-2);
  }

  .preview {
    margin-top: var(--space-3);
    max-height: 24rem;
    overflow-y: auto;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    padding: var(--space-3);
  }

  .qr :global(svg) {
    display: block;
    width: 100%;
    max-width: 16rem;
    height: auto;
    margin: var(--space-4) auto;
    background: #fff;
    padding: var(--space-2);
    border-radius: var(--radius-sm);
  }

  .qr.small :global(svg) {
    max-width: 11rem;
    margin: var(--space-3) auto;
  }

  .link {
    word-break: break-all;
    font-size: var(--text-xs);
    background: var(--surface);
    padding: var(--space-2);
    border-radius: var(--radius-sm);
  }

  .honest {
    font-size: var(--text-xs);
    line-height: 1.5;
    color: var(--muted);
    margin: var(--space-4) 0 0;
  }

  .row {
    display: flex;
    gap: var(--space-2);
    flex-wrap: wrap;
    margin-top: var(--space-3);
  }

  .share-list {
    list-style: none;
    padding: 0;
    margin: 0;
  }

  .share-list li {
    padding: var(--space-3) 0;
    border-top: 1px solid var(--border);
  }

  .share-head {
    display: flex;
    align-items: baseline;
    gap: var(--space-2);
  }

  .scope {
    flex: 1;
    font-size: var(--text-sm);
  }

  .status {
    font-size: var(--text-xs);
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  .status-active {
    color: var(--action);
  }

  .status-expired,
  .status-revoked {
    color: var(--muted);
  }
</style>
