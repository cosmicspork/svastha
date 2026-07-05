<script lang="ts">
  import { medDraft, type Draft, type DraftTemplate } from '../../lib/drafts'
  import LogShell from './LogShell.svelte'

  const DOSE_UNITS = ['mg', 'mcg', 'g', 'mL', 'IU']

  let name = $state('')
  let dose = $state('')
  let doseUnit = $state('mg')

  function buildDrafts(effectiveAt: string): Draft[] | null {
    const n = name.trim()
    if (!n) return null
    const d = dose.trim()
    if (d && !/^\d+(\.\d+)?$/.test(d)) return null
    return [medDraft(n, effectiveAt, d || undefined, doseUnit)]
  }

  function favoriteLabel(): string {
    const d = dose.trim()
    return d ? `${name.trim()} ${d} ${doseUnit}` : name.trim()
  }

  function onReset() {
    name = ''
    dose = ''
  }

  function onPrefill(templates: DraftTemplate[]) {
    const t = templates[0]
    // Recents/favorites carry the whole "name — dose unit" text; prefill it as
    // the name so re-saving reproduces the identical value (same content id
    // shape), rather than lossily re-parsing it into fields.
    if (t && 'text' in t.value) {
      name = t.value.text
      dose = ''
    }
  }
</script>

<LogShell title="Meds" category="med" {buildDrafts} {favoriteLabel} {onPrefill} {onReset}>
  <label>
    Medication
    <input bind:value={name} autocomplete="off" placeholder="ibuprofen" data-testid="med-name" />
  </label>

  <div class="dose">
    <label>
      Dose (optional)
      <input
        bind:value={dose}
        inputmode="decimal"
        autocomplete="off"
        placeholder="400"
        data-testid="med-dose"
      />
    </label>
    <label>
      Unit
      <select bind:value={doseUnit} data-testid="med-dose-unit">
        {#each DOSE_UNITS as u (u)}
          <option value={u}>{u}</option>
        {/each}
      </select>
    </label>
  </div>
</LogShell>

<style>
  label {
    display: block;
    font-size: var(--text-sm);
    color: var(--muted);
  }

  .dose {
    display: flex;
    gap: var(--space-3);
    align-items: flex-end;
  }

  select {
    min-height: 44px;
    padding: var(--space-2) var(--space-3);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--surface);
  }
</style>
