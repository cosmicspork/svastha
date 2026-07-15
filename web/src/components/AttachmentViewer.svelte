<script lang="ts">
  import { onDestroy, onMount } from 'svelte'
  import { formatDay, formatTime, dayKey } from '../lib/time'
  import type { AttachmentRef } from '../lib/timeline'

  let {
    pages,
    caption,
    recordedIso,
    source = null,
    loadBytes,
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
    onclose: () => void
  } = $props()

  let index = $state(0)
  let zoomed = $state(false)
  let loading = $state(true)
  let failed = $state(false)
  // Object URLs by page index, minted on demand and all revoked on close.
  const urls = new Map<number, string>()
  let currentUrl = $state<string | null>(null)

  let panel = $state<HTMLDivElement>()
  const previouslyFocused = document.activeElement as HTMLElement | null

  const total = $derived(pages.length)
  const recordedDay = $derived(formatDay(dayKey(recordedIso)))
  const recordedTime = $derived(formatTime(recordedIso))

  async function show(i: number) {
    zoomed = false
    const cached = urls.get(i)
    if (cached) {
      currentUrl = cached
      loading = false
      failed = false
      return
    }
    loading = true
    failed = false
    currentUrl = null
    try {
      const bytes = await loadBytes(pages[i].sha256)
      if (!bytes) throw new Error('missing bytes')
      const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: pages[i].mime }))
      urls.set(i, url)
      // Guard against a race: only apply if the user hasn't paged away.
      if (i === index) currentUrl = url
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

<div class="viewer" role="dialog" aria-modal="true" aria-label="Paper record" tabindex="-1" bind:this={panel}>
  <div class="bar top">
    <span class="counter" data-testid="viewer-counter">
      {#if total > 1}Page {index + 1} of {total}{:else}1 page{/if}
    </span>
    <button type="button" class="close" aria-label="Close" onclick={onclose} data-testid="viewer-close">
      ×
    </button>
  </div>

  <div class="stage" data-testid="viewer-stage">
    {#if loading}
      <p class="muted state" data-testid="viewer-loading">Decrypting…</p>
    {:else if failed}
      <p class="state" data-testid="viewer-failed">This page isn't available on this device yet.</p>
    {:else if currentUrl}
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
