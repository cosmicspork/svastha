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
    onOpenViewer,
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
    /** Open the full-screen viewer for a captured paper record. Supplied by
     * both the owner spine and the read-only share view. */
    onOpenViewer?: (entry: TimelineEntry) => void
  } = $props()

  const meta = $derived(CATEGORY_META[entry.category])
  const primaryEventId = $derived(entry.eventIds[0])
  // A captured paper record: the row opens the viewer instead of the inline
  // detail stub (there's a photo to look at, not a coding to read).
  const isPaper = $derived((entry.attachments?.length ?? 0) > 0)
  let editingTags = $state(false)

  // The inline provenance panel is available in both modes (a share recipient
  // wants exactly this), unlike tags/hide which stay owner-only.
  let expanded = $state(false)

  // Which of this entry's notes (an encounter's folded visit notes, or a
  // standalone note's own prose) are expanded past the clamped preview.
  let expandedNotes = $state<Set<number>>(new Set())
  function toggleNote(i: number): void {
    const next = new Set(expandedNotes)
    if (next.has(i)) next.delete(i)
    else next.add(i)
    expandedNotes = next
  }
  // A note gets a Read more toggle when the clamped 3-line preview could hide
  // content: multi-paragraph prose, or a long single run.
  function isLongNote(text: string): boolean {
    return text.split('\n').length > 3 || text.length > 200
  }
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
      aria-expanded={isPaper ? undefined : expanded}
      aria-controls={isPaper ? undefined : stubId}
      aria-haspopup={isPaper ? 'dialog' : undefined}
      onclick={() => (isPaper ? onOpenViewer?.(entry) : (expanded = !expanded))}
      data-testid="spine-entry-trigger"
    >
      <span class="row-main">
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
      </span>
      <span class="trail">
        {#if recordedTime}
          <span class="time muted">{recordedTime}</span>
        {/if}
        <span class="chevron" class:open={expanded} aria-hidden="true">›</span>
      </span>
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
        {#each entry.notes as note, i (note.eventIds[0])}
          <div class="note" data-testid="spine-entry-note">
            <p class="note-title">{note.label}</p>
            <p class="note-body" class:clamped={!expandedNotes.has(i)}>{note.text}</p>
            {#if isLongNote(note.text)}
              <button
                type="button"
                class="read-more"
                onclick={() => toggleNote(i)}
                data-testid="spine-entry-note-readmore"
              >
                {expandedNotes.has(i) ? 'Read less' : 'Read more'}
              </button>
            {/if}
          </div>
        {/each}
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

  /* The trigger resets the global button chrome; the 44px min-height is the
     touch target. Content that wraps lives in .row-main; .trail (time +
     chevron) is a non-wrapping cluster centered on the row so the chevron
     lines up with the #/⋯ actions no matter how many lines the text takes. */
  .row-trigger {
    flex: 1;
    min-width: 0;
    min-height: 44px;
    display: flex;
    align-items: center;
    gap: var(--space-2);
    padding: var(--space-1) 0;
    border: none;
    background: none;
    color: inherit;
    text-align: left;
  }

  .row-main {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: baseline;
    flex-wrap: wrap;
    gap: var(--space-2);
  }

  .trail {
    flex: none;
    display: flex;
    align-items: center;
    gap: var(--space-2);
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

  /* A folded visit note (or a standalone note's own prose): a full-width block,
     unlike the dt/dd metadata rows above it. */
  .note {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    padding-top: var(--space-1);
    border-top: 1px solid var(--border);
  }

  .note-title {
    margin: 0;
    font-size: var(--text-xs);
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--muted);
  }

  .note-body {
    margin: 0;
    /* Prose keeps its paragraph breaks (the importer preserves them). */
    white-space: pre-line;
    overflow-wrap: anywhere;
  }

  /* Collapsed preview: a few lines, the rest behind Read more. The reduced-
     motion kill-switch doesn't touch this — it's a clamp, not an animation. */
  .note-body.clamped {
    display: -webkit-box;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 3;
    line-clamp: 3;
    overflow: hidden;
  }

  .read-more {
    align-self: flex-start;
    min-height: auto;
    min-width: auto;
    padding: 0;
    border: none;
    background: none;
    color: var(--action);
    font-size: var(--text-xs);
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
