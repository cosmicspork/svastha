<script lang="ts">
  import { onMount } from 'svelte'
  import Sheet from './Sheet.svelte'
  import {
    readAttachmentPage,
    runBulkRead,
    type BulkPage,
    type BulkReadProgress,
    type BulkReadSummary,
  } from '../lib/bulk-read'

  let { pages, onclose }: { pages: BulkPage[]; onclose: () => void } = $props()

  let stopRequested = $state(false)
  let running = $state(true)
  let progress = $state<BulkReadProgress>({
    read: 0,
    nothingFound: 0,
    unreadable: 0,
    completed: 0,
    total: 0,
    stopped: false,
    current: null,
  })
  let summary = $state<BulkReadSummary | null>(null)
  let error = $state('')

  const pageCountCopy = $derived(
    pages.length === 1 ? "1 page hasn't been read yet." : `${pages.length} pages haven't been read yet.`,
  )
  const progressPercent = $derived(progress.total > 0 ? (progress.completed / progress.total) * 100 : 0)

  onMount(() => {
    progress = {
      read: 0,
      nothingFound: 0,
      unreadable: 0,
      completed: 0,
      total: pages.length,
      stopped: false,
      current: pages[0] ?? null,
    }
    void runBulkRead(pages, readAttachmentPage, {
      shouldStop: () => stopRequested,
      onProgress: (next) => (progress = next),
    })
      .then((next) => (summary = next))
      .catch((err) => (error = err instanceof Error ? err.message : 'Could not continue reading pages.'))
      .finally(() => (running = false))
  })

  function stopAfterCurrent(): void {
    stopRequested = true
  }

  function close(): void {
    if (running) stopAfterCurrent()
    else onclose()
  }
</script>

<Sheet onclose={close}>
  <h2>Reading your unread pages</h2>
  <p class="muted intro" data-testid="bulk-read-count">
    {pageCountCopy} Svastha works through them one at a time; every entry it drafts waits in Proposals for you.
  </p>

  <div
    class="progress"
    aria-label={`Read ${progress.completed} of ${progress.total} pages`}
    data-testid="bulk-read-progress"
  >
    <i style:width={`${progressPercent}%`}></i>
  </div>

  {#if progress.current}
    <p class="muted current" data-testid="bulk-read-current">
      Page {progress.completed + 1} of {progress.total} · {progress.current.label}
    </p>
  {/if}

  {#if running}
    <button
      type="button"
      class="tonal"
      disabled={stopRequested}
      onclick={stopAfterCurrent}
      data-testid="bulk-read-stop"
    >
      {stopRequested ? 'Stopping after this page…' : 'Stop after this page'}
    </button>
  {:else if summary}
    {#if summary.stopped}
      <p class="muted" data-testid="bulk-read-stopped">Stopped after this page.</p>
    {/if}
    <p class="summary" data-testid="bulk-read-summary">
      {summary.read} read, {summary.nothingFound} nothing-found, {summary.unreadable} unreadable.
    </p>
    <button type="button" onclick={onclose} data-testid="bulk-read-close">Close</button>
  {:else if error}
    <p class="error" data-testid="bulk-read-error">{error}</p>
    <button type="button" onclick={onclose} data-testid="bulk-read-close">Close</button>
  {/if}
</Sheet>

<style>
  .progress {
    height: 0.45rem;
    margin: var(--space-4) 0 var(--space-2);
    overflow: hidden;
    border-radius: 999px;
    background: var(--border);
  }

  .progress i {
    display: block;
    height: 100%;
    border-radius: inherit;
    background: var(--action);
    transition: width var(--duration-base);
  }

  .current,
  .summary {
    margin: 0 0 var(--space-4);
    font-size: var(--text-sm);
  }
</style>
