<script lang="ts">
  import type { StoredEvent } from '../lib/events'
  import { cycleStats } from '../lib/cycle'
  import { cycleBand } from '../lib/cycleBand'

  let { events }: { events: StoredEvent[] } = $props()

  const stats = $derived(cycleStats(events))
  const band = $derived(cycleBand(events))

  function fmtDate(iso: string): string {
    return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
  }

  // The stats line is honest by omission: a median only earns its place with ≥2
  // completed cycles, a typical-period figure only once a period has a recorded
  // end. With neither, we say so rather than dress up a single reading as a
  // statistic.
  const statsParts = $derived.by(() => {
    if (!stats) return []
    const parts: string[] = []
    if (band.completedCount >= 2 && stats.medianLength !== null) {
      parts.push(`${stats.medianLength}d median (${stats.minLength}–${stats.maxLength})`)
    }
    if (stats.typicalPeriodDays !== null) parts.push(`period ${stats.typicalPeriodDays}d typical`)
    return parts
  })
</script>

{#if stats}
  <section class="cycle-stats" data-testid="cycle-stats">
    <header class="head">
      {#if stats.currentDay !== null}
        <span class="day" data-testid="cycle-day">Day {stats.currentDay}</span>
      {/if}
      {#if stats.lastStartIso}
        <span class="caption data">Current cycle · started {fmtDate(stats.lastStartIso)}</span>
      {/if}
    </header>

    {#if band.bars.length > 0}
      {#if band.earlierCount > 0}
        <p class="earlier data muted" data-testid="cycle-earlier">+{band.earlierCount} earlier</p>
      {/if}

      <div class="band" data-testid="cycle-band">
        {#each band.bars as bar (bar.startIso)}
          <div class="bar-row" data-testid="cycle-bar">
            <span class="month data muted">{bar.monthLabel}</span>
            <div class="track">
              <div
                class="bar"
                class:open={bar.open}
                style:width="{bar.widthPct}%"
                title="{bar.rightLabel}"
              >
                {#if !bar.open && bar.fillPct > 0}
                  <div class="fill" style:width="{bar.fillPct}%"></div>
                {/if}
                {#each bar.markers as marker (marker.atIso + marker.label)}
                  <span
                    class="marker"
                    style:left="{marker.offsetPct}%"
                    title="{marker.label}"
                    data-testid="cycle-marker">×</span
                  >
                {/each}
              </div>
            </div>
            <span class="len data">{bar.rightLabel}</span>
          </div>
        {/each}
      </div>

      <div class="legend data muted" aria-hidden="true">
        <span class="key"><span class="swatch fill-swatch"></span>period</span>
        <span class="key"><span class="swatch cycle-swatch"></span>cycle</span>
        {#each band.legendSymptoms as label (label)}
          <span class="key"><span class="marker-swatch">×</span>{label}</span>
        {/each}
      </div>
    {/if}

    {#if statsParts.length > 0}
      <p class="stats data" data-testid="cycle-stats-line">{statsParts.join(' · ')}</p>
    {:else}
      <p class="stats muted" data-testid="cycle-stats-line">
        Not enough recorded cycles for statistics yet.
      </p>
    {/if}
  </section>
{/if}

<style>
  .cycle-stats {
    margin-bottom: var(--space-5);
    padding-bottom: var(--space-4);
    border-bottom: 1px solid var(--border);
  }

  .head {
    display: flex;
    align-items: baseline;
    flex-wrap: wrap;
    gap: var(--space-1) var(--space-3);
  }

  .day {
    font-family: var(--font-display);
    font-size: var(--text-3xl);
    line-height: 1;
    color: var(--cat-cycle);
  }

  .caption {
    font-size: var(--text-xs);
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--muted);
  }

  .earlier {
    margin: var(--space-3) 0 0;
    font-size: var(--text-xs);
  }

  .band {
    margin-top: var(--space-3);
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }

  .bar-row {
    display: flex;
    align-items: center;
    gap: var(--space-2);
  }

  .month {
    flex: none;
    width: 2.5rem;
    font-size: var(--text-xs);
    text-align: right;
  }

  .track {
    flex: 1;
    min-width: 0;
  }

  /* The bar's own width encodes cycle length; the fill and markers are
     positioned relative to it, so a percentage always reads against the right
     denominator. The base tint is a color-mix, not `opacity` — an opacity on the
     bar would clamp the full-strength fill and the markers to the same fade,
     hiding them. */
  .bar {
    position: relative;
    height: 1.25rem;
    border-radius: 3px;
    background: color-mix(in srgb, var(--cat-cycle) 28%, transparent);
  }

  .bar.open {
    background: transparent;
    border: 1px dashed color-mix(in srgb, var(--cat-cycle) 70%, transparent);
  }

  .fill {
    position: absolute;
    inset: 0 auto 0 0;
    border-radius: 3px;
    background: var(--cat-cycle);
  }

  .marker {
    position: absolute;
    top: 50%;
    transform: translate(-50%, -50%);
    font-size: var(--text-xs);
    line-height: 1;
    color: var(--cat-symptom);
    font-weight: 700;
  }

  .len {
    flex: none;
    width: 3rem;
    text-align: right;
    font-size: var(--text-xs);
    font-variant-numeric: tabular-nums;
  }

  .legend {
    margin-top: var(--space-3);
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-1) var(--space-3);
    font-size: var(--text-xs);
  }

  .key {
    display: inline-flex;
    align-items: center;
    gap: var(--space-1);
  }

  .swatch {
    width: 0.75rem;
    height: 0.75rem;
    border-radius: 2px;
  }

  .fill-swatch {
    background: var(--cat-cycle);
  }

  .cycle-swatch {
    background: color-mix(in srgb, var(--cat-cycle) 28%, transparent);
  }

  .marker-swatch {
    color: var(--cat-symptom);
    font-weight: 700;
  }

  .stats {
    margin: var(--space-3) 0 0;
    font-size: var(--text-sm);
  }
</style>
