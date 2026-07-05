<script lang="ts">
  import { onMount } from 'svelte'
  import { get, put } from '../../lib/db'
  import {
    VITALS,
    BP_SYSTOLIC,
    BP_DIASTOLIC,
    BP_SYSTOLIC_RANGE,
    BP_DIASTOLIC_RANGE,
    type VitalDef,
    type VitalUnit,
  } from '../../lib/codes'
  import { bpDrafts, vitalDraft, type Draft, type DraftTemplate } from '../../lib/drafts'
  import LogShell from './LogShell.svelte'

  let selectedKey = $state('bp')
  const selected = $derived(VITALS.find((v) => v.key === selectedKey) ?? VITALS[0])

  let systolic = $state('')
  let diastolic = $state('')
  let single = $state('')

  // Chosen unit code per multi-unit vital, persisted so weight stays in lb (or
  // glucose in mg/dL) across sessions.
  let unitChoice = $state<Record<string, string>>({})

  onMount(async () => {
    for (const vital of VITALS) {
      if (vital.units.length < 2) continue
      const stored = await get<string>('prefs', `vital-unit-${vital.key}`)
      if (stored) unitChoice[vital.key] = stored
    }
  })

  const currentUnit = $derived.by((): VitalUnit => {
    const chosen = unitChoice[selected.key]
    return selected.units.find((u) => u.unit.code === chosen) ?? selected.units[0]
  })

  async function chooseUnit(vital: VitalDef, code: string) {
    unitChoice[vital.key] = code
    await put('prefs', code, `vital-unit-${vital.key}`)
  }

  function valid(raw: string, decimals: number): boolean {
    const v = raw.trim()
    return decimals === 0 ? /^\d+$/.test(v) : /^\d+(\.\d+)?$/.test(v)
  }

  /** Plausibility warning, or ''. Advisory only — real readings can be extreme
   * (a 220 systolic is exactly the one you must be able to record), so save is
   * never blocked. */
  function rangeWarning(raw: string, range: { min: number; max: number }, label: string): string {
    if (!raw.trim()) return ''
    const n = Number(raw)
    if (!Number.isFinite(n) || (n >= range.min && n <= range.max)) return ''
    return `${label} of ${raw} is outside the typical range (${range.min}–${range.max}) — double-check, then save if it's right.`
  }

  const warning = $derived.by(() => {
    if (selected.key === 'bp') {
      return (
        rangeWarning(systolic, BP_SYSTOLIC_RANGE, 'Systolic') ||
        rangeWarning(diastolic, BP_DIASTOLIC_RANGE, 'Diastolic')
      )
    }
    return rangeWarning(single, currentUnit, selected.label)
  })

  function buildDrafts(effectiveAt: string): Draft[] | null {
    if (selected.key === 'bp') {
      if (!valid(systolic, 0) || !valid(diastolic, 0)) return null
      return bpDrafts(systolic.trim(), diastolic.trim(), effectiveAt)
    }
    if (!valid(single, selected.decimals)) return null
    return [vitalDraft(selected.loinc, single.trim(), currentUnit.unit, effectiveAt)]
  }

  function favoriteLabel(): string {
    if (selected.key === 'bp') return `BP ${systolic.trim()}/${diastolic.trim()}`
    return `${selected.label} ${single.trim()} ${currentUnit.unit.code}`
  }

  function onReset() {
    systolic = ''
    diastolic = ''
    single = ''
  }

  function onPrefill(templates: DraftTemplate[]) {
    const values = new Map<string, string>()
    for (const t of templates) {
      if (t.code && 'quantity' in t.value) values.set(t.code.code, t.value.quantity.value)
    }
    const sys = values.get(BP_SYSTOLIC.code)
    const dia = values.get(BP_DIASTOLIC.code)
    if (sys !== undefined && dia !== undefined) {
      selectedKey = 'bp'
      systolic = sys
      diastolic = dia
      return
    }
    for (const vital of VITALS) {
      const v = values.get(vital.loinc.code)
      if (v !== undefined) {
        selectedKey = vital.key
        single = v
        return
      }
    }
  }
</script>

<LogShell title="Vitals" category="vital" {buildDrafts} {favoriteLabel} {onPrefill} {onReset}>
  <div class="segments" role="radiogroup" aria-label="Vital type">
    {#each VITALS as vital (vital.key)}
      <button
        type="button"
        role="radio"
        aria-checked={selectedKey === vital.key}
        onclick={() => (selectedKey = vital.key)}
        data-testid="vital-{vital.key}"
      >
        {vital.label}
      </button>
    {/each}
  </div>

  {#if selected.key === 'bp'}
    <div class="pair">
      <label>
        Systolic
        <input
          bind:value={systolic}
          inputmode="numeric"
          autocomplete="off"
          placeholder="118"
          data-testid="bp-systolic"
        />
      </label>
      <span class="slash" aria-hidden="true">/</span>
      <label>
        Diastolic
        <input
          bind:value={diastolic}
          inputmode="numeric"
          autocomplete="off"
          placeholder="76"
          data-testid="bp-diastolic"
        />
      </label>
      <span class="unit muted">mm[Hg]</span>
    </div>
  {:else}
    <div class="pair">
      <label>
        {selected.label}
        <input
          bind:value={single}
          inputmode={selected.decimals === 0 ? 'numeric' : 'decimal'}
          autocomplete="off"
          data-testid="vital-value"
        />
      </label>
      {#if selected.units.length > 1}
        <div class="unit-toggle" role="radiogroup" aria-label="Unit">
          {#each selected.units as u (u.unit.code)}
            <button
              type="button"
              role="radio"
              aria-checked={currentUnit.unit.code === u.unit.code}
              onclick={() => chooseUnit(selected, u.unit.code)}
              data-testid="unit-{u.unit.code}"
            >
              {u.unit.code}
            </button>
          {/each}
        </div>
      {:else}
        <span class="unit muted">{currentUnit.unit.code}</span>
      {/if}
    </div>
  {/if}

  {#if warning}
    <p class="warning" data-testid="range-warning">{warning}</p>
  {/if}
</LogShell>

<style>
  .segments {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-1);
  }

  .segments button {
    min-width: 0;
    font-size: var(--text-sm);
    padding: var(--space-1) var(--space-3);
  }

  .segments button[aria-checked='true'],
  .unit-toggle button[aria-checked='true'] {
    border-color: var(--action);
    color: var(--action);
    background: var(--action-muted);
  }

  .pair {
    display: flex;
    align-items: flex-end;
    gap: var(--space-2);
  }

  .pair label {
    font-size: var(--text-sm);
    color: var(--muted);
  }

  .pair input {
    font-family: var(--font-data);
    font-size: var(--text-lg);
  }

  .slash,
  .unit {
    padding-bottom: var(--space-3);
  }

  .unit-toggle {
    display: flex;
    gap: var(--space-1);
  }

  .unit-toggle button {
    min-width: 0;
    font-size: var(--text-xs);
    padding: var(--space-1) var(--space-2);
    font-family: var(--font-data);
  }

  .warning {
    color: var(--flare);
    font-size: var(--text-sm);
  }
</style>
