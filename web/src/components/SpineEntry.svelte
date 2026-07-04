<script lang="ts">
  import { CATEGORY_META } from '../lib/category'
  import { formatTime } from '../lib/time'
  import type { TimelineEntry } from '../lib/timeline'

  let {
    entry,
    animate,
    delay,
  }: {
    entry: TimelineEntry
    /** Entrance animation runs only on the spine's first render. */
    animate: boolean
    delay: number
  } = $props()

  const meta = $derived(CATEGORY_META[entry.category])
</script>

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
  {#if entry.value}
    <span class="value data">{entry.value}</span>
  {/if}
  <span class="time muted">{formatTime(entry.effective_at)}</span>
</div>

<style>
  .entry {
    position: relative;
    display: flex;
    align-items: baseline;
    gap: var(--space-2);
    padding: var(--space-1) 0;
  }

  .entry.flare {
    box-shadow: inset 2px 0 0 var(--flare);
    padding-left: var(--space-2);
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

  .value {
    white-space: nowrap;
  }

  .time {
    margin-left: auto;
    flex: none;
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
