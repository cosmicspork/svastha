<script lang="ts">
  import { onMount } from 'svelte'
  import { allEvents, type StoredEvent } from '../lib/events'
  import { lanes, type Lanes, type InputCategory, type FlareSymptom } from '../lib/correlate'
  import { allCurationByPrefix, allTags } from '../lib/curation'
  import { toLocalIso } from '../lib/time'
  import TagChips from '../components/TagChips.svelte'
  import FlarePanel from '../components/FlarePanel.svelte'

  const RANGE_PRESETS = [7, 30, 90] as const
  const INPUT_LABELS: Record<InputCategory, string> = { food: 'Food', med: 'Meds', exercise: 'Move' }

  let events = $state<StoredEvent[]>([])
  let tagsByEvent = $state<Map<string, string[]>>(new Map())
  let allTagsList = $state<string[]>([])
  let selectedTags = $state<Set<string>>(new Set())
  let loaded = $state(false)

  let rangeDays = $state<number>(30)
  let showCustom = $state(false)
  let customFrom = $state('')
  let customTo = $state('')

  let selectedSymptom = $state<FlareSymptom | null>(null)

  onMount(async () => {
    events = await allEvents()
    const tagRecords = await allCurationByPrefix('tag:')
    tagsByEvent = new Map(
      tagRecords.map((r) => [
        r.key.slice('tag:'.length),
        (r.value as { tags?: string[] } | undefined)?.tags ?? [],
      ]),
    )
    allTagsList = await allTags()
    loaded = true
  })

  const range = $derived.by((): { from: string; to: string } => {
    if (showCustom && customFrom && customTo) {
      return { from: `${customFrom}T00:00:00`, to: `${customTo}T23:59:59` }
    }
    const to = new Date()
    const from = new Date(to.getTime() - rangeDays * 86_400_000)
    return { from: toLocalIso(from), to: toLocalIso(to) }
  })

  const filteredEvents = $derived.by(() => {
    if (selectedTags.size === 0) return events
    return events.filter(({ event }) => (tagsByEvent.get(event.id) ?? []).some((t) => selectedTags.has(t)))
  })

  const data = $derived<Lanes>(lanes(filteredEvents, range.from, range.to))
  const fromMs = $derived(new Date(range.from).getTime())
  const toMs = $derived(new Date(range.to).getTime())

  // The viewBox is 1000 units wide, but a dot/tick plotted at exactly x=0 or
  // x=1000 gets its far half clipped by the SVG's default viewBox overflow —
  // and a browser's hit-test (and Playwright's click-target resolution) is
  // then unreliable right at that edge. Insetting the usable range keeps
  // every mark's full radius inside the viewBox.
  const X_PAD = 30
  function mapUnit(t: number): number {
    return X_PAD + t * (1000 - 2 * X_PAD)
  }

  /** Sparse day-tick labels along the shared x-axis: at most 6, evenly spaced. */
  const axisTicks = $derived.by(() => {
    const count = 6
    const span = toMs - fromMs
    if (span <= 0) return []
    return Array.from({ length: count + 1 }, (_, i) => {
      const t = fromMs + (span * i) / count
      return {
        x: mapUnit(i / count),
        label: new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }),
      }
    })
  })

  function xOf(atIso: string): number {
    if (toMs === fromMs) return 500
    return mapUnit((new Date(atIso).getTime() - fromMs) / (toMs - fromMs))
  }

  function radiusOf(severity: number | null, max: number): number {
    if (severity === null) return 5
    return 4 + (severity / max) * 6 // 4..10
  }

  function opacityOf(severity: number | null, max: number): number {
    if (severity === null) return 0.6
    return 0.4 + (severity / max) * 0.6 // 0.4..1
  }

  function setPreset(days: number) {
    rangeDays = days
    showCustom = false
  }

  function toggleTag(tag: string) {
    const next = new Set(selectedTags)
    if (next.has(tag)) next.delete(tag)
    else next.add(tag)
    selectedTags = next
  }

  function openSymptom(name: string, point: { atIso: string; severity: number | null; eventId: string }) {
    selectedSymptom = { eventId: point.eventId, name, atIso: point.atIso, severity: point.severity }
  }

  function onDotKeydown(e: KeyboardEvent, name: string, point: { atIso: string; severity: number | null; eventId: string }) {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      openSymptom(name, point)
    }
  }
</script>

<h1>Patterns</h1>

{#if loaded}
  <div class="range-row">
    {#each RANGE_PRESETS as days (days)}
      <button
        type="button"
        class="chip"
        aria-pressed={!showCustom && rangeDays === days}
        onclick={() => setPreset(days)}
        data-testid="range-{days}"
      >
        {days}d
      </button>
    {/each}
    <button
      type="button"
      class="chip"
      aria-pressed={showCustom}
      onclick={() => (showCustom = !showCustom)}
      data-testid="range-custom-toggle"
    >
      Custom
    </button>
  </div>

  {#if showCustom}
    <div class="custom-range">
      <label>
        From
        <input type="date" bind:value={customFrom} data-testid="range-from" />
      </label>
      <label>
        To
        <input type="date" bind:value={customTo} data-testid="range-to" />
      </label>
    </div>
  {/if}

  <TagChips tags={allTagsList} selected={selectedTags} onToggle={toggleTag} testIdPrefix="correlate-tag-filter" />

  {#if data.symptoms.length === 0 && data.inputs.length === 0}
    <p class="muted" data-testid="correlate-empty">
      Not enough data yet — log symptoms and meals for a few days and patterns will appear here.
    </p>
  {:else}
    <div class="axis" aria-hidden="true">
      {#each axisTicks as tick (tick.x)}
        <span class="axis-label" style:left="{tick.x / 10}%">{tick.label}</span>
      {/each}
    </div>

    <div class="symptom-lanes" data-testid="symptom-lanes">
      {#each data.symptoms as lane (lane.name)}
        <div class="lane-row">
          <span class="lane-label">{lane.name}</span>
          <svg
            class="lane-svg"
            viewBox="0 0 1000 32"
            preserveAspectRatio="none"
            role="img"
            aria-label="{lane.name} occurrences"
          >
            {#each lane.points as point (point.atIso + point.eventId)}
              <circle
                cx={xOf(point.atIso)}
                cy="16"
                r={radiusOf(point.severity, lane.max)}
                fill={point.severity !== null && point.severity >= 7 ? 'var(--flare)' : 'var(--person-a)'}
                opacity={opacityOf(point.severity, lane.max)}
                tabindex="0"
                role="button"
                aria-label="{lane.name} at {point.atIso}{point.severity !== null ? `, severity ${point.severity}/${lane.max}` : ''}"
                data-testid="symptom-dot"
                onclick={() => openSymptom(lane.name, point)}
                onkeydown={(e) => onDotKeydown(e, lane.name, point)}
              />
            {/each}
          </svg>
          <span class="lane-count muted data" data-testid="symptom-lane-count">{lane.points.length}</span>
        </div>
      {/each}
    </div>

    <div class="input-band" data-testid="input-lanes">
      {#each data.inputs as lane (lane.category)}
        <div class="lane-row">
          <span class="lane-label">{INPUT_LABELS[lane.category]}</span>
          <svg
            class="lane-svg"
            viewBox="0 0 1000 32"
            preserveAspectRatio="none"
            role="img"
            aria-label="{INPUT_LABELS[lane.category]} entries"
          >
            {#each lane.ticks as tick, i (tick.atIso + i)}
              <rect x={xOf(tick.atIso) - 1} y="6" width="2" height="20" fill="var(--action)">
                <title>{tick.label}</title>
              </rect>
            {/each}
          </svg>
          <span class="lane-count muted data">{lane.ticks.length}</span>
        </div>
      {/each}
    </div>
  {/if}
{/if}

{#if selectedSymptom}
  <FlarePanel symptom={selectedSymptom} {events} onClose={() => (selectedSymptom = null)} />
{/if}

<style>
  .range-row {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-1);
    margin-bottom: var(--space-3);
  }

  .chip {
    min-width: 0;
    min-height: 36px;
    border-radius: 999px;
    font-size: var(--text-xs);
    padding: var(--space-1) var(--space-3);
  }

  .chip[aria-pressed='true'] {
    border-color: var(--action);
    color: var(--action);
    background: var(--action-muted);
  }

  .custom-range {
    display: flex;
    gap: var(--space-3);
    margin-bottom: var(--space-4);
  }

  .custom-range label {
    flex: 1;
    font-size: var(--text-sm);
    color: var(--muted);
  }

  .axis {
    position: relative;
    height: 1.25rem;
    margin: var(--space-2) 0;
  }

  .axis-label {
    position: absolute;
    transform: translateX(-50%);
    font-size: var(--text-xs);
    color: var(--muted);
    white-space: nowrap;
  }

  .symptom-lanes {
    max-height: 20rem;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }

  .input-band {
    margin-top: var(--space-4);
    padding-top: var(--space-3);
    border-top: 1px solid var(--border);
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }

  .lane-row {
    display: flex;
    align-items: center;
    gap: var(--space-2);
  }

  .lane-label {
    flex: none;
    width: 5rem;
    font-size: var(--text-sm);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .lane-svg {
    flex: 1;
    min-width: 0;
    width: 100%;
    height: 32px;
  }

  .lane-svg circle {
    cursor: pointer;
  }

  .lane-svg circle:focus-visible {
    outline: 2px solid var(--action);
    outline-offset: 2px;
  }

  .lane-count {
    flex: none;
    width: 1.5rem;
    text-align: right;
    font-size: var(--text-xs);
  }
</style>
