<script lang="ts">
  import { onMount } from 'svelte'
  import { openPdf } from '../lib/pdf'

  let { bytes, label }: { bytes: Uint8Array; label: string } = $props()

  let column = $state<HTMLDivElement>()
  let loading = $state(true)
  let failed = $state(false)
  let downloadUrl = $state('')

  // The caption is the download name; only add .pdf when it isn't already there.
  const downloadName = $derived(
    label.toLowerCase().endsWith('.pdf') ? label : `${label || 'document'}.pdf`,
  )

  onMount(() => {
    let cancelled = false
    void (async () => {
      try {
        const pdf = await openPdf(bytes)
        if (cancelled || !column) return
        // Fit each page to the column's width; falls back to a sane default if
        // layout hasn't settled (0 width) so a page still renders legibly.
        const width = column.clientWidth || 800
        for (let n = 1; n <= pdf.numPages; n++) {
          const canvas = document.createElement('canvas')
          canvas.className = 'page'
          column.appendChild(canvas)
          await pdf.renderPage(n, canvas, width)
          if (cancelled) return
        }
        loading = false
      } catch {
        // A corrupt PDF or a failed pdf.js import: offer the raw file instead of
        // a blank screen — the bytes are intact, only in-app rendering failed.
        failed = true
        loading = false
        downloadUrl = URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'application/pdf' }))
      }
    })()
    return () => {
      cancelled = true
      if (downloadUrl) URL.revokeObjectURL(downloadUrl)
    }
  })
</script>

{#if failed}
  <div class="fallback">
    <p class="state">Couldn't display this PDF here.</p>
    <a
      class="download"
      href={downloadUrl}
      download={downloadName}
      data-testid="viewer-pdf-fallback"
    >
      Download the file
    </a>
  </div>
{:else}
  <div class="column" data-testid="viewer-pdf" bind:this={column}></div>
  {#if loading}
    <p class="muted state loading" data-testid="viewer-pdf-loading">Rendering…</p>
  {/if}
{/if}

<style>
  /* Vertical stack of page canvases; multi-page PDFs scroll within this slot,
     while the viewer's prev/next arrows still page between attachments. */
  .column {
    width: 100%;
    height: 100%;
    overflow: auto;
    -webkit-overflow-scrolling: touch;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--space-3);
    padding: var(--space-3);
  }

  .column :global(canvas.page) {
    max-width: 100%;
    height: auto;
    background: #fff;
    box-shadow: 0 1px 4px rgba(0, 0, 0, 0.4);
  }

  .fallback {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--space-4);
    padding: var(--space-6);
    text-align: center;
  }

  .state {
    padding: var(--space-6);
    text-align: center;
  }

  .loading {
    position: absolute;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
  }

  .muted {
    color: rgba(255, 255, 255, 0.7);
  }

  .download {
    display: inline-block;
    padding: var(--space-2) var(--space-4);
    border-radius: var(--radius-md);
    background: rgba(255, 255, 255, 0.14);
    color: #fff;
    text-decoration: none;
    font-size: var(--text-base);
  }

  .download:hover {
    background: rgba(255, 255, 255, 0.22);
  }
</style>
