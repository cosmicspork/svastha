<script lang="ts">
  import { CYCLE_START, CYCLE_END, CYCLE_FLOW, CYCLE_CLOTS } from '../../lib/codes'
  import {
    cycleStartDraft,
    cycleFlowDraft,
    cycleEndDraft,
    type Draft,
    type DraftTemplate,
  } from '../../lib/drafts'
  import { FLOW_WORDS } from '../../lib/timeline'
  import { navigate } from '../../lib/router.svelte'
  import LogShell from './LogShell.svelte'

  type Pane = 'start' | 'flow' | 'end'

  /** Quarter-filled at Spotting, full at Heavy — a plain linear ramp (unlike
   * the mood moon's curved one): flow is a straight 1–4 ordinal with no
   * "barely vs. nearly there" distinction to exaggerate. */
  const FLOW_SCALE = [1, 2, 3, 4].map((level) => ({ level, fill: level / 4 }))

  let pane = $state<Pane>('flow')
  let flowLevel = $state<number | null>(null)
  let clots = $state(false)

  const saveLabel = $derived(
    pane === 'flow' ? 'Log flow' : pane === 'start' ? 'Log period start' : 'Log period end',
  )

  function buildDrafts(effectiveAt: string): Draft[] | null {
    if (pane === 'flow') {
      return flowLevel !== null ? cycleFlowDraft(flowLevel, clots, effectiveAt) : null
    }
    if (pane === 'start') {
      // Flow/clots are optional on the start marker itself — it's always
      // saveable, with or without them.
      return cycleStartDraft(flowLevel, clots, effectiveAt)
    }
    return [cycleEndDraft(effectiveAt)]
  }

  function favoriteLabel(): string {
    if (pane === 'end') return 'Period end'
    const parts: string[] = pane === 'start' ? ['Period start'] : []
    if (flowLevel !== null) parts.push(FLOW_WORDS[flowLevel])
    let label = parts.length > 0 ? parts.join(' · ') : 'Flow'
    if (clots) label += ' · clots'
    return label
  }

  function onReset() {
    flowLevel = null
    clots = false
  }

  function onPrefill(templates: DraftTemplate[]) {
    const hasStart = templates.some((t) => t.code?.code === CYCLE_START.code)
    const hasEnd = templates.some((t) => t.code?.code === CYCLE_END.code)
    const flowTemplate = templates.find((t) => t.code?.code === CYCLE_FLOW.code)

    flowLevel =
      flowTemplate && flowTemplate.value && 'quantity' in flowTemplate.value
        ? Number(flowTemplate.value.quantity.value)
        : null
    clots = templates.some((t) => t.code?.code === CYCLE_CLOTS.code)
    pane = hasStart ? 'start' : hasEnd ? 'end' : 'flow'
  }
</script>

<LogShell title="Cycle" category="cycle" {buildDrafts} {favoriteLabel} {onPrefill} {onReset} {saveLabel}>
  <div class="seg" role="group" aria-label="Start, flow, or end">
    <button type="button" aria-pressed={pane === 'start'} onclick={() => (pane = 'start')} data-testid="cycle-tab-start">
      Start
    </button>
    <button type="button" aria-pressed={pane === 'flow'} onclick={() => (pane = 'flow')} data-testid="cycle-tab-flow">
      Flow
    </button>
    <button type="button" aria-pressed={pane === 'end'} onclick={() => (pane = 'end')} data-testid="cycle-tab-end">
      End
    </button>
  </div>

  {#if pane === 'start'}
    <p class="prompt">Logs the start marker; flow can be added with it or later.</p>
  {/if}

  {#if pane !== 'end'}
    <div class="flows" role="group" aria-label="Flow">
      {#each FLOW_SCALE as f (f.level)}
        <button
          type="button"
          class="flow"
          aria-pressed={flowLevel === f.level}
          onclick={() => (flowLevel = f.level)}
          data-testid="flow-{f.level}"
        >
          <span class="pip" style:--fill={f.fill}></span>
          <small>{FLOW_WORDS[f.level]}</small>
        </button>
      {/each}
    </div>

    {#if pane === 'flow'}
      <p class="hint">
        Cramps or breast tenderness?
        <button type="button" class="link" onclick={() => navigate('#/log/symptom')} data-testid="cycle-symptom-link">
          Log a symptom
        </button>
        — symptoms chart against your cycle in Patterns.
      </p>
    {/if}

    <button
      type="button"
      class="clots"
      aria-pressed={clots}
      onclick={() => (clots = !clots)}
      data-testid="clots-toggle"
    >
      Clots
    </button>
  {/if}
</LogShell>

<style>
  .prompt {
    font-size: var(--text-sm);
    color: var(--muted);
    margin-bottom: 0;
  }

  .hint {
    font-size: var(--text-sm);
    color: var(--muted);
    margin: 0;
  }

  .link {
    min-height: auto;
    min-width: auto;
    border: none;
    background: none;
    padding: 0;
    color: var(--action);
    text-decoration: underline;
    font-size: inherit;
  }

  /* flow scale — a quarter-to-full pip, same construction as the mood moon */
  .flows {
    display: flex;
    justify-content: space-between;
    gap: var(--space-2);
    margin: var(--space-3) 0 var(--space-2);
  }

  .flow {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--space-2);
    background: none;
    border: none;
    min-height: auto;
    min-width: 0;
    padding: var(--space-2) 0;
    border-radius: var(--radius-sm);
  }

  .flow .pip {
    width: 28px;
    height: 28px;
    border-radius: 50%;
    border: 2px solid var(--cat-cycle);
    position: relative;
    overflow: hidden;
    transition: box-shadow var(--duration-fast);
  }

  .flow .pip::after {
    content: '';
    position: absolute;
    inset: 0;
    background: var(--cat-cycle);
    transform-origin: bottom;
    transform: scaleY(var(--fill, 0));
    transition: transform var(--duration-base);
  }

  .flow small {
    font-size: var(--text-xs);
    color: var(--muted);
  }

  .flow[aria-pressed='true'] .pip {
    box-shadow: 0 0 0 3px var(--action-muted), 0 0 0 4px var(--action);
  }

  .flow[aria-pressed='true'] small {
    color: var(--text);
    font-weight: 700;
  }

  .clots {
    border-radius: var(--radius-full);
    font-size: var(--text-sm);
    padding: var(--space-1) var(--space-3);
    min-height: 38px;
  }

  .clots[aria-pressed='true'] {
    border-color: var(--action);
    color: var(--action);
    background: var(--action-muted);
  }
</style>
