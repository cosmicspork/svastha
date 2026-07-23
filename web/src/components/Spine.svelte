<script lang="ts">
  import { onMount } from 'svelte'
  import { get, put } from '../lib/db'
  import { allEvents, type StoredEvent } from '../lib/events'
  import { buildTimeline, categoriesPresent } from '../lib/timeline'
  import { loadDictionaryIndex, dictionaryStatus } from '../lib/dictionary'
  import { CATEGORIES, CATEGORY_META, categorize, type Category } from '../lib/category'
  import { allCurationByPrefix, allTags, setHidden } from '../lib/curation'
  import { attachmentBytes } from '../lib/attachments'
  import { getProvenance, provenanceBytes, mimeForDocName } from '../lib/provenance'
  import type { AttachmentRef, TimelineEntry } from '../lib/timeline'
  import SpineEntry from './SpineEntry.svelte'
  import AttachmentViewer from './AttachmentViewer.svelte'
  import TagChips from './TagChips.svelte'
  import { focusedEventId } from '../lib/spine-focus'

  // `readonly` (the person screen, over a share's cached events) supplies its
  // own already-loaded `events` and skips the own-vault fetch, the shared
  // `spine-filter` pref, and all curation reads/writes — a shared timeline's
  // filter shouldn't clobber (or be clobbered by) the owner's own spine, and
  // curation is owner-only in v1 (see docs/ARCHITECTURE.md, "Sync and
  // backup" — shared pulls never fetch `cur-*`).
  let {
    hue,
    events: providedEvents,
    readonly = false,
  }: { hue: 'a' | 'b'; events?: StoredEvent[]; readonly?: boolean } = $props()

  let ownEvents = $state<StoredEvent[]>([])
  const events = $derived(readonly ? (providedEvents ?? []) : ownEvents)
  let loaded = $state(false)
  let filter = $state<Category | 'all'>('all')
  // Day-group cap, not a scroll virtualizer: a couple logging many times a day
  // accumulates thousands of rows in a year, and rendering them all at once
  // makes first paint (and the entrance stagger) crawl. 60 days covers "what's
  // been going on lately"; older history is one tap away.
  let visibleDays = $state(60)
  let animate = $state(true)

  // The paper-record entry whose viewer is open, or null. Both the owner spine
  // and the read-only (household) spine load bytes from the local `attachments`
  // store — the household pull mirrors att- blobs into it too (see shared.ts).
  let viewerEntry = $state<TimelineEntry | null>(null)

  // The imported source document whose viewer is open, or null. Distinct from
  // `viewerEntry` (a paper-record capture): this reads the local `provenance`
  // store, not `attachments`, and its caption/recordedIso come from the
  // provenance record rather than the entry.
  interface SourceDocViewer {
    page: AttachmentRef
    caption: string
    recordedIso: string
  }
  let sourceDocViewer = $state<SourceDocViewer | null>(null)

  async function openSourceDoc(entry: TimelineEntry): Promise<void> {
    const sha256 = entry.detail.sourceDoc
    if (!sha256) return
    const record = await getProvenance(sha256)
    sourceDocViewer = {
      page: { sha256, mime: record ? mimeForDocName(record.name) : 'text/plain' },
      caption: record?.name ?? 'Source document',
      recordedIso: record?.importedAt ?? entry.effective_at,
    }
  }

  let tagsByEvent = $state<Map<string, string[]>>(new Map())
  let hiddenEvents = $state<Set<string>>(new Set())
  let allTagsList = $state<string[]>([])
  let selectedTags = $state<Set<string>>(new Set())

  // The offline code dictionary (see lib/dictionary.ts): empty unless the user
  // turned it on. Hydrated once (module-cached) and re-hydrated when the
  // Settings toggle bumps the status version, so labels don't rebuild the Map.
  let dictionary = $state<Map<string, string>>(new Map())
  $effect(() => {
    void $dictionaryStatus.version
    void $dictionaryStatus.enabled
    void loadDictionaryIndex().then((d) => (dictionary = d))
  })

  const days = $derived(buildTimeline(events, filter, dictionary))
  const filteredDays = $derived.by(() => {
    if (selectedTags.size === 0) return days
    return days
      .map((day) => ({
        ...day,
        entries: day.entries.filter((e) =>
          e.eventIds.some((id) => (tagsByEvent.get(id) ?? []).some((t) => selectedTags.has(t))),
        ),
      }))
      .filter((day) => day.entries.length > 0)
  })
  const shown = $derived(filteredDays.slice(0, visibleDays))
  const present = $derived(new Set(categoriesPresent(events)))
  const filterChips = $derived(CATEGORIES.filter((c) => present.has(c)))

  // Deep-link focus: a citation on the ask screen targets one of the owner's
  // events. Only the own-record spine honors it (a citation always points into
  // the owner's own log). Drop the category filter to 'all' if it would hide the
  // target, then let the matching SpineEntry scroll+pulse; clear after it lands.
  const highlightId = $derived(readonly ? null : $focusedEventId)
  $effect(() => {
    const id = highlightId
    if (id === null) return
    if (
      filter !== 'all' &&
      !events.some((e) => e.event.id === id && categorize(e.event) === filter)
    ) {
      filter = 'all'
    }
    const timer = setTimeout(() => focusedEventId.set(null), 4000)
    return () => clearTimeout(timer)
  })

  // Per-entry animation delays, staggered across days: ~20ms apiece, capped so
  // a full screen never takes more than 250ms to settle.
  const dayOffsets = $derived.by(() => {
    const offsets: number[] = []
    let total = 0
    for (const day of shown) {
      offsets.push(total)
      total += day.entries.length
    }
    return offsets
  })

  async function loadCuration() {
    const [tagRecords, hideRecords, tags] = await Promise.all([
      allCurationByPrefix('tag:'),
      allCurationByPrefix('hide:'),
      allTags(),
    ])
    tagsByEvent = new Map(
      tagRecords.map((r) => [
        r.key.slice('tag:'.length),
        (r.value as { tags?: string[] } | undefined)?.tags ?? [],
      ]),
    )
    hiddenEvents = new Set(
      hideRecords
        .filter((r) => (r.value as { hidden?: boolean } | undefined)?.hidden === true)
        .map((r) => r.key.slice('hide:'.length)),
    )
    allTagsList = tags
  }

  onMount(async () => {
    // Readonly callers (Person.svelte) already awaited their events before
    // rendering this component, so there's nothing left to load here.
    if (readonly) {
      loaded = true
      return
    }
    const storedFilter = await get<Category | 'all'>('prefs', 'spine-filter')
    if (storedFilter) filter = storedFilter
    ownEvents = await allEvents()
    await loadCuration()
    loaded = true
    // One-shot: after the entrance has played, later re-renders (filter
    // changes, "Show older") appear instantly.
    setTimeout(() => (animate = false), 500)
  })

  async function setFilter(next: Category | 'all') {
    filter = next
    animate = false
    if (!readonly) await put('prefs', next, 'spine-filter')
  }

  function toggleTagFilter(tag: string) {
    const next = new Set(selectedTags)
    if (next.has(tag)) next.delete(tag)
    else next.add(tag)
    selectedTags = next
  }

  async function handleTagsChanged(eventId: string, tags: string[]) {
    tagsByEvent = new Map(tagsByEvent).set(eventId, tags)
    allTagsList = await allTags()
  }

  async function handleToggleHidden(eventId: string, hidden: boolean) {
    await setHidden(eventId, hidden)
    const next = new Set(hiddenEvents)
    if (hidden) next.add(eventId)
    else next.delete(eventId)
    hiddenEvents = next
  }

</script>

{#if loaded}
  {#if events.length > 0 && filterChips.length > 1}
    <div class="filters" data-testid="spine-filters">
      <button
        type="button"
        class="filter-chip"
        aria-pressed={filter === 'all'}
        onclick={() => setFilter('all')}
        data-testid="filter-all"
      >
        All
      </button>
      {#each filterChips as category (category)}
        <button
          type="button"
          class="filter-chip"
          aria-pressed={filter === category}
          onclick={() => setFilter(category)}
          data-testid="filter-{category}"
        >
          <span class={CATEGORY_META[category].hueClass} aria-hidden="true">
            {CATEGORY_META[category].glyph}
          </span>
          {CATEGORY_META[category].label}
        </button>
      {/each}
    </div>
  {/if}

  {#if !readonly && allTagsList.length > 0}
    <TagChips tags={allTagsList} selected={selectedTags} onToggle={toggleTagFilter} testIdPrefix="spine-tag-filter" />
  {/if}

  <div class="spine" style:--spine-color={`var(--person-${hue})`}>
    <div class="rule"></div>
    {#if events.length === 0}
      <div class="tick" data-testid="day-tick"></div>
      <p class="empty-copy" data-testid="empty-state">
        {readonly
          ? "They haven't logged anything yet."
          : 'Nothing logged yet. Start with today — tap Log below.'}
      </p>
    {:else}
      {#each shown as day, dayIndex (day.day)}
        <section class="day">
          <div class="day-head">
            <div class="tick" data-testid="day-tick"></div>
            <span class="day-label" class:today={day.label === 'Today'} data-testid="day-label">
              {day.label}
            </span>
          </div>
          {#each day.entries as entry, i (entry.effective_at + entry.category)}
            <SpineEntry
              {entry}
              {animate}
              delay={Math.min((dayOffsets[dayIndex] + i) * 20, 250)}
              tags={readonly ? [] : (tagsByEvent.get(entry.eventIds[0]) ?? [])}
              hidden={!readonly && hiddenEvents.has(entry.eventIds[0])}
              editable={!readonly}
              highlightEventId={highlightId}
              onTagsChanged={handleTagsChanged}
              onToggleHidden={handleToggleHidden}
              onOpenViewer={(e) => (viewerEntry = e)}
              onOpenSourceDoc={() => openSourceDoc(entry)}
            />
          {/each}
        </section>
      {/each}
      {#if filteredDays.length > visibleDays}
        <button
          type="button"
          class="show-older"
          onclick={() => (visibleDays += 60)}
          data-testid="show-older"
        >
          Show older
        </button>
      {/if}
    {/if}
  </div>

  {#if viewerEntry?.attachments}
    <AttachmentViewer
      pages={viewerEntry.attachments}
      caption={viewerEntry.label}
      recordedIso={viewerEntry.effective_at}
      source={viewerEntry.detail.source}
      loadBytes={attachmentBytes}
      onclose={() => (viewerEntry = null)}
    />
  {/if}

  {#if sourceDocViewer}
    <AttachmentViewer
      pages={[sourceDocViewer.page]}
      caption={sourceDocViewer.caption}
      recordedIso={sourceDocViewer.recordedIso}
      loadBytes={provenanceBytes}
      onclose={() => (sourceDocViewer = null)}
    />
  {/if}
{/if}

<style>
  .filters {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-1);
    margin-bottom: var(--space-4);
  }

  .filter-chip {
    min-width: 0;
    min-height: 36px;
    border-radius: 999px;
    font-size: var(--text-xs);
    padding: var(--space-1) var(--space-3);
  }

  .filter-chip[aria-pressed='true'] {
    border-color: var(--action);
    color: var(--action);
    background: var(--action-muted);
  }

  .spine {
    position: relative;
    padding-left: var(--space-5);
    min-height: 12rem;
  }

  .rule {
    position: absolute;
    left: 0;
    top: 0;
    bottom: 0;
    width: 2px;
    background: var(--spine-color);
  }

  .day {
    margin-bottom: var(--space-4);
  }

  .day-head {
    position: relative;
    padding: var(--space-1) 0;
  }

  .tick {
    position: absolute;
    left: calc(-1 * var(--space-5) - 3px);
    top: 50%;
    transform: translateY(-50%);
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--spine-color);
  }

  /* The empty state keeps the original static tick (no .day-head wrapper), so
     its containing block is .spine's padding box (left edge at 0), not the
     content-indented .day-head. The default -space-5 offset would push it off
     the left of the viewport; -3px centers it on the rule instead. */
  .spine > .tick {
    left: -3px;
    top: var(--space-2);
    transform: none;
  }

  .day-label {
    font-size: var(--text-sm);
    color: var(--muted);
  }

  .day-label.today {
    font-family: var(--font-display);
    font-size: var(--text-lg);
    color: var(--text);
  }

  .empty-copy {
    color: var(--muted);
    padding-top: var(--space-1);
  }

  .show-older {
    margin-top: var(--space-2);
  }
</style>
