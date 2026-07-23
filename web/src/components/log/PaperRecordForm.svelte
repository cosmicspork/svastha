<script lang="ts">
  import { onDestroy } from 'svelte'
  import { navigate } from '../../lib/router.svelte'
  import { toLocalIso } from '../../lib/time'
  import { logEvent } from '../../lib/events'
  import { enqueue, drain } from '../../lib/sync'
  import { downscaleToJpeg, storeAttachment, MAX_ATTACHMENT_BYTES } from '../../lib/attachments'
  import { paperRecordDrafts } from '../../lib/drafts'

  // One attachment held in memory before save: a photographed page (downscaled
  // JPEG) or a picked PDF, plus an object URL (its thumbnail for a photo, a
  // stable key + cleanup handle for a PDF) and the mime/name to store. Nothing
  // is hashed or stored until the user commits, so removing one here leaves no
  // trace.
  interface Pending {
    bytes: Uint8Array
    url: string
    mime: string
    name: string
  }

  let photos = $state<Pending[]>([])
  let caption = $state('')
  let processing = $state(false)
  let saving = $state(false)
  let error = $state('')

  // Time control, mirroring LogShell: default to now, offer an "Earlier" picker.
  let earlier = $state(false)
  let earlierValue = $state('')

  function nowLocalInput(): string {
    return toLocalIso(new Date()).slice(0, 16)
  }

  function openEarlier() {
    earlierValue = nowLocalInput()
    earlier = true
  }

  function effectiveAt(): string {
    const now = new Date()
    if (earlier && earlierValue) {
      const picked = new Date(earlierValue)
      // Clamp: the input's max is advisory, so a future-dated capture can't slip in.
      return toLocalIso(picked < now ? picked : now)
    }
    return toLocalIso(now)
  }

  const canSave = $derived(photos.length > 0 && !processing)
  const hasPdf = $derived(photos.some((p) => p.mime === 'application/pdf'))
  // >1 mixed items are "items" (a page count is wrong once a PDF is in); a
  // photos-only batch keeps "pages"; a single item is just "Save".
  const saveLabel = $derived(
    photos.length <= 1 ? 'Save' : hasPdf ? `Save ${photos.length} items` : `Save ${photos.length} pages`,
  )

  async function onFilesPicked(e: Event) {
    const input = e.currentTarget as HTMLInputElement
    const files = Array.from(input.files ?? [])
    // Clear the input so re-picking the same file fires change again.
    input.value = ''
    if (files.length === 0) return

    processing = true
    error = ''
    try {
      for (const file of files) {
        try {
          const bytes = await downscaleToJpeg(file)
          const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'image/jpeg' }))
          photos = [...photos, { bytes, url, mime: 'image/jpeg', name: file.name }]
        } catch {
          error = 'Could not read one of the photos — try again or pick another.'
        }
      }
    } finally {
      processing = false
    }
  }

  async function onPdfsPicked(e: Event) {
    const input = e.currentTarget as HTMLInputElement
    const files = Array.from(input.files ?? [])
    input.value = ''
    if (files.length === 0) return

    processing = true
    error = ''
    try {
      for (const file of files) {
        // Hard-reject at pick time: an oversize attachment can't be stored, and
        // silently dropping it at save (or letting it exceed the relay's blob
        // cap and never sync) would be invisible data loss. Skip it, keep the
        // rest. PDFs are stored raw — no downscale — so file.size is the bytes.
        if (file.size > MAX_ATTACHMENT_BYTES) {
          error =
            'That PDF is over 11 MB — too large to attach. Export a smaller version and try again.'
          continue
        }
        try {
          const bytes = new Uint8Array(await file.arrayBuffer())
          const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'application/pdf' }))
          photos = [...photos, { bytes, url, mime: 'application/pdf', name: file.name }]
        } catch {
          error = 'Could not read one of the files — try again or pick another.'
        }
      }
    } finally {
      processing = false
    }
  }

  /** Human-readable byte size for a pending PDF tile (e.g. "1.8 MB"). */
  function formatSize(bytes: number): string {
    const mb = bytes / (1024 * 1024)
    if (mb >= 1) return `${mb.toFixed(1)} MB`
    return `${Math.max(1, Math.round(bytes / 1024))} KB`
  }

  function removePhoto(index: number) {
    const [removed] = photos.splice(index, 1)
    if (removed) URL.revokeObjectURL(removed.url)
    photos = [...photos]
  }

  async function save() {
    if (!canSave || saving) return
    saving = true
    error = ''
    try {
      // Store the bytes first so a device that pulls the events can already
      // fetch their att- blobs; then enqueue those blobs (logEvent only handles
      // the ev- ones), then create the events.
      const captured = []
      for (const p of photos) captured.push(await storeAttachment(p.bytes, p.mime))
      await enqueue(captured.map((c) => `att-${c.sha256}`))
      void drain()

      await logEvent(paperRecordDrafts(captured, caption, effectiveAt()))
      navigate('#/')
    } catch (err) {
      error = err instanceof Error ? err.message : 'Could not save — try again.'
      saving = false
    }
  }

  function cancel() {
    navigate('#/')
  }

  onDestroy(() => {
    for (const p of photos) URL.revokeObjectURL(p.url)
  })
</script>

<div class="head">
  <span class="dot" style:background="var(--cat-note)"></span>
  <h1>Paper record</h1>
</div>

<p class="muted intro">
  Photograph a handout, a doctor's note, or any paper record — or attach a PDF you were sent.
  It's stored encrypted.
</p>

<div class="stack">
  <label class="pick" data-testid="paper-pick">
    <input
      type="file"
      accept="image/*"
      capture="environment"
      multiple
      onchange={onFilesPicked}
      data-testid="paper-file"
    />
    <span class="pick-face">
      <span class="pick-glyph" aria-hidden="true">📷</span>
      <span>{photos.length === 0 ? 'Take or choose photos' : 'Add more photos'}</span>
    </span>
  </label>

  <label class="pick compact" data-testid="paper-pick-pdf">
    <input
      type="file"
      accept="application/pdf"
      multiple
      onchange={onPdfsPicked}
      data-testid="paper-file-pdf"
    />
    <span class="pick-face">
      <span class="pick-glyph" aria-hidden="true">📄</span>
      <span>Add a PDF</span>
    </span>
  </label>

  {#if processing}
    <p class="muted" data-testid="paper-processing">Processing…</p>
  {/if}

  {#if photos.length > 0}
    <div class="thumbs" data-testid="paper-thumbs">
      {#each photos as photo, i (photo.url)}
        <div class="thumb">
          {#if photo.mime === 'application/pdf'}
            <div class="pdf-tile" data-testid="paper-thumb-pdf">
              <span class="pdf-glyph" aria-hidden="true">📄</span>
              <span class="pdf-name">{photo.name}</span>
              <span class="pdf-size">{formatSize(photo.bytes.length)}</span>
            </div>
          {:else}
            <img src={photo.url} alt={`Page ${i + 1}`} />
          {/if}
          <button
            type="button"
            class="remove"
            aria-label={`Remove item ${i + 1}`}
            onclick={() => removePhoto(i)}
            data-testid="paper-remove"
          >
            ×
          </button>
          <span class="page-num">{i + 1}</span>
        </div>
      {/each}
    </div>
  {/if}

  <label class="field">
    Caption
    <input
      type="text"
      bind:value={caption}
      placeholder="e.g. GI consult — Dr. Rao"
      maxlength="120"
      data-testid="paper-caption"
    />
  </label>

  <div class="when">
    {#if earlier}
      <input
        type="datetime-local"
        bind:value={earlierValue}
        max={nowLocalInput()}
        data-testid="effective-at"
      />
      <button type="button" onclick={() => (earlier = false)} data-testid="time-now">Now</button>
    {:else}
      <span class="muted">Date: today</span>
      <button type="button" onclick={openEarlier} data-testid="time-earlier">Earlier</button>
    {/if}
  </div>

  {#if error}
    <p class="error" data-testid="save-error">{error}</p>
  {/if}
</div>

<div class="action-bar">
  <div class="action-bar-inner">
    <button type="button" class="ghost" onclick={cancel} data-testid="log-cancel">Cancel</button>
    <button
      type="button"
      class="primary"
      disabled={saving || !canSave}
      onclick={save}
      data-testid="save"
    >
      {saving ? 'Saving…' : saveLabel}
    </button>
  </div>
</div>

<style>
  .head {
    display: flex;
    align-items: center;
    gap: var(--space-2);
  }

  .head h1 {
    font-size: var(--text-xl);
  }

  .dot {
    flex: none;
    width: 9px;
    height: 9px;
    border-radius: 50%;
  }

  .intro {
    margin: var(--space-2) 0 var(--space-4);
    font-size: var(--text-sm);
  }

  .stack {
    padding-bottom: 96px;
  }

  /* The file input is the whole tap target; the visible face is styled, the
     input itself is visually hidden but still covers the label for a11y. */
  .pick {
    display: block;
    cursor: pointer;
  }

  .pick input {
    position: absolute;
    width: 1px;
    height: 1px;
    opacity: 0;
    pointer-events: none;
  }

  .pick-face {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: var(--space-2);
    min-height: 88px;
    border: 1px dashed var(--border);
    border-radius: var(--radius-lg);
    background: var(--surface);
    color: var(--text);
  }

  .pick:hover .pick-face,
  .pick:focus-within .pick-face {
    border-color: var(--action);
    color: var(--action);
  }

  .pick-glyph {
    font-size: var(--text-xl);
  }

  /* The PDF picker is a secondary, lower-profile row under the camera target. */
  .pick.compact {
    margin-top: var(--space-2);
  }

  .pick.compact .pick-face {
    min-height: 48px;
    font-size: var(--text-sm);
  }

  .pdf-tile {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: var(--space-1);
    width: 100%;
    height: 100%;
    padding: var(--space-1);
    background: var(--surface);
    text-align: center;
  }

  .pdf-glyph {
    font-size: var(--text-lg);
  }

  .pdf-name {
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-family: var(--font-data);
    font-size: var(--text-xs);
    color: var(--text);
  }

  .pdf-size {
    font-family: var(--font-data);
    font-size: var(--text-xs);
    color: var(--muted);
  }

  .thumbs {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-3);
  }

  .thumb {
    position: relative;
    width: 96px;
    height: 96px;
    border-radius: var(--radius-md);
    overflow: hidden;
    border: 1px solid var(--border);
  }

  .thumb img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
  }

  .remove {
    position: absolute;
    top: 2px;
    right: 2px;
    width: 24px;
    height: 24px;
    min-width: 24px;
    min-height: 24px;
    padding: 0;
    border-radius: 50%;
    border: none;
    background: var(--scrim);
    color: #fff;
    font-size: 16px;
    line-height: 1;
    display: grid;
    place-items: center;
  }

  .page-num {
    position: absolute;
    bottom: 2px;
    left: 4px;
    font-size: var(--text-xs);
    font-family: var(--font-data);
    color: #fff;
    text-shadow: 0 1px 2px rgba(0, 0, 0, 0.7);
  }

  .when {
    display: flex;
    align-items: center;
    gap: var(--space-3);
  }

  .when input {
    width: auto;
    flex: 1;
  }

  .action-bar {
    position: fixed;
    left: 0;
    right: 0;
    bottom: 0;
    background: var(--surface);
    border-top: 1px solid var(--border);
  }

  .action-bar-inner {
    max-width: 40rem;
    margin: 0 auto;
    display: flex;
    gap: var(--space-2);
    padding: var(--space-3) var(--space-4) calc(var(--space-3) + env(safe-area-inset-bottom));
  }

  .action-bar-inner .primary {
    flex: 1;
  }
</style>
