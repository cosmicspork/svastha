<script lang="ts">
  import { VITALS, type VitalDef } from '../../lib/codes'
  import {
    encounterDraft,
    noteDraft,
    visitVitalsDrafts,
    visitMedsDrafts,
    visitConditionsDrafts,
    visitProceduresDrafts,
    visitImmunizationsDrafts,
    visitAllergiesDrafts,
    type VisitVitalRow,
    type VisitMedRow,
    type VisitConditionRow,
    type VisitProcedureRow,
    type VisitImmunizationRow,
    type VisitAllergyRow,
    type Draft,
    type DraftTemplate,
  } from '../../lib/drafts'
  import LogShell from './LogShell.svelte'

  const DOSE_UNITS = ['mg', 'mcg', 'g', 'mL', 'IU']

  let provider = $state('')
  let reason = $state('')
  let note = $state('')

  // Both sections start collapsed and empty — most visits are logged after
  // the fact with no cuff at hand and no new prescription, and a collapsed,
  // untouched section must emit nothing.
  function newVitalRow(): VisitVitalRow {
    const bp = VITALS[0]
    return { vital: bp, systolic: '', diastolic: '', single: '', unit: bp.units[0].unit }
  }

  let vitalsOpen = $state(false)
  let vitalRows = $state<VisitVitalRow[]>([newVitalRow()])

  function pickVital(row: VisitVitalRow, vital: VitalDef) {
    row.vital = vital
    row.unit = vital.units[0].unit
    row.systolic = ''
    row.diastolic = ''
    row.single = ''
  }

  function addVitalRow() {
    vitalRows = [...vitalRows, newVitalRow()]
  }

  function removeVitalRow(i: number) {
    vitalRows = vitalRows.filter((_, idx) => idx !== i)
  }

  function newMedRow(): VisitMedRow {
    return { name: '', dose: '', doseUnit: 'mg' }
  }

  let medsOpen = $state(false)
  let medRows = $state<VisitMedRow[]>([newMedRow()])

  function addMedRow() {
    medRows = [...medRows, newMedRow()]
  }

  function removeMedRow(i: number) {
    medRows = medRows.filter((_, idx) => idx !== i)
  }

  // The four clinical-history sections are one free-text field each (two for
  // allergies), so a blank row has no malformed case — unlike vitals/meds,
  // their assemblers never return null and there is nothing to guard here.
  function newConditionRow(): VisitConditionRow {
    return { name: '' }
  }

  let conditionsOpen = $state(false)
  let conditionRows = $state<VisitConditionRow[]>([newConditionRow()])

  function addConditionRow() {
    conditionRows = [...conditionRows, newConditionRow()]
  }

  function removeConditionRow(i: number) {
    conditionRows = conditionRows.filter((_, idx) => idx !== i)
  }

  function newProcedureRow(): VisitProcedureRow {
    return { name: '' }
  }

  let proceduresOpen = $state(false)
  let procedureRows = $state<VisitProcedureRow[]>([newProcedureRow()])

  function addProcedureRow() {
    procedureRows = [...procedureRows, newProcedureRow()]
  }

  function removeProcedureRow(i: number) {
    procedureRows = procedureRows.filter((_, idx) => idx !== i)
  }

  function newImmunizationRow(): VisitImmunizationRow {
    return { name: '' }
  }

  let immunizationsOpen = $state(false)
  let immunizationRows = $state<VisitImmunizationRow[]>([newImmunizationRow()])

  function addImmunizationRow() {
    immunizationRows = [...immunizationRows, newImmunizationRow()]
  }

  function removeImmunizationRow(i: number) {
    immunizationRows = immunizationRows.filter((_, idx) => idx !== i)
  }

  function newAllergyRow(): VisitAllergyRow {
    return { substance: '', reaction: '' }
  }

  let allergiesOpen = $state(false)
  let allergyRows = $state<VisitAllergyRow[]>([newAllergyRow()])

  function addAllergyRow() {
    allergyRows = [...allergyRows, newAllergyRow()]
  }

  function removeAllergyRow(i: number) {
    allergyRows = allergyRows.filter((_, idx) => idx !== i)
  }

  function buildDrafts(effectiveAt: string): Draft[] | null {
    if (!provider.trim()) return null
    const drafts = [encounterDraft(provider, reason, effectiveAt)]
    const body = note.trim()
    if (body) drafts.push(noteDraft(body, effectiveAt))

    if (vitalsOpen) {
      const vitals = visitVitalsDrafts(vitalRows, effectiveAt)
      if (vitals === null) return null
      drafts.push(...vitals)
    }

    if (medsOpen) {
      const meds = visitMedsDrafts(medRows, effectiveAt)
      if (meds === null) return null
      drafts.push(...meds)
    }

    if (conditionsOpen) drafts.push(...visitConditionsDrafts(conditionRows, effectiveAt))
    if (proceduresOpen) drafts.push(...visitProceduresDrafts(procedureRows, effectiveAt))
    if (immunizationsOpen) drafts.push(...visitImmunizationsDrafts(immunizationRows, effectiveAt))
    if (allergiesOpen) drafts.push(...visitAllergiesDrafts(allergyRows, effectiveAt))

    return drafts
  }

  function favoriteLabel(): string {
    const name = provider.trim()
    const why = reason.trim()
    return why ? `${name} — ${why}` : name
  }

  function onReset() {
    provider = ''
    reason = ''
    note = ''
    vitalsOpen = false
    vitalRows = [newVitalRow()]
    medsOpen = false
    medRows = [newMedRow()]
    conditionsOpen = false
    conditionRows = [newConditionRow()]
    proceduresOpen = false
    procedureRows = [newProcedureRow()]
    immunizationsOpen = false
    immunizationRows = [newImmunizationRow()]
    allergiesOpen = false
    allergyRows = [newAllergyRow()]
  }

  function onPrefill(templates: DraftTemplate[]) {
    // Recents/favorites carry the whole "provider — reason" text; prefill it as
    // the provider so re-saving reproduces the identical value (same content id
    // shape), rather than lossily re-parsing it into fields — same as MedForm.
    const visit = templates.find((t) => t.kind === 'encounter')
    if (visit && visit.value && 'text' in visit.value) {
      provider = visit.value.text
      reason = ''
    }
    const body = templates.find((t) => t.kind === 'document')
    note = body && body.value && 'text' in body.value ? body.value.text : ''
  }
</script>

<LogShell title="Visit" category="clinical" {buildDrafts} {favoriteLabel} {onPrefill} {onReset}>
  <label class="field">
    Provider
    <input
      bind:value={provider}
      autocomplete="off"
      placeholder="Dr. Sharma"
      data-testid="visit-provider"
    />
  </label>

  <label class="field">
    Reason <span class="optional">(optional)</span>
    <input
      bind:value={reason}
      autocomplete="off"
      placeholder="cardiology follow-up"
      data-testid="visit-reason"
    />
  </label>

  <label class="field">
    Note <span class="optional">(optional)</span>
    <textarea
      bind:value={note}
      placeholder="What was said, what happens next"
      data-testid="visit-note"
    ></textarea>
  </label>

  <div class="section">
    <div class="section-head">
      <span class="section-label">Vitals <span class="optional">(optional)</span></span>
      <button
        type="button"
        class="ghost collapse-toggle"
        aria-expanded={vitalsOpen}
        onclick={() => (vitalsOpen = !vitalsOpen)}
        data-testid="visit-vitals-toggle"
      >
        {vitalsOpen ? 'Hide' : 'Add'}
      </button>
    </div>

    {#if vitalsOpen}
      {#each vitalRows as row, i (i)}
        <div class="row" data-testid="visit-vital-row">
          <div class="segments" role="radiogroup" aria-label="Vital type">
            {#each VITALS as vital (vital.key)}
              <button
                type="button"
                role="radio"
                aria-checked={row.vital.key === vital.key}
                onclick={() => pickVital(row, vital)}
                data-testid="visit-vital-{i}-{vital.key}"
              >
                {vital.label}
              </button>
            {/each}
          </div>

          {#if row.vital.key === 'bp'}
            <div class="pair">
              <label>
                Systolic
                <input
                  bind:value={row.systolic}
                  inputmode="numeric"
                  autocomplete="off"
                  placeholder="118"
                  data-testid="visit-vital-{i}-systolic"
                />
              </label>
              <span class="slash" aria-hidden="true">/</span>
              <label>
                Diastolic
                <input
                  bind:value={row.diastolic}
                  inputmode="numeric"
                  autocomplete="off"
                  placeholder="76"
                  data-testid="visit-vital-{i}-diastolic"
                />
              </label>
              <span class="unit muted">mm[Hg]</span>
            </div>
          {:else}
            <div class="pair">
              <label>
                {row.vital.label}
                <input
                  bind:value={row.single}
                  inputmode={row.vital.decimals === 0 ? 'numeric' : 'decimal'}
                  autocomplete="off"
                  data-testid="visit-vital-{i}-value"
                />
              </label>
              {#if row.vital.units.length > 1}
                <div class="unit-toggle" role="radiogroup" aria-label="Unit">
                  {#each row.vital.units as u (u.unit.code)}
                    <button
                      type="button"
                      role="radio"
                      aria-checked={row.unit.code === u.unit.code}
                      onclick={() => (row.unit = u.unit)}
                      data-testid="visit-vital-{i}-unit-{u.unit.code}"
                    >
                      {u.unit.code}
                    </button>
                  {/each}
                </div>
              {:else}
                <span class="unit muted">{row.unit.code}</span>
              {/if}
            </div>
          {/if}

          {#if vitalRows.length > 1}
            <button
              type="button"
              class="ghost remove-row"
              onclick={() => removeVitalRow(i)}
              data-testid="visit-vital-{i}-remove"
            >
              Remove
            </button>
          {/if}
        </div>
      {/each}

      <button type="button" class="ghost" onclick={addVitalRow} data-testid="visit-vitals-add">
        Add another vital
      </button>
    {/if}
  </div>

  <div class="section">
    <div class="section-head">
      <span class="section-label">Medications now taking <span class="optional">(optional)</span></span>
      <button
        type="button"
        class="ghost collapse-toggle"
        aria-expanded={medsOpen}
        onclick={() => (medsOpen = !medsOpen)}
        data-testid="visit-meds-toggle"
      >
        {medsOpen ? 'Hide' : 'Add'}
      </button>
    </div>

    {#if medsOpen}
      {#each medRows as row, i (i)}
        <div class="row" data-testid="visit-med-row">
          <label class="field">
            Medication
            <input
              bind:value={row.name}
              autocomplete="off"
              placeholder="ibuprofen"
              data-testid="visit-med-{i}-name"
            />
          </label>

          <div class="dose">
            <label class="field">
              Dose (optional)
              <input
                bind:value={row.dose}
                inputmode="decimal"
                autocomplete="off"
                placeholder="400"
                data-testid="visit-med-{i}-dose"
              />
            </label>
            <label class="field">
              Unit
              <select bind:value={row.doseUnit} data-testid="visit-med-{i}-dose-unit">
                {#each DOSE_UNITS as u (u)}
                  <option value={u}>{u}</option>
                {/each}
              </select>
            </label>
          </div>

          {#if medRows.length > 1}
            <button
              type="button"
              class="ghost remove-row"
              onclick={() => removeMedRow(i)}
              data-testid="visit-med-{i}-remove"
            >
              Remove
            </button>
          {/if}
        </div>
      {/each}

      <button type="button" class="ghost" onclick={addMedRow} data-testid="visit-meds-add">
        Add another medication
      </button>
    {/if}
  </div>

  <div class="section">
    <div class="section-head">
      <span class="section-label">Diagnoses <span class="optional">(optional)</span></span>
      <button
        type="button"
        class="ghost collapse-toggle"
        aria-expanded={conditionsOpen}
        onclick={() => (conditionsOpen = !conditionsOpen)}
        data-testid="visit-conditions-toggle"
      >
        {conditionsOpen ? 'Hide' : 'Add'}
      </button>
    </div>

    {#if conditionsOpen}
      {#each conditionRows as row, i (i)}
        <div class="row" data-testid="visit-condition-row">
          <label class="field">
            Diagnosis
            <input
              bind:value={row.name}
              autocomplete="off"
              placeholder="sinus infection"
              data-testid="visit-condition-{i}-name"
            />
          </label>

          {#if conditionRows.length > 1}
            <button
              type="button"
              class="ghost remove-row"
              onclick={() => removeConditionRow(i)}
              data-testid="visit-condition-{i}-remove"
            >
              Remove
            </button>
          {/if}
        </div>
      {/each}

      <button
        type="button"
        class="ghost"
        onclick={addConditionRow}
        data-testid="visit-conditions-add"
      >
        Add another diagnosis
      </button>
    {/if}
  </div>

  <div class="section">
    <div class="section-head">
      <span class="section-label">Procedures <span class="optional">(optional)</span></span>
      <button
        type="button"
        class="ghost collapse-toggle"
        aria-expanded={proceduresOpen}
        onclick={() => (proceduresOpen = !proceduresOpen)}
        data-testid="visit-procedures-toggle"
      >
        {proceduresOpen ? 'Hide' : 'Add'}
      </button>
    </div>

    {#if proceduresOpen}
      {#each procedureRows as row, i (i)}
        <div class="row" data-testid="visit-procedure-row">
          <label class="field">
            Procedure
            <input
              bind:value={row.name}
              autocomplete="off"
              placeholder="mole removal"
              data-testid="visit-procedure-{i}-name"
            />
          </label>

          {#if procedureRows.length > 1}
            <button
              type="button"
              class="ghost remove-row"
              onclick={() => removeProcedureRow(i)}
              data-testid="visit-procedure-{i}-remove"
            >
              Remove
            </button>
          {/if}
        </div>
      {/each}

      <button
        type="button"
        class="ghost"
        onclick={addProcedureRow}
        data-testid="visit-procedures-add"
      >
        Add another procedure
      </button>
    {/if}
  </div>

  <div class="section">
    <div class="section-head">
      <span class="section-label">Immunizations <span class="optional">(optional)</span></span>
      <button
        type="button"
        class="ghost collapse-toggle"
        aria-expanded={immunizationsOpen}
        onclick={() => (immunizationsOpen = !immunizationsOpen)}
        data-testid="visit-immunizations-toggle"
      >
        {immunizationsOpen ? 'Hide' : 'Add'}
      </button>
    </div>

    {#if immunizationsOpen}
      {#each immunizationRows as row, i (i)}
        <div class="row" data-testid="visit-immunization-row">
          <label class="field">
            Immunization
            <input
              bind:value={row.name}
              autocomplete="off"
              placeholder="flu shot"
              data-testid="visit-immunization-{i}-name"
            />
          </label>

          {#if immunizationRows.length > 1}
            <button
              type="button"
              class="ghost remove-row"
              onclick={() => removeImmunizationRow(i)}
              data-testid="visit-immunization-{i}-remove"
            >
              Remove
            </button>
          {/if}
        </div>
      {/each}

      <button
        type="button"
        class="ghost"
        onclick={addImmunizationRow}
        data-testid="visit-immunizations-add"
      >
        Add another immunization
      </button>
    {/if}
  </div>

  <div class="section">
    <div class="section-head">
      <span class="section-label">Allergies <span class="optional">(optional)</span></span>
      <button
        type="button"
        class="ghost collapse-toggle"
        aria-expanded={allergiesOpen}
        onclick={() => (allergiesOpen = !allergiesOpen)}
        data-testid="visit-allergies-toggle"
      >
        {allergiesOpen ? 'Hide' : 'Add'}
      </button>
    </div>

    {#if allergiesOpen}
      {#each allergyRows as row, i (i)}
        <div class="row" data-testid="visit-allergy-row">
          <label class="field">
            Substance
            <input
              bind:value={row.substance}
              autocomplete="off"
              placeholder="peanuts"
              data-testid="visit-allergy-{i}-substance"
            />
          </label>
          <label class="field">
            Reaction <span class="optional">(optional)</span>
            <input
              bind:value={row.reaction}
              autocomplete="off"
              placeholder="hives"
              data-testid="visit-allergy-{i}-reaction"
            />
          </label>

          {#if allergyRows.length > 1}
            <button
              type="button"
              class="ghost remove-row"
              onclick={() => removeAllergyRow(i)}
              data-testid="visit-allergy-{i}-remove"
            >
              Remove
            </button>
          {/if}
        </div>
      {/each}

      <button
        type="button"
        class="ghost"
        onclick={addAllergyRow}
        data-testid="visit-allergies-add"
      >
        Add another allergy
      </button>
    {/if}
  </div>
</LogShell>

<style>
  .optional {
    opacity: 0.6;
  }

  .section {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    padding-top: var(--space-2);
    border-top: 1px solid var(--border);
  }

  .section-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-2);
  }

  .section-label {
    font-size: var(--text-sm);
    color: var(--muted);
  }

  .collapse-toggle {
    min-height: auto;
    padding: var(--space-1) var(--space-3);
    font-size: var(--text-sm);
  }

  .row {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    padding: var(--space-3);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
  }

  .remove-row {
    align-self: flex-start;
    min-height: auto;
    padding: var(--space-1) var(--space-2);
    font-size: var(--text-xs);
    color: var(--muted);
  }

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

  .dose {
    display: flex;
    gap: var(--space-3);
    align-items: flex-end;
  }

  .dose select {
    min-height: 44px;
    padding: var(--space-2) var(--space-3);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--surface);
  }
</style>
