<script lang="ts">
  import { CATEGORY_META } from '../lib/category'
  import { shortenSystem } from '../lib/codes'
  import { formatTime, formatDay, dayKey } from '../lib/time'
  import type { TimelineEntry } from '../lib/timeline'
  import Menu, { type MenuItem } from './Menu.svelte'
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

  // The inline provenance panel is available in both modes (a share recipient
  // wants exactly this), unlike tags/hide which stay owner-only.
  let expanded = $state(false)
  const stubId = $derived(`stub-${primaryEventId}`)
  const detail = $derived(entry.detail)
  const humanKind = $derived(detail.kind.replace(/_/g, ' '))
  const recordedDay = $derived(formatDay(dayKey(entry.effective_at)))
  const recordedTime = $derived(formatTime(entry.effective_at))

  // The overflow menu: a discoverable, screen-reader-friendly second entry
  // point to the same detail/tag toggles the row and `#` button own, with the
  // destructive hide demoted behind an explicit label.
  const actions = $derived<MenuItem[]>([
    { label: expanded ? 'Hide details' : 'View details', onSelect: () => (expanded = !expanded) },
    { label: 'Edit tags', onSelect: () => (editingTags = !editingTags) },
    {
      label: 'Hide entry',
      danger: true,
      separatorBefore: true,
      onSelect: () => onToggleHidden?.(primaryEventId, true),
    },
  ])
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
    <!-- The whole row toggles the detail panel. The tag/hide controls stay
         siblings (below), never nested, so a tap on them can't also be a tap
         on this button. -->
    <button
      type="button"
      class="row-trigger"
      aria-expanded={expanded}
      aria-controls={stubId}
      onclick={() => (expanded = !expanded)}
      data-testid="spine-entry-trigger"
    >
      <span class="glyph {meta.hueClass}" aria-hidden="true">{meta.glyph}</span>
      <span class="label">{entry.label}</span>
      {#each tags as tag (tag)}
        <span class="tag-chip" data-testid="spine-entry-tag">#{tag}</span>
      {/each}
      {#if entry.hint}
        <span class="hint muted" data-testid="spine-entry-hint">{entry.hint}</span>
      {/if}
      {#if entry.value}
        <span class="value data">{entry.value}</span>
      {/if}
      <span class="time muted">{recordedTime}</span>
      <span class="chevron" class:open={expanded} aria-hidden="true">›</span>
    </button>
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
      <Menu label="Entry actions" items={actions} triggerTestId="spine-entry-menu">
        {#snippet trigger()}⋯{/snippet}
      </Menu>
    {/if}
  </div>
  <!-- Always in the DOM (so aria-controls resolves and the grid-rows expand
       animates); collapsed to 0fr until open. -->
  <div class="stub-wrap" class:open={expanded}>
    <div class="stub-inner">
      <dl
        id={stubId}
        class="stub"
        style:border-left-color={`var(--cat-${entry.category})`}
        data-testid="spine-entry-stub"
      >
        <div class="stub-row">
          <dt>Recorded</dt>
          <dd>
            {recordedDay}{#if recordedTime}, {recordedTime}{:else}
              <em class="muted">no time in source</em>{/if}
          </dd>
        </div>
        <div class="stub-row">
          <dt>Kind</dt>
          <dd>{humanKind}</dd>
        </div>
        {#if detail.code}
          <div class="stub-row">
            <dt>Code</dt>
            <dd class="code data">
              {shortenSystem(detail.code.system)}
              {detail.code.code}
              {#if detail.code.display}{detail.code.display}{:else}<em class="muted"
                  >no display name in source</em
                >{/if}
            </dd>
          </div>
        {/if}
        {#if entry.value}
          <div class="stub-row">
            <dt>Result</dt>
            <dd class="data">{entry.value}</dd>
          </div>
        {/if}
        {#if detail.source}
          <div class="stub-row">
            <dt>Source</dt>
            <dd>{detail.source}</dd>
          </div>
        {/if}
        {#if detail.sourceDoc}
          <div class="stub-row">
            <dt>Document</dt>
            <dd class="doc data">{detail.sourceDoc}</dd>
          </div>
        {/if}
      </dl>
    </div>
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
    align-items: center;
    gap: var(--space-1);
  }

  .entry.flare {
    box-shadow: inset 2px 0 0 var(--flare);
    padding-left: var(--space-2);
  }

  /* The trigger carries the old row layout (baseline-aligned, wrapping) and
     resets the global button chrome; the 44px min-height is the touch target. */
  .row-trigger {
    flex: 1;
    min-width: 0;
    min-height: 44px;
    display: flex;
    align-items: baseline;
    flex-wrap: wrap;
    gap: var(--space-2);
    padding: var(--space-1) 0;
    border: none;
    background: none;
    color: inherit;
    text-align: left;
  }

  .hint {
    flex: none;
    font-size: var(--text-xs);
  }

  .chevron {
    flex: none;
    color: var(--muted);
    font-size: var(--text-sm);
    line-height: 1;
    transition: transform var(--duration-base) ease;
  }

  .chevron.open {
    transform: rotate(90deg);
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

  /* Values are often free text (mood notes, gratitude, joined vitals), so they
     must wrap. min-width:0 lets the flex item shrink below its content width;
     word-break:normal overrides .data's break-all so wrapping falls on spaces
     first, with overflow-wrap catching any single unbreakable token. */
  .value {
    min-width: 0;
    word-break: normal;
    overflow-wrap: anywhere;
  }

  .time {
    margin-left: auto;
    flex: none;
    font-size: var(--text-xs);
  }

  .tag-toggle {
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

  /* Height-only expand: animating grid-template-rows 0fr->1fr needs no fixed
     height. The base.css reduced-motion kill-switch drops the transition. */
  .stub-wrap {
    display: grid;
    grid-template-rows: 0fr;
    transition: grid-template-rows var(--duration-base) ease;
  }

  .stub-wrap.open {
    grid-template-rows: 1fr;
  }

  .stub-inner {
    min-height: 0;
    overflow: hidden;
  }

  .stub {
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

  .stub-row {
    display: flex;
    gap: var(--space-3);
  }

  .stub dt {
    flex: none;
    width: 6rem;
    font-size: var(--text-xs);
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--muted);
  }

  .stub dd {
    margin: 0;
    min-width: 0;
    overflow-wrap: anywhere;
  }

  .stub .data {
    font-size: var(--text-sm);
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
