<script lang="ts">
  import { CATEGORY_META } from '../lib/category'
  import { formatTime } from '../lib/time'
  import type { TimelineEntry } from '../lib/timeline'
  import TagEditor from './TagEditor.svelte'

  let {
    entry,
    animate,
    delay,
    tags = [],
    hidden = false,
    editable = true,
    onTagsChanged,
    onToggleHidden,
  }: {
    entry: TimelineEntry
    /** Entrance animation runs only on the spine's first render. */
    animate: boolean
    delay: number
    /** Curation tags for this entry's primary event (see TimelineEntry's
     * `eventIds` doc comment on why only the first id is used). Empty and
     * non-editable on a read-only (shared) spine — curation is owner-only in
     * v1 (see docs/ARCHITECTURE.md). */
    tags?: string[]
    hidden?: boolean
    editable?: boolean
    onTagsChanged?: (eventId: string, tags: string[]) => void
    onToggleHidden?: (eventId: string, hidden: boolean) => void
  } = $props()

  const meta = $derived(CATEGORY_META[entry.category])
  const primaryEventId = $derived(entry.eventIds[0])
  let editingTags = $state(false)
</script>

{#if hidden}
  <!-- Collapsed, not vanished: a silently-dropped entry would look like data
       loss (or worse, hide a real symptom from the very correlation view
       this curation overlay exists for) without an obvious way back. -->
  <div class="entry hidden-row" data-testid="spine-entry-hidden">
    <span class="muted">Hidden entry</span>
    <button
      type="button"
      class="undo"
      onclick={() => onToggleHidden?.(primaryEventId, false)}
      data-testid="spine-entry-unhide"
    >
      Undo
    </button>
  </div>
{:else}
  <div
    class="entry"
    class:enter={animate}
    class:flare={entry.flare}
    style:animation-delay={animate ? `${delay}ms` : undefined}
    data-testid="spine-entry"
    data-category={entry.category}
    data-flare={entry.flare}
  >
    <span
      class="dot"
      style:background={entry.flare ? 'var(--flare)' : `var(--cat-${entry.category})`}
    ></span>
    <span class="glyph {meta.hueClass}" aria-hidden="true">{meta.glyph}</span>
    <span class="label">{entry.label}</span>
    {#each tags as tag (tag)}
      <span class="tag-chip" data-testid="spine-entry-tag">#{tag}</span>
    {/each}
    {#if entry.value}
      <span class="value data">{entry.value}</span>
    {/if}
    <span class="time muted">{formatTime(entry.effective_at)}</span>
    {#if editable}
      <button
        type="button"
        class="tag-toggle"
        aria-label="Edit tags"
        aria-expanded={editingTags}
        onclick={() => (editingTags = !editingTags)}
        data-testid="spine-entry-tag-toggle"
      >
        #
      </button>
      <button
        type="button"
        class="hide-toggle"
        aria-label="Hide entry"
        onclick={() => onToggleHidden?.(primaryEventId, true)}
        data-testid="spine-entry-hide"
      >
        ⋯
      </button>
    {/if}
  </div>
  {#if editingTags}
    <div class="tag-editor-row">
      <TagEditor
        eventId={primaryEventId}
        onChange={(next) => onTagsChanged?.(primaryEventId, next)}
      />
    </div>
  {/if}
{/if}

<style>
  .entry {
    position: relative;
    display: flex;
    align-items: baseline;
    flex-wrap: wrap;
    gap: var(--space-2);
    padding: var(--space-1) 0;
  }

  .entry.flare {
    box-shadow: inset 2px 0 0 var(--flare);
    padding-left: var(--space-2);
  }

  .hidden-row {
    align-items: center;
    padding: var(--space-1) 0;
  }

  .undo {
    min-height: auto;
    min-width: auto;
    padding: 0 var(--space-2);
    font-size: var(--text-xs);
  }

  /* Centered on the 2px rule: the spine's content sits var(--space-5) right of
     the rule's left edge, so the dot's center lands at -space-5 + 1px. */
  .dot {
    position: absolute;
    left: calc(-1 * var(--space-5) - 3px);
    top: 50%;
    transform: translateY(-50%);
    width: 8px;
    height: 8px;
    border-radius: 50%;
  }

  .glyph {
    flex: none;
    font-size: var(--text-sm);
  }

  .label {
    min-width: 0;
    overflow-wrap: anywhere;
  }

  .tag-chip {
    font-size: var(--text-xs);
    color: var(--action);
    background: var(--action-muted);
    border-radius: 999px;
    padding: 0 var(--space-2);
  }

  .value {
    white-space: nowrap;
  }

  .time {
    margin-left: auto;
    flex: none;
    font-size: var(--text-xs);
  }

  .tag-toggle,
  .hide-toggle {
    flex: none;
    min-height: auto;
    min-width: auto;
    border: none;
    background: none;
    color: var(--muted);
    padding: 0 var(--space-1);
    font-size: var(--text-sm);
  }

  .tag-editor-row {
    padding: var(--space-2) 0 var(--space-3);
  }

  @keyframes enter {
    from {
      opacity: 0;
      transform: translateY(6px);
    }
    to {
      opacity: 1;
      transform: none;
    }
  }

  /* `both` keeps delayed entries hidden until their turn. The reduced-motion
     kill-switch in base.css (`animation: none !important`) drops the whole
     animation, leaving entries statically visible. */
  .enter {
    animation: enter var(--duration-base) ease both;
  }
</style>
