<script lang="ts">
  import type { Snippet } from 'svelte'
  import type { Code } from '../lib/codes'
  import type { EventKind } from '../lib/drafts'
  import type { Category } from '../lib/category'
  import { shortenSystem } from '../lib/codes'
  import { formatTime, formatDay, dayKey } from '../lib/time'
  import { friendlySource } from '../lib/provenance'

  // One event's provenance/coding panel, shared by the timeline entry (SpineEntry)
  // and the search hit so both read identically. The timeline passes its grouped
  // notes through `children`, rendered inside the same panel below the metadata.
  let {
    effectiveAt,
    kind,
    code = null,
    value = '',
    source = '',
    sourceDoc = null,
    category,
    id = undefined,
    testid = 'event-detail',
    onOpenSourceDoc = undefined,
    children = undefined,
  }: {
    effectiveAt: string | null
    kind: EventKind
    code?: Code | null
    value?: string
    source?: string
    sourceDoc?: string | null
    category: Category
    id?: string
    testid?: string
    onOpenSourceDoc?: () => void
    children?: Snippet
  } = $props()

  const recordedDay = $derived(effectiveAt ? formatDay(dayKey(effectiveAt)) : '')
  const recordedTime = $derived(effectiveAt ? formatTime(effectiveAt) : '')
  const humanKind = $derived(kind.replace(/_/g, ' '))
  const source_ = $derived(friendlySource(source))

  // First 8 + last 4 hex: enough to eyeball-match a document sha without
  // printing the full 64 chars inline.
  function shortenSha(sha: string): string {
    return sha.length <= 14 ? sha : `${sha.slice(0, 8)}…${sha.slice(-4)}`
  }
</script>

<dl
  {id}
  class="detail"
  style:border-left-color={`var(--cat-${category})`}
  data-testid={testid}
>
  <div class="row">
    <dt>Recorded</dt>
    <dd>
      {#if recordedDay}
        {recordedDay}{#if recordedTime}, {recordedTime}{:else}
          <em class="muted">no time in source</em>{/if}
      {:else}
        <em class="muted">no date in source</em>
      {/if}
    </dd>
  </div>
  <div class="row">
    <dt>Kind</dt>
    <dd>{humanKind}</dd>
  </div>
  {#if code}
    <div class="row">
      <dt>Code</dt>
      <dd class="code data">
        {shortenSystem(code.system)}
        {code.code}
        {#if code.display}{code.display}{:else}<em class="muted">no display name in source</em>{/if}
      </dd>
    </div>
  {/if}
  {#if value}
    <div class="row">
      <dt>Result</dt>
      <dd class="data">{value}</dd>
    </div>
  {/if}
  <div class="row">
    <dt>Source</dt>
    <dd>{source_}</dd>
  </div>
  {#if sourceDoc}
    <div class="row">
      <dt>Document</dt>
      {#if onOpenSourceDoc}
        <dd class="doc-cell">
          <button
            type="button"
            class="source-doc tonal"
            onclick={onOpenSourceDoc}
            data-testid="spine-entry-source-doc"
          >
            View source document
          </button>
          <span class="doc data muted">{shortenSha(sourceDoc)}</span>
        </dd>
      {:else}
        <dd class="doc data">{sourceDoc}</dd>
      {/if}
    </div>
  {/if}
  {@render children?.()}
</dl>

<style>
  .detail {
    margin: var(--space-1) 0 var(--space-3);
    padding: var(--space-3);
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    background: color-mix(in srgb, var(--surface) 55%, var(--bg));
    border: 1px solid var(--border);
    /* left rule is the category hue (color set inline); the widened side only */
    border-left-width: 2px;
    border-radius: 0 var(--radius-lg) var(--radius-lg) 0;
    font-family: var(--font-body);
  }

  .row {
    display: flex;
    gap: var(--space-3);
  }

  .detail dt {
    flex: none;
    width: 6rem;
    font-size: var(--text-xs);
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--muted);
  }

  .detail dd {
    margin: 0;
    min-width: 0;
    overflow-wrap: anywhere;
  }

  .doc-cell {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: var(--space-1);
  }

  .source-doc {
    min-height: auto;
    min-width: auto;
    padding: var(--space-1) var(--space-3);
    color: var(--action);
    font-size: var(--text-sm);
  }

  .detail .data {
    font-size: var(--text-sm);
  }
</style>
