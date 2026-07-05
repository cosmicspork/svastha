<script lang="ts">
  import { onMount } from 'svelte'
  import { get, put } from '../lib/db'
  import { allEvents, type StoredEvent } from '../lib/events'
  import { buildTimeline, categoriesPresent } from '../lib/timeline'
  import { CATEGORIES, CATEGORY_META, type Category } from '../lib/category'
  import { allCurationByPrefix, allTags, setHidden } from '../lib/curation'
  import SpineEntry from './SpineEntry.svelte'
  import TagChips from './TagChips.svelte'

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

  let tagsByEvent = $state<Map<string, string[]>>(new Map())
  let hiddenEvents = $state<Set<string>>(new Set())
  let allTagsList = $state<string[]>([])
  let selectedTags = $state<Set<string>>(new Set())

  const days = $derived(buildTimeline(events, filter))
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
              onTagsChanged={handleTagsChanged}
              onToggleHidden={handleToggleHidden}
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

  /* The empty state keeps the original static tick (no .day-head wrapper). */
  .spine > .tick {
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
