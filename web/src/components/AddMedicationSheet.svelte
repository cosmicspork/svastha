<script lang="ts">
  import { logEvent } from '../lib/events'
  import { setRegimen, setStatus, REGIMEN_ROUTES, REGIMEN_ROUTE_LABELS } from '../lib/curation'
  import { planAddMedication, type AddMedicationFields } from '../lib/addMedication'
  import { toLocalIso } from '../lib/time'
  import type { SummaryRow } from '../lib/summary'
  import Sheet from './Sheet.svelte'

  // "Add something I take" — a standing medication the owner is on (a
  // supplement, an over-the-counter regular) that no record imported. One
  // signed statement carrying the name, plus the regimen curation beside it for
  // everything that may change later.
  let {
    medications,
    onclose,
    onsaved,
    onedit,
  }: {
    /** The owner's folded medications, for the duplicate check. */
    medications: SummaryRow[]
    onclose: () => void
    /** Re-read events and curation after the write; awaited before closing. */
    onsaved: () => Promise<void>
    /** Open the existing medication's details instead (the duplicate case). */
    onedit: (row: SummaryRow) => void
  } = $props()

  let fields = $state<AddMedicationFields>({
    name: '',
    dose: '',
    schedule: '',
    route: '',
    as_needed: false,
    started: '',
  })
  let saving = $state(false)
  let error = $state('')

  const today = toLocalIso(new Date()).slice(0, 10)
  const plan = $derived(planAddMedication(fields, medications, new Date()))

  async function save() {
    if (plan.kind !== 'add') return
    saving = true
    error = ''
    try {
      await logEvent([plan.draft])
      if (plan.reactivate) await setStatus(plan.key, 'active')
      if (plan.regimen) await setRegimen(plan.key, plan.regimen)
      await onsaved()
      onclose()
    } catch (err) {
      error = err instanceof Error ? err.message : 'Could not save — try again.'
    } finally {
      saving = false
    }
  }
</script>

<Sheet {onclose}>
  <form
    class="add-sheet"
    data-testid="add-med-sheet"
    onsubmit={(e) => {
      e.preventDefault()
      void save()
    }}
  >
    <h2 class="add-title">Add something you take</h2>
    <p class="add-hint muted">
      A medication or supplement you're on. To note a single dose you took, use the Meds log instead.
    </p>

    <label class="add-field">
      <span class="add-label">Name</span>
      <input
        type="text"
        bind:value={fields.name}
        placeholder="Magnesium glycinate"
        autocomplete="off"
        data-testid="add-med-name"
      />
    </label>

    {#if plan.kind === 'existing'}
      <div class="dup" data-testid="add-med-duplicate">
        <span>{plan.row.label} is already on your list.</span>
        <button type="button" class="tonal" onclick={() => onedit(plan.row)} data-testid="add-med-edit-existing">
          Edit its details
        </button>
      </div>
    {/if}

    <label class="add-field">
      <span class="add-label">Dose (optional)</span>
      <input type="text" bind:value={fields.dose} placeholder="400 mg" data-testid="add-med-dose" />
    </label>

    <label class="add-field">
      <span class="add-label">Schedule (optional)</span>
      <input type="text" bind:value={fields.schedule} placeholder="Nightly" data-testid="add-med-schedule" />
    </label>

    <label class="add-field">
      <span class="add-label">Route (optional)</span>
      <select bind:value={fields.route} data-testid="add-med-route">
        <option value="">—</option>
        {#each REGIMEN_ROUTES as route (route)}
          <option value={route}>{REGIMEN_ROUTE_LABELS[route]}</option>
        {/each}
      </select>
    </label>

    <label class="check-field">
      <input type="checkbox" bind:checked={fields.as_needed} data-testid="add-med-as-needed" />
      <span class="add-label">As needed</span>
    </label>

    <label class="add-field">
      <span class="add-label">Started (optional)</span>
      <input type="date" bind:value={fields.started} max={today} data-testid="add-med-started" />
    </label>

    {#if error}
      <p class="error" data-testid="add-med-error">{error}</p>
    {/if}

    <div class="add-buttons">
      <button type="button" class="ghost" onclick={onclose} data-testid="add-med-cancel">Cancel</button>
      <button type="submit" class="primary" disabled={saving || plan.kind !== 'add'} data-testid="add-med-save">
        Add
      </button>
    </div>
  </form>
</Sheet>

<style>
  .add-sheet {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }

  .add-title {
    font-family: var(--font-display);
    font-size: var(--text-lg);
    margin: 0;
  }

  .add-hint {
    margin: 0;
    font-size: var(--text-sm);
  }

  .add-field {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
  }

  .add-label {
    font-size: var(--text-sm);
  }

  .check-field {
    display: flex;
    align-items: center;
    gap: var(--space-2);
  }

  .dup {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-2);
    font-size: var(--text-sm);
  }

  .add-buttons {
    display: flex;
    justify-content: flex-end;
    gap: var(--space-2);
  }
</style>
