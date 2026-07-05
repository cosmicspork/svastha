<script lang="ts">
  import { onMount } from 'svelte'
  import { preceding, type FlareSymptom } from '../lib/correlate'
  import { isHidden, setHidden } from '../lib/curation'
  import { CATEGORY_META } from '../lib/category'
  import { formatTime } from '../lib/time'
  import type { StoredEvent } from '../lib/events'
  import TagEditor from './TagEditor.svelte'

  let {
    symptom,
    events,
    onClose,
  }: {
    symptom: FlareSymptom
    /** The full (unfiltered) event log — `preceding` searches all of it, not
     * just whatever tag filter narrowed the chart's lanes. */
    events: StoredEvent[]
    onClose: () => void
  } = $props()

  const WINDOWS = [12, 24, 48, 72] as const
  let windowHours = $state<number>(48)
  let hidden = $state(false)
  let loaded = $state(false)

  onMount(async () => {
    hidden = await isHidden(symptom.eventId)
    loaded = true
  })

  const items = $derived(preceding(events, symptom.atIso, windowHours))

  async function toggleHidden() {
    hidden = !hidden
    await setHidden(symptom.eventId, hidden)
  }

  function onKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') onClose()
  }
</script>

<svelte:window onkeydown={onKeydown} />

<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
<!-- Purely a dismiss target; Escape (svelte:window above) is the keyboard
     equivalent, and the panel itself holds focusable, labeled controls. -->
<div class="backdrop" onclick={onClose} data-testid="flare-backdrop"></div>

<div class="panel" role="dialog" aria-label="Symptom detail" data-testid="flare-panel">
  <div class="head">
    <div>
      <h2>{symptom.name}</h2>
      <p class="muted">
        {formatTime(symptom.atIso)}
        {#if symptom.severity !== null}
          <span class="data">· {symptom.severity}/10</span>
        {/if}
      </p>
    </div>
    <button type="button" class="close" onclick={onClose} data-testid="flare-close" aria-label="Close">
      ×
    </button>
  </div>

  <div class="windows" role="group" aria-label="Look-back window">
    {#each WINDOWS as hours (hours)}
      <button
        type="button"
        class="window-chip"
        aria-pressed={windowHours === hours}
        onclick={() => (windowHours = hours)}
        data-testid="flare-window-{hours}"
      >
        {hours}h
      </button>
    {/each}
  </div>

  {#if items.length === 0}
    <p class="muted" data-testid="flare-empty">Nothing logged in this window.</p>
  {:else}
    <ul class="items">
      {#each items as item, i (item.atIso + item.label + i)}
        <li data-testid="flare-item">
          <span class={CATEGORY_META[item.category].hueClass} aria-hidden="true">
            {CATEGORY_META[item.category].glyph}
          </span>
          <span class="label">{item.label}</span>
          <span class="delta muted data">{Math.round(item.deltaHours)} h before</span>
        </li>
      {/each}
    </ul>
  {/if}

  {#if loaded}
    <div class="footer stack">
      <TagEditor eventId={symptom.eventId} />
      <label class="hide-toggle">
        <input type="checkbox" checked={hidden} onchange={toggleHidden} data-testid="flare-hide" />
        Hide this entry from the spine
      </label>
    </div>
  {/if}
</div>

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    background: rgb(0 0 0 / 0.35);
    z-index: 10;
  }

  .panel {
    position: fixed;
    left: 0;
    right: 0;
    bottom: 0;
    z-index: 11;
    max-height: 85vh;
    overflow-y: auto;
    background: var(--surface);
    border-top: 1px solid var(--border);
    border-radius: var(--radius-lg) var(--radius-lg) 0 0;
    padding: var(--space-4) var(--space-4) calc(var(--space-5) + env(safe-area-inset-bottom));
    box-shadow: 0 -2px 16px rgb(0 0 0 / 0.16);
    animation: rise var(--duration-base) ease;
  }

  @keyframes rise {
    from {
      transform: translateY(100%);
    }
    to {
      transform: translateY(0);
    }
  }

  .head {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: var(--space-3);
  }

  .head h2 {
    margin-bottom: var(--space-1);
  }

  .close {
    border: none;
    background: none;
    min-height: auto;
    min-width: auto;
    font-size: var(--text-xl);
    color: var(--muted);
    padding: 0 var(--space-2);
  }

  .windows {
    display: flex;
    gap: var(--space-1);
    margin: var(--space-3) 0;
  }

  .window-chip {
    min-width: 0;
    min-height: 36px;
    border-radius: 999px;
    font-size: var(--text-xs);
    padding: var(--space-1) var(--space-3);
  }

  .window-chip[aria-pressed='true'] {
    border-color: var(--action);
    color: var(--action);
    background: var(--action-muted);
  }

  .items {
    list-style: none;
    margin: 0 0 var(--space-4);
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }

  .items li {
    display: flex;
    align-items: baseline;
    gap: var(--space-2);
  }

  .label {
    min-width: 0;
    overflow-wrap: anywhere;
  }

  .delta {
    margin-left: auto;
    flex: none;
    font-size: var(--text-xs);
  }

  .footer {
    border-top: 1px solid var(--border);
    padding-top: var(--space-4);
  }

  .hide-toggle {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    font-size: var(--text-sm);
    color: var(--muted);
  }

  .hide-toggle input {
    min-height: auto;
    width: auto;
  }
</style>
