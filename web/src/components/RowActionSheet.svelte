<script lang="ts">
  import { untrack } from 'svelte'
  import {
    setStatus,
    setName,
    setRegimen,
    setPriority,
    setAllergy,
    allergyChanged,
    normalizeAllergy,
    ALLERGY_CATEGORIES,
    ALLERGY_CATEGORY_LABELS,
    ALLERGY_SEVERITIES,
    ALLERGY_REACTION_MAX,
    regimenChanged,
    normalizeRegimen,
    REGIMEN_ROUTES,
    REGIMEN_ROUTE_LABELS,
    type Regimen,
    type AllergyDetails,
    type AllergyCategory,
    type AllergySeverity,
    type ConceptPriority,
  } from '../lib/curation'
  import type { SummaryRow } from '../lib/summary'
  import Sheet from './Sheet.svelte'

  // The owner-only curation sheet for one folded concept: status (meds and
  // problems), priority (problems and allergies), display name, and (meds only)
  // the regimen. Extracted from ClinicianSummary so the
  // medications page opens the same sheet rather than a second, drifting copy —
  // every write path through curation.ts stays in one component.
  let {
    row,
    section,
    name = '',
    regimen,
    allergy,
    priority = '',
    onclose,
    onsaved,
  }: {
    row: SummaryRow
    /** Which controls the sheet offers: meds, problems and jobs carry a status
     * (problems resolve; meds and jobs become past), problems and allergies a
     * priority, meds a regimen. */
    section: 'med' | 'problem' | 'allergy' | 'work'
    /** The concept's current name override, `''` when there is none. */
    name?: string
    /** The concept's current regimen, seeded into the fields on open. */
    regimen?: Regimen
    /** The allergy's recorded details, seeded into the fields on open. */
    allergy?: AllergyDetails
    /** The concept's current priority, `''` (normal) when there is none. */
    priority?: ConceptPriority
    onclose: () => void
    /** Re-read the curation overlay after a write. Awaited before the sheet
     * closes, because curation does not push: nothing else tells the host its
     * derived summary is stale. */
    onsaved: () => Promise<void>
  } = $props()

  const isMed = $derived(section === 'med')
  const hasStatus = $derived(section !== 'allergy')
  const hasPriority = $derived(section === 'problem' || section === 'allergy')
  const noun = $derived(section === 'allergy' ? 'allergies' : 'problems')

  const PRIORITY_CHOICES: { value: ConceptPriority; label: string }[] = [
    { value: '', label: 'Normal' },
    { value: 'pinned', label: 'Pin' },
    { value: 'hidden', label: 'Hide' },
  ]
  const isAllergy = $derived(section === 'allergy')
  const isProblem = $derived(section === 'problem')

  // Seeded once, at open: the sheet is a form over a snapshot, and the host
  // unmounts it on close rather than re-pointing it at another row. `untrack`
  // says that deliberately — a later prop change must not overwrite what the
  // owner has typed.
  let nameField = $state(untrack(() => name))
  let priorityField = $state<ConceptPriority>(untrack(() => priority))
  // `''` is the unset state for both pickers.
  let categoryField = $state<AllergyCategory | ''>(untrack(() => allergy?.category ?? ''))
  let severityField = $state<AllergySeverity | ''>(untrack(() => allergy?.severity ?? ''))
  let reactionField = $state(untrack(() => allergy?.reaction ?? ''))

  function allergyFromFields(): AllergyDetails | undefined {
    return normalizeAllergy({ category: categoryField, severity: severityField, reaction: reactionField })
  }

  /** The regimen fields, as the form holds them: all strings (an unset route is
   * `''`, not a missing key) plus the as-needed boolean, so every input can bind
   * directly. `regimenFromFields` turns them back into a {@link Regimen}. */
  let regimenFields = $state(
    untrack(() => ({
      dose: regimen?.dose ?? '',
      schedule: regimen?.schedule ?? '',
      route: regimen?.route ?? '',
      as_needed: regimen?.as_needed === true,
      prescriber: regimen?.prescriber ?? '',
      started: regimen?.started ?? '',
      stopped: regimen?.stopped ?? '',
      instructions: regimen?.instructions ?? '',
    })),
  )

  /** The form's fields as a normalized regimen (`undefined` when the owner left
   * or made it empty — the clear). Normalizing here means the comparison in
   * `save` and the value written to curation are the same shape. */
  function regimenFromFields(): Regimen | undefined {
    return normalizeRegimen(regimenFields)
  }

  async function toggleStatus() {
    await setStatus(row.key, row.status === 'active' ? 'inactive' : 'active')
    await onsaved()
    onclose()
  }

  /** Save the sheet: the name override, the priority (problems and allergies),
   * and (meds only) the regimen, each
   * written only when it actually changed. Both are mutable `cur-` blobs that
   * re-sync on every write, so an unchanged field must not be re-stamped. */
  async function save() {
    // An empty field clears the override (stored as an empty display, not a
    // delete — see curation.ts's `setName`), falling back to the resolved name.
    if (nameField.trim() !== name) await setName(row.key, nameField)
    if (hasPriority && priorityField !== priority) await setPriority(row.key, priorityField)
    if (isAllergy) {
      const next = allergyFromFields()
      if (allergyChanged(allergy, next)) await setAllergy(row.key, next ?? {})
    }
    if (isMed) {
      const next = regimenFromFields()
      if (regimenChanged(regimen, next)) await setRegimen(row.key, next ?? {})
    }
    await onsaved()
    onclose()
  }
</script>

<Sheet {onclose}>
  <div class="action-sheet" data-testid="row-action-sheet">
    <h2 class="action-title">{row.label}</h2>

    {#if hasStatus}
      <button type="button" class="tonal action" onclick={toggleStatus} data-testid="action-toggle-status">
        {#if row.status === 'active'}
          {isProblem ? 'Mark as resolved' : 'Mark as past'}
        {:else}
          {isProblem ? 'Mark as active' : 'Mark as current'}
        {/if}
      </button>
    {/if}

    {#if hasPriority}
      <div class="name-field">
        <span class="name-label" id="priority-label">On your summary</span>
        <div class="seg" role="group" aria-labelledby="priority-label" data-testid="action-priority">
          {#each PRIORITY_CHOICES as choice (choice.value)}
            <button
              type="button"
              aria-pressed={priorityField === choice.value}
              onclick={() => (priorityField = choice.value)}
              data-testid="action-priority-{choice.value || 'normal'}"
            >
              {choice.label}
            </button>
          {/each}
        </div>
        <!-- Honest about scope: a hide is a presentation choice for the
             owner's own summary and the doctor links they make, not a
             redaction — the events stay, and a caregiver grant still sees
             them. -->
        <span class="name-hint muted" data-testid="action-priority-hint">
          {#if priorityField === 'hidden'}
            Hidden {noun} stay on your timeline. They leave this summary{section === 'allergy'
              ? ', your pharmacy list,'
              : ''} and any doctor link you make. People you've granted access to your record still see
            them.
          {:else}
            Pinned {noun} lead the list, here and on any doctor link you make.
          {/if}
        </span>
      </div>
    {/if}

    {#if isAllergy}
      <!-- Import drops all three, and the category is never guessed from the
           code system, so this is the owner's own record. Unset is a real
           choice: it is how a wrong pick is taken back. -->
      <div class="name-field">
        <span class="name-label" id="allergy-category-label">Category</span>
        <div class="seg" role="group" aria-labelledby="allergy-category-label" data-testid="action-allergy-category">
          <button
            type="button"
            aria-pressed={categoryField === ''}
            onclick={() => (categoryField = '')}
            data-testid="action-allergy-category-unset"
          >
            Not set
          </button>
          {#each ALLERGY_CATEGORIES as c (c)}
            <button
              type="button"
              aria-pressed={categoryField === c}
              onclick={() => (categoryField = c)}
              data-testid="action-allergy-category-{c}"
            >
              {ALLERGY_CATEGORY_LABELS[c]}
            </button>
          {/each}
        </div>
      </div>

      <label class="name-field">
        <span class="name-label">Reaction</span>
        <input
          type="text"
          bind:value={reactionField}
          maxlength={ALLERGY_REACTION_MAX}
          placeholder="Hives, anaphylaxis"
          data-testid="action-allergy-reaction"
        />
      </label>

      <div class="name-field">
        <span class="name-label" id="allergy-severity-label">Severity</span>
        <div class="seg" role="group" aria-labelledby="allergy-severity-label" data-testid="action-allergy-severity">
          <button
            type="button"
            aria-pressed={severityField === ''}
            onclick={() => (severityField = '')}
            data-testid="action-allergy-severity-unset"
          >
            Not set
          </button>
          {#each ALLERGY_SEVERITIES as sev (sev)}
            <button
              type="button"
              aria-pressed={severityField === sev}
              onclick={() => (severityField = sev)}
              data-testid="action-allergy-severity-{sev}"
            >
              {sev[0].toUpperCase() + sev.slice(1)}
            </button>
          {/each}
        </div>
      </div>
    {/if}

    <label class="name-field">
      <span class="name-label">Edit name</span>
      <input type="text" bind:value={nameField} placeholder={row.label} data-testid="action-name-input" />
      <span class="name-hint muted">Clear the field to remove a custom name.</span>
    </label>

    {#if isMed}
      <!-- How this medication is actually taken. None of it comes from the
           event log — an imported `medication_statement` carries at most a
           dose quantity — so every field is the owner's own words, and an
           empty one stays empty rather than being guessed at. -->
      <div class="regimen-fields">
        <label class="name-field">
          <span class="name-label">Dose</span>
          <input type="text" bind:value={regimenFields.dose} placeholder="10 mg" data-testid="action-dose-input" />
        </label>

        <label class="name-field">
          <span class="name-label">Schedule</span>
          <input
            type="text"
            bind:value={regimenFields.schedule}
            placeholder="Twice daily"
            data-testid="action-schedule-input"
          />
        </label>

        <label class="name-field">
          <span class="name-label">Route</span>
          <select bind:value={regimenFields.route} data-testid="action-route-select">
            <option value="">—</option>
            {#each REGIMEN_ROUTES as route (route)}
              <option value={route}>{REGIMEN_ROUTE_LABELS[route]}</option>
            {/each}
          </select>
        </label>

        <label class="check-field">
          <input type="checkbox" bind:checked={regimenFields.as_needed} data-testid="action-as-needed" />
          <span class="name-label">As needed</span>
        </label>

        <label class="name-field">
          <span class="name-label">Prescriber</span>
          <input
            type="text"
            bind:value={regimenFields.prescriber}
            placeholder="Dr. Rivera"
            data-testid="action-prescriber-input"
          />
        </label>

        <div class="date-fields">
          <label class="name-field">
            <span class="name-label">Started</span>
            <input type="date" bind:value={regimenFields.started} data-testid="action-started-input" />
          </label>
          <label class="name-field">
            <span class="name-label">Stopped</span>
            <input type="date" bind:value={regimenFields.stopped} data-testid="action-stopped-input" />
          </label>
        </div>

        <label class="name-field">
          <span class="name-label">Instructions</span>
          <textarea
            rows="2"
            bind:value={regimenFields.instructions}
            placeholder="Take with food"
            data-testid="action-instructions-input"
          ></textarea>
        </label>
      </div>
    {/if}

    <div class="action-buttons">
      <button type="button" class="ghost" onclick={onclose} data-testid="action-cancel">Cancel</button>
      <button type="button" class="primary" onclick={save} data-testid="action-save">Save</button>
    </div>
  </div>
</Sheet>

<style>
  .action-sheet {
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
  }

  .action-title {
    font-family: var(--font-display);
    font-size: var(--text-lg);
    margin: 0;
    overflow-wrap: anywhere;
  }

  .action.tonal {
    width: 100%;
  }

  .name-field {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
  }

  .name-label {
    font-size: var(--text-sm);
  }

  .name-hint {
    font-size: var(--text-xs);
  }

  .regimen-fields {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }

  .check-field {
    display: flex;
    align-items: center;
    gap: var(--space-2);
  }

  /* Started/Stopped read as one course, and two date inputs fit a phone width
     side by side. */
  .date-fields {
    display: flex;
    gap: var(--space-3);
  }

  .date-fields .name-field {
    flex: 1;
    min-width: 0;
  }

  .action-buttons {
    display: flex;
    justify-content: flex-end;
    gap: var(--space-2);
  }
</style>
