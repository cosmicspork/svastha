<script lang="ts">
  import { onDestroy, onMount } from 'svelte'
  import { formatDay, formatTime, dayKey } from '../lib/time'
  import type { AttachmentRef } from '../lib/timeline'
  import { prettyTextForDoc } from '../lib/provenance'
  // Type-only, so naming the read flow's outcome here costs the viewer's bundle
  // nothing: neither wasm nor the inference client comes with it.
  import type { ReadNotice, ReadNoticeAction } from '../lib/read-page'
  import PdfDoc from './PdfDoc.svelte'

  /** How a page's bytes are shown: image/* inline, application/pdf via pdf.js,
   * anything else as decoded text. Keying off the stored mime keeps both call
   * sites (owner spine, share view) unchanged — dispatch lives entirely here. */
  type RenderKind = 'image' | 'pdf' | 'text'
  function renderKind(mime: string): RenderKind {
    if (mime.startsWith('image/')) return 'image'
    if (mime === 'application/pdf') return 'pdf'
    return 'text'
  }

  let {
    pages,
    caption,
    recordedIso,
    source = null,
    loadBytes,
    onread,
    notice = null,
    readPages = new Set<string>(),
    onclose,
  }: {
    pages: AttachmentRef[]
    caption: string
    recordedIso: string
    /** Provenance source, shown below the image. Null for 'self' captures. */
    source?: string | null
    /** Decrypt/fetch one page's plaintext bytes by content hash. The owner
     * reads the local `attachments` store; a share recipient reads the bundle's
     * in-memory map — the viewer doesn't care which. */
    loadBytes: (sha256: string) => Promise<Uint8Array | null>
    /** Read this page and propose what it says. Optional and opt-in: only the
     * owner's own record can be proposed into, so the share-recipient mounts
     * leave it off and the action simply isn't there. */
    onread?: (sha256: string, bytes: Uint8Array, mime: string) => Promise<void>
    /** What the last read amounted to, drawn over the stage. A read that fails
     * behind the viewer is a read that reported nothing, so every outcome
     * belongs in here — including the ones the owner can act on. */
    notice?: ReadNotice | null
    /** Pages already read on this device, by content hash: the action reads
     * "Read again" for those. */
    readPages?: Set<string>
    onclose: () => void
  } = $props()

  let reading = $state(false)

  let index = $state(0)
  let zoomed = $state(false)
  let loading = $state(true)
  let failed = $state(false)
  // Image pages cache an object URL (the <img> src); pdf/text pages cache the
  // decoded bytes instead (the renderer wants bytes, not a URL). Both are keyed
  // by page index; URLs are revoked on close.
  const urls = new Map<number, string>()
  const byteCache = new Map<number, Uint8Array>()
  let currentUrl = $state<string | null>(null)
  let currentBytes = $state<Uint8Array | null>(null)

  let panel = $state<HTMLDivElement>()
  const previouslyFocused = document.activeElement as HTMLElement | null

  const total = $derived(pages.length)
  const kind = $derived(renderKind(pages[index].mime))
  const pretty = $derived(currentBytes ? prettyTextForDoc(currentBytes, pages[index].mime) : null)
  // Tied to the page it came from, so paging away hides it and paging back
  // brings it with the page it is about.
  const shownNotice = $derived(notice?.sha256 === pages[index].sha256 ? notice : null)
  const recordedDay = $derived(formatDay(dayKey(recordedIso)))
  const recordedTime = $derived(formatTime(recordedIso))

  async function show(i: number) {
    zoomed = false
    const isImage = renderKind(pages[i].mime) === 'image'
    const cachedUrl = urls.get(i)
    const cachedBytes = byteCache.get(i)
    if (isImage ? cachedUrl : cachedBytes) {
      currentUrl = isImage ? cachedUrl! : null
      currentBytes = isImage ? null : cachedBytes!
      loading = false
      failed = false
      return
    }
    loading = true
    failed = false
    currentUrl = null
    currentBytes = null
    try {
      const bytes = await loadBytes(pages[i].sha256)
      if (!bytes) throw new Error('missing bytes')
      if (isImage) {
        const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: pages[i].mime }))
        urls.set(i, url)
        // Guard against a race: only apply if the user hasn't paged away.
        if (i === index) currentUrl = url
      } else {
        byteCache.set(i, bytes)
        if (i === index) currentBytes = bytes
      }
    } catch {
      if (i === index) failed = true
    } finally {
      if (i === index) loading = false
    }
  }

  function go(next: number) {
    if (next < 0 || next >= total) return
    index = next
    void show(index)
  }

  /** Run a notice's action with the same busy state the read action uses —
   * "Continue" and "Turn on reading" both go back to the endpoint or the
   * network, and neither should be re-entrant. */
  async function runAction(action: ReadNoticeAction) {
    reading = true
    try {
      await action.onclick()
    } finally {
      reading = false
    }
  }

  function onKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') onclose()
    else if (e.key === 'ArrowLeft') go(index - 1)
    else if (e.key === 'ArrowRight') go(index + 1)
  }

  onMount(() => {
    panel?.focus()
    void show(0)
  })

  onDestroy(() => {
    for (const url of urls.values()) URL.revokeObjectURL(url)
    previouslyFocused?.focus?.()
  })
</script>

<svelte:window onkeydown={onKeydown} />

<div class="viewer" role="dialog" aria-modal="true" aria-label="Document" tabindex="-1" bind:this={panel}>
  <div class="bar top">
    <span class="counter" data-testid="viewer-counter">
      {#if total > 1}Page {index + 1} of {total}{:else}1 page{/if}
    </span>
    <!-- Bytes are fetched on click rather than read from the cache: image pages
         keep an object URL there, not bytes, and images are exactly the pages
         this is for. One extra decrypt on an explicit action is cheap. -->
    {#if onread && !loading && !failed}
      <button
        type="button"
        class="read"
        disabled={reading}
        data-testid="viewer-read"
        onclick={async () => {
          reading = true
          try {
            const page = pages[index]
            const bytes = byteCache.get(index) ?? (await loadBytes(page.sha256))
            if (bytes) await onread(page.sha256, bytes, page.mime)
          } finally {
            reading = false
          }
        }}
      >
        {reading ? 'Reading…' : readPages.has(pages[index].sha256) ? 'Read again' : 'Read this page'}
      </button>
    {/if}
    <button type="button" class="close" aria-label="Close" onclick={onclose} data-testid="viewer-close">
      ×
    </button>
  </div>

  <div class="stage" data-testid="viewer-stage">
    {#if loading}
      <p class="muted state" data-testid="viewer-loading">Decrypting…</p>
    {:else if failed}
      <p class="state" data-testid="viewer-failed">This page isn't available on this device yet.</p>
    {:else if kind === 'image' && currentUrl}
      <div class="scroll" class:zoomed>
        <!-- Tap toggles fit/zoom; keyboard users pan via the scroll container's
             own arrow-key scrolling, and Escape/arrows are handled at the
             dialog level, so the image needs no separate key handler. -->
        <!-- svelte-ignore a11y_no_noninteractive_element_interactions, a11y_click_events_have_key_events -->
        <img
          src={currentUrl}
          alt={caption || `Page ${index + 1}`}
          class:zoomed
          onclick={() => (zoomed = !zoomed)}
          data-testid="viewer-image"
        />
      </div>
    {:else if kind === 'pdf' && currentBytes}
      <!-- Re-key on index so paging to another PDF remounts the renderer (it
           opens the document and paints its canvases in onMount). -->
      {#key index}
        <PdfDoc bytes={currentBytes} label={caption || 'Document'} />
      {/key}
    {:else if kind === 'text' && pretty}
      <div class="text-wrap">
        {#if pretty.truncated}
          <p class="truncated-notice" data-testid="viewer-truncated">
            Showing the first part of this large document.
          </p>
        {/if}
        <pre class="text" data-testid="viewer-text">{pretty.text}</pre>
      </div>
    {/if}

    {#if total > 1}
      <button
        type="button"
        class="nav prev"
        aria-label="Previous page"
        disabled={index === 0}
        onclick={() => go(index - 1)}
        data-testid="viewer-prev"
      >
        ‹
      </button>
      <button
        type="button"
        class="nav next"
        aria-label="Next page"
        disabled={index === total - 1}
        onclick={() => go(index + 1)}
        data-testid="viewer-next"
      >
        ›
      </button>
    {/if}

    {#if shownNotice}
      <div
        class="notice"
        class:error={shownNotice.tone === 'error'}
        role="status"
        data-testid="read-notice"
      >
        <p class="notice-text" data-testid="read-notice-text">{shownNotice.text}</p>
        {#if shownNotice.detail}
          <p class="notice-detail" data-testid="read-notice-detail">{shownNotice.detail}</p>
        {/if}
        {#if shownNotice.actions.length > 0}
          <div class="notice-actions">
            {#each shownNotice.actions as action (action.label)}
              <button
                type="button"
                class={action.kind}
                disabled={reading}
                onclick={() => runAction(action)}
                data-testid="read-notice-action"
              >
                {action.label}
              </button>
            {/each}
          </div>
        {/if}
      </div>
    {/if}
  </div>

  <div class="meta" data-testid="viewer-meta">
    {#if caption}<p class="caption">{caption}</p>{/if}
    <p class="muted line">
      {recordedDay}{#if recordedTime}, {recordedTime}{/if}
      {#if source && source !== 'self'} · {source}{/if}
    </p>
  </div>
</div>

<style>
  .viewer {
    position: fixed;
    inset: 0;
    z-index: 200;
    display: flex;
    flex-direction: column;
    background: #000;
    color: #fff;
  }

  .bar {
    flex: none;
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: calc(var(--space-2) + env(safe-area-inset-top)) var(--space-4) var(--space-2);
  }

  .read {
    margin-left: auto;
    margin-right: var(--space-3);
    font-size: var(--text-sm);
  }

  .counter {
    font-size: var(--text-sm);
    font-family: var(--font-data);
    color: rgba(255, 255, 255, 0.8);
  }

  .close {
    width: 40px;
    height: 40px;
    min-width: 40px;
    border: none;
    border-radius: 50%;
    background: rgba(255, 255, 255, 0.12);
    color: #fff;
    font-size: 24px;
    line-height: 1;
    display: grid;
    place-items: center;
  }

  .stage {
    position: relative;
    flex: 1;
    min-height: 0;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  /* Native scroll IS the pan gesture. Fit-to-width by default; tapping the image
     switches to natural size so the container scrolls in both axes. */
  .scroll {
    width: 100%;
    height: 100%;
    display: flex;
    align-items: center;
    justify-content: center;
    overflow: auto;
    -webkit-overflow-scrolling: touch;
  }

  .scroll.zoomed {
    align-items: start;
    justify-content: start;
  }

  img {
    max-width: 100%;
    max-height: 100%;
    object-fit: contain;
    cursor: zoom-in;
  }

  img.zoomed {
    max-width: none;
    max-height: none;
    width: auto;
    cursor: zoom-out;
  }

  .text-wrap {
    width: 100%;
    height: 100%;
    display: flex;
    flex-direction: column;
    min-height: 0;
  }

  /* Hardcoded, not a --flare token: the viewer's chrome (.viewer above) is
     always dark regardless of the app theme, so this stays legible against
     the fixed black stage instead of tracking light-dark(). */
  .truncated-notice {
    flex: none;
    margin: 0;
    padding: var(--space-2) var(--space-4);
    font-size: var(--text-xs);
    color: #e0a84a;
    background: rgba(255, 255, 255, 0.06);
  }

  .text {
    flex: 1;
    min-height: 0;
    width: 100%;
    margin: 0;
    padding: var(--space-4);
    overflow: auto;
    -webkit-overflow-scrolling: touch;
    font-family: var(--font-data);
    font-size: var(--text-sm);
    line-height: 1.5;
    white-space: pre-wrap;
    word-break: break-word;
  }

  .state {
    padding: var(--space-6);
    text-align: center;
  }

  .muted {
    color: rgba(255, 255, 255, 0.7);
  }

  .nav {
    position: absolute;
    top: 50%;
    transform: translateY(-50%);
    width: 44px;
    height: 44px;
    min-width: 44px;
    border: none;
    border-radius: 50%;
    background: rgba(255, 255, 255, 0.12);
    color: #fff;
    font-size: 28px;
    line-height: 1;
    display: grid;
    place-items: center;
  }

  .nav:disabled {
    opacity: 0.3;
  }

  .nav.prev {
    left: var(--space-3);
  }

  .nav.next {
    right: var(--space-3);
  }

  /* An app-surface card floating over the black stage, just above the meta
     band: the outcome of reading a page belongs on top of the page it was read
     from, not on the screen underneath the viewer. Its own tokens rather than
     the viewer's white-on-black, so it reads as the app speaking. */
  .notice {
    position: absolute;
    left: var(--space-4);
    right: var(--space-4);
    bottom: var(--space-3);
    padding: var(--space-3);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    background: var(--surface);
    color: var(--text);
    box-shadow: var(--shadow-2);
  }

  .notice.error {
    border-color: var(--danger);
  }

  .notice-text {
    margin: 0;
    font-size: var(--text-sm);
    color: var(--action);
  }

  .notice.error .notice-text {
    color: var(--danger);
  }

  .notice-detail {
    margin: var(--space-1) 0 0;
    font-size: var(--text-xs);
    color: var(--muted);
  }

  .notice-actions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-3);
    margin-top: var(--space-3);
  }

  .notice-actions button {
    min-height: 38px;
    padding: var(--space-1) var(--space-3);
    font-size: var(--text-sm);
  }

  .meta {
    flex: none;
    padding: var(--space-3) var(--space-4) calc(var(--space-4) + env(safe-area-inset-bottom));
  }

  .caption {
    margin: 0 0 var(--space-1);
    font-size: var(--text-base);
  }

  .line {
    margin: 0;
    font-size: var(--text-sm);
  }
</style>
