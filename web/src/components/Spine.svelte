<script lang="ts">
  import { onMount } from 'svelte'
  import { get, put } from '../lib/db'
  import { allEvents, type StoredEvent } from '../lib/events'
  import { buildTimeline, categoriesPresent } from '../lib/timeline'
  import { CATEGORIES, CATEGORY_META, type Category } from '../lib/category'
  import SpineEntry from './SpineEntry.svelte'

  let { hue }: { hue: 'a' | 'b' } = $props()

  let events = $state<StoredEvent[]>([])
  let loaded = $state(false)
  let filter = $state<Category | 'all'>('all')
  // Day-group cap, not a scroll virtualizer: a couple logging many times a day
  // accumulates thousands of rows in a year, and rendering them all at once
  // makes first paint (and the entrance stagger) crawl. 60 days covers "what's
  // been going on lately"; older history is one tap away.
  let visibleDays = $state(60)
  let animate = $state(true)

  const days = $derived(buildTimeline(events, filter))
  const shown = $derived(days.slice(0, visibleDays))
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

  onMount(async () => {
    const storedFilter = await get<Category | 'all'>('prefs', 'spine-filter')
    if (storedFilter) filter = storedFilter
    events = await allEvents()
    loaded = true
    // One-shot: after the entrance has played, later re-renders (filter
    // changes, "Show older") appear instantly.
    setTimeout(() => (animate = false), 500)
  })

  async function setFilter(next: Category | 'all') {
    filter = next
    animate = false
    await put('prefs', next, 'spine-filter')
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

  <div class="spine" style:--spine-color={`var(--person-${hue})`}>
    <div class="rule"></div>
    {#if events.length === 0}
      <div class="tick" data-testid="day-tick"></div>
      <p class="empty-copy" data-testid="empty-state">
        Nothing logged yet. Start with today — tap Log below.
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
            />
          {/each}
        </section>
      {/each}
      {#if days.length > visibleDays}
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
