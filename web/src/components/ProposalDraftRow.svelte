<script lang="ts">
  import { describeEvent } from '../lib/timeline'
  import { toLocalIso, formatTime, dayKey, formatDay } from '../lib/time'
  import { getAttachment, attachmentBytes } from '../lib/attachments'
  import { getProvenance, provenanceBytes, mimeForDocName } from '../lib/provenance'
  import type { AttachmentRef } from '../lib/timeline'
  import type { ApprovableContent } from '../lib/events'
  import type { ProposalDraft } from '../lib/proposals'
  import AttachmentViewer from './AttachmentViewer.svelte'

  let {
    draft,
    dictionary = new Map<string, string>(),
    onApprove,
    onReject,
    busy = false,
  }: {
    draft: ProposalDraft
    dictionary?: Map<string, string>
    /** Sign + append the (possibly edited) content, stamping `proposed`. */
    onApprove: (content: ApprovableContent) => Promise<void>
    onReject: () => Promise<void>
    busy?: boolean
  } = $props()

  const fact = $derived(describeEvent(draft.event, dictionary))
  const day = $derived(draft.event.effective_at ? formatDay(dayKey(draft.event.effective_at)) : '')
  const time = $derived(draft.event.effective_at ? formatTime(draft.event.effective_at) : '')

  // The proposer's extraction context (method + model), shown so the owner can
  // weigh the draft — e.g. an OCR pass with a named vision model.
  const method = $derived(draft.method)
  const model = $derived(draft.model)

  // --- edit-then-approve: a focused editor for the fields an OCR correction
  // actually touches — the value (text or a measured quantity) and the date.
  // Coded/attachment values aren't editable inline; approve as-is or reject.
  let editing = $state(false)
  let editText = $state('')
  let editDate = $state('')

  type EditableValue = { kind: 'text' } | { kind: 'quantity' } | { kind: 'none' }
  const editable = $derived<EditableValue>(
    draft.event.value && 'text' in draft.event.value
      ? { kind: 'text' }
      : draft.event.value && 'quantity' in draft.event.value
        ? { kind: 'quantity' }
        : { kind: 'none' },
  )

  function startEdit(): void {
    const v = draft.event.value
    editText = v && 'text' in v ? v.text : v && 'quantity' in v ? v.quantity.value : ''
    editDate = draft.event.effective_at ? draft.event.effective_at.slice(0, 16) : ''
    editing = true
  }

  /** The content to sign: the draft's own fields, with the editor's overrides
   * applied. Provenance is the draft's (the proposer's), preserved. */
  function editedContent(): ApprovableContent {
    const base: ApprovableContent = {
      kind: draft.event.kind,
      code: draft.event.code,
      effective_at: editDate ? toLocalIso(new Date(editDate)) : draft.event.effective_at,
      value: draft.event.value,
      provenance: draft.event.provenance,
    }
    const v = draft.event.value
    if (v && 'text' in v) base.value = { text: editText }
    else if (v && 'quantity' in v) base.value = { quantity: { ...v.quantity, value: editText } }
    return base
  }

  function asIs(): ApprovableContent {
    return {
      kind: draft.event.kind,
      code: draft.event.code,
      effective_at: draft.event.effective_at,
      value: draft.event.value,
      provenance: draft.event.provenance,
    }
  }

  async function approveEdited(): Promise<void> {
    await onApprove(editedContent())
    editing = false
  }

  // --- source blob viewer: the att-/doc- page the extraction drew from ---
  let viewerPages = $state<AttachmentRef[] | null>(null)
  let viewerLoad = $state<((sha256: string) => Promise<Uint8Array | null>) | null>(null)
  let sourceError = $state('')

  async function openSource(): Promise<void> {
    sourceError = ''
    const blob = draft.source_blob
    if (!blob) return
    if (blob.startsWith('att-')) {
      const sha = blob.slice('att-'.length)
      const rec = await getAttachment(sha)
      if (!rec) {
        sourceError = "The source page isn't on this device yet."
        return
      }
      viewerPages = [{ sha256: sha, mime: rec.mime }]
      viewerLoad = attachmentBytes
    } else if (blob.startsWith('doc-')) {
      const sha = blob.slice('doc-'.length)
      const rec = await getProvenance(sha)
      if (!rec) {
        sourceError = "The source document isn't on this device yet."
        return
      }
      viewerPages = [{ sha256: sha, mime: mimeForDocName(rec.name) }]
      viewerLoad = provenanceBytes
    } else {
      sourceError = 'Unrecognized source reference.'
    }
  }

  function closeViewer(): void {
    viewerPages = null
    viewerLoad = null
  }
</script>

<div class="draft" class:resolved={draft.status !== 'pending'} data-testid="proposal-draft">
  <div class="fact">
    <span class="label" data-testid="draft-label">{fact.label}</span>
    {#if fact.value}<span class="value" data-testid="draft-value">{fact.value}</span>{/if}
    {#if fact.hint}<span class="hint muted">{fact.hint}</span>{/if}
  </div>

  <p class="prov muted" data-testid="draft-provenance">
    {#if day}{day}{#if time}, {time}{/if}{/if}
    {#if method}{day ? ' · ' : ''}{method}{/if}
    {#if model} · {model}{/if}
    {#if draft.source_blob}
      · <button class="link" onclick={openSource} data-testid="draft-view-source">View source</button>
    {/if}
  </p>
  {#if sourceError}<p class="err" data-testid="draft-source-error">{sourceError}</p>{/if}

  {#if draft.status === 'approved'}
    <p class="decided approved" data-testid="draft-decided">Approved</p>
  {:else if draft.status === 'rejected'}
    <p class="decided rejected" data-testid="draft-decided">Rejected</p>
  {:else if editing}
    <div class="editor" data-testid="draft-editor">
      {#if editable.kind !== 'none'}
        <label class="field">
          <span class="flabel muted">Value</span>
          <input type="text" bind:value={editText} data-testid="draft-edit-value" />
        </label>
      {/if}
      <label class="field">
        <span class="flabel muted">When</span>
        <input type="datetime-local" bind:value={editDate} data-testid="draft-edit-date" />
      </label>
      <div class="row">
        <button class="primary" disabled={busy} onclick={approveEdited} data-testid="draft-save-approve">
          Save & approve
        </button>
        <button disabled={busy} onclick={() => (editing = false)} data-testid="draft-edit-cancel">
          Cancel
        </button>
      </div>
    </div>
  {:else}
    <div class="row">
      <button class="primary" disabled={busy} onclick={() => onApprove(asIs())} data-testid="draft-approve">
        Approve
      </button>
      <button disabled={busy} onclick={startEdit} data-testid="draft-edit">Edit</button>
      <button class="danger" disabled={busy} onclick={onReject} data-testid="draft-reject">Reject</button>
    </div>
  {/if}
</div>

{#if viewerPages && viewerLoad}
  <AttachmentViewer
    pages={viewerPages}
    caption={fact.label}
    recordedIso={draft.event.effective_at ?? ''}
    loadBytes={viewerLoad}
    onclose={closeViewer}
  />
{/if}

<style>
  .draft {
    padding: var(--space-3) 0;
    border-top: 1px solid var(--border);
  }

  .draft.resolved {
    opacity: 0.6;
  }

  .fact {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: var(--space-2);
  }

  .label {
    font-size: var(--text-base);
  }

  .value {
    font-family: var(--font-data);
    font-size: var(--text-sm);
  }

  .hint {
    font-size: var(--text-xs);
  }

  .prov {
    margin: var(--space-1) 0 var(--space-2);
    font-size: var(--text-xs);
  }

  .err {
    margin: 0 0 var(--space-2);
    font-size: var(--text-xs);
    color: var(--danger);
  }

  .decided {
    margin: 0;
    font-size: var(--text-sm);
    font-weight: 600;
  }

  .decided.approved {
    color: var(--action);
  }

  .decided.rejected {
    color: var(--muted);
  }

  .editor {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }

  .field {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
  }

  .flabel {
    font-size: var(--text-xs);
  }

  .field input {
    padding: var(--space-2);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--surface);
    color: var(--text);
    font: inherit;
  }

  .row {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
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

  button.danger {
    color: var(--danger);
  }
</style>
