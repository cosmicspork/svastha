<script lang="ts">
  import { onMount } from 'svelte'
  import { allEvents, type StoredEvent } from '../lib/events'
  import {
    allCurationByPrefix,
    allStatuses,
    allNames,
    setStatus,
    setName,
    type ConceptStatus,
  } from '../lib/curation'
  import { buildSummary, type SummaryRow } from '../lib/summary'
  import { loadDictionaryIndex, dictionaryStatus } from '../lib/dictionary'
  import SummarySection from './SummarySection.svelte'
  import Sheet from './Sheet.svelte'

  // Same contract as Spine.svelte: `readonly` (the person screen, or a doctor
  // share opened cold) supplies its own already-loaded events and skips the
  // own-vault fetch and all local curation reads. A read-only view never reads
  // the local `cur-*` store (curation is owner-only in v1 — see
  // docs/ARCHITECTURE.md, "Curation overlay"), but a doctor-share recipient MAY
  // be handed the owner's `status:`/`name:` overlay for the shared concepts,
  // already verified, via `status`/`names` — so it renders the same Current/Past
  // and Active/Resolved grouping and name overrides the owner sees, just inert
  // (no action sheet). Person-view (no maps) shows a single current/active
  // group, as before.
  let {
    events: providedEvents,
    readonly = false,
    status: providedStatus,
    names: providedNames,
  }: {
    events?: StoredEvent[]
    readonly?: boolean
    status?: Map<string, ConceptStatus>
    names?: Map<string, string>
  } = $props()

  let ownEvents = $state<StoredEvent[]>([])
  let hiddenIds = $state<Set<string>>(new Set())
  let statusMap = $state<Map<string, ConceptStatus>>(new Map())
  let nameMap = $state<Map<string, string>>(new Map())
  let loaded = $state(false)

  const events = $derived(readonly ? (providedEvents ?? []) : ownEvents)
  // In read-only mode the status/name overlay is whatever the caller passed
  // (a share's verified curation, or nothing); otherwise it's this device's own
  // loaded curation.
  const effectiveStatus = $derived(readonly ? (providedStatus ?? new Map()) : statusMap)
  const effectiveNames = $derived(readonly ? (providedNames ?? new Map()) : nameMap)

  // The offline code dictionary (see lib/dictionary.ts): empty unless enabled.
  // Hydrated once and re-hydrated when the Settings toggle bumps the version.
  let dictionary = $state<Map<string, string>>(new Map())
  $effect(() => {
    void $dictionaryStatus.version
    void $dictionaryStatus.enabled
    void loadDictionaryIndex().then((d) => (dictionary = d))
  })

  const summary = $derived(
    buildSummary(events, {
      // Hides are a device-local redaction, never applied to someone else's
      // shared record; only the own-vault render folds them.
      hiddenIds: readonly ? undefined : hiddenIds,
      dictionary,
      status: effectiveStatus,
      names: effectiveNames,
    }),
  )

  // Meds split into current / past; problems into active / resolved. Same
  // underlying `status` ('active' | 'inactive'), different clinician wording.
  // Without a status overlay (Person view, or a share that carried none) every
  // row is 'active', so "past"/"resolved" stay empty and their groups don't
  // render.
  const currentMeds = $derived(summary.medications.filter((r) => r.status === 'active'))
  const pastMeds = $derived(summary.medications.filter((r) => r.status === 'inactive'))
  const activeProblems = $derived(summary.problems.filter((r) => r.status === 'active'))
  const resolvedProblems = $derived(summary.problems.filter((r) => r.status === 'inactive'))

  let pastMedsOpen = $state(false)
  let resolvedOpen = $state(false)

  // The row-action sheet: which row was tapped and which section it belongs to
  // (meds vs. problems drives the status wording). Null when closed.
  type Section = 'med' | 'problem'
  let action = $state<{ row: SummaryRow; section: Section } | null>(null)
  let nameField = $state('')

  function openAction(row: SummaryRow, section: Section) {
    nameField = nameMap.get(row.key) ?? ''
    action = { row, section }
  }

  function closeAction() {
    action = null
  }

  /** Re-read the status/name overlay after a write so the derived summary
   * re-splits and re-labels — the same way the dictionary effect re-hydrates. */
  async function reloadCuration() {
    ;[statusMap, nameMap] = await Promise.all([allStatuses(), allNames()])
  }

  async function toggleStatus(row: SummaryRow) {
    await setStatus(row.key, row.status === 'active' ? 'inactive' : 'active')
    await reloadCuration()
    closeAction()
  }

  async function saveName(row: SummaryRow) {
    // An empty field clears the override (stored as an empty display, not a
    // delete — see curation.ts's `setName`), falling back to the resolved name.
    await setName(row.key, nameField)
    await reloadCuration()
    closeAction()
  }

  /** date-part only, parsed as local midnight to avoid a timezone shift on a
   * date-only fact — same convention SummarySection uses. */
  function fmtDate(iso: string): string {
    const d = new Date(`${iso.slice(0, 10)}T00:00:00`)
    return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
  }

  onMount(async () => {
    if (readonly) {
      loaded = true
      return
    }
    ownEvents = await allEvents()
    // Fold the same hides the spine honors, so a redacted entry stays out of
    // the summary too (silently — no placeholder).
    const hideRecords = await allCurationByPrefix('hide:')
    hiddenIds = new Set(
      hideRecords
        .filter((r) => (r.value as { hidden?: boolean } | undefined)?.hidden === true)
        .map((r) => r.key.slice('hide:'.length)),
    )
    await reloadCuration()
    loaded = true
  })
</script>

{#if loaded}
  <div class="summary" data-testid="clinician-summary">
    <div class="toolbar">
      <button type="button" class="ghost print-btn" onclick={() => window.print()} data-testid="summary-print">
        Print
      </button>
    </div>

    <!-- Problems: Active (always shown) then a collapsed Resolved group. The
         same layout for owner and recipient; a recipient's rows are inert
         (no onrowtap) and the collapsed group appears only when the share
         carried a resolved-problem status record. -->
    <div class="split-group">
      <SummarySection
        title="Problems"
        rows={activeProblems}
        hueClass="cat-clinical"
        alwaysShow
        emptyText="None recorded"
        dictionaryEnabled={$dictionaryStatus.enabled}
        {readonly}
        onrowtap={readonly ? undefined : (row) => openAction(row, 'problem')}
      />
      {#if resolvedProblems.length > 0}
        <button
          type="button"
          class="ghost collapse-toggle"
          aria-expanded={resolvedOpen}
          onclick={() => (resolvedOpen = !resolvedOpen)}
          data-testid="problems-resolved-toggle"
        >
          {resolvedOpen ? 'Hide' : 'Show'}
          {resolvedProblems.length} resolved
        </button>
        {#if resolvedOpen}
          <SummarySection
            title="Resolved"
            rows={resolvedProblems}
            hueClass="cat-clinical"
            heading="h3"
            dictionaryEnabled={$dictionaryStatus.enabled}
            {readonly}
            onrowtap={readonly ? undefined : (row) => openAction(row, 'problem')}
          />
        {/if}
      {/if}
    </div>

    <!-- Medications: Current (always shown) then a collapsed Past group. -->
    <div class="split-group">
      <SummarySection
        title="Medications"
        rows={currentMeds}
        hueClass="cat-med"
        alwaysShow
        emptyText="None recorded"
        dictionaryEnabled={$dictionaryStatus.enabled}
        {readonly}
        onrowtap={readonly ? undefined : (row) => openAction(row, 'med')}
      />
      {#if pastMeds.length > 0}
        <button
          type="button"
          class="ghost collapse-toggle"
          aria-expanded={pastMedsOpen}
          onclick={() => (pastMedsOpen = !pastMedsOpen)}
          data-testid="meds-past-toggle"
        >
          {pastMedsOpen ? 'Hide' : 'Show'}
          {pastMeds.length} past
        </button>
        {#if pastMedsOpen}
          <SummarySection
            title="Past"
            rows={pastMeds}
            hueClass="cat-med"
            heading="h3"
            dictionaryEnabled={$dictionaryStatus.enabled}
            {readonly}
            onrowtap={readonly ? undefined : (row) => openAction(row, 'med')}
          />
        {/if}
      {/if}
    </div>
    <SummarySection
      title="Allergies"
      rows={summary.allergies}
      hueClass="cat-symptom"
      alwaysShow
      emptyText="None recorded"
      dictionaryEnabled={$dictionaryStatus.enabled}
      {readonly}
    />
    <SummarySection
      title="Immunizations"
      rows={summary.immunizations}
      hueClass="cat-clinical"
      dictionaryEnabled={$dictionaryStatus.enabled}
      {readonly}
    />
    <SummarySection
      title="Latest vitals"
      rows={summary.latestVitals}
      hueClass="cat-vital"
      dictionaryEnabled={$dictionaryStatus.enabled}
      {readonly}
    />
    <SummarySection
      title="Recent results"
      rows={summary.recentResults}
      hueClass="cat-clinical"
      dictionaryEnabled={$dictionaryStatus.enabled}
      {readonly}
    />

    {#if summary.cycle}
      <section class="section cycle-section" data-testid="summary-section-cycle">
        <h2 class="section-head">
          <span class="dot cat-cycle" aria-hidden="true"></span>
          Cycle
        </h2>
        <ul class="rows">
          {#if summary.cycle.lastStartIso}
            <li class="row" data-testid="cycle-last-start">
              <span class="label">Last period started</span>
              <span class="detail data">{fmtDate(summary.cycle.lastStartIso)} · day {summary.cycle.currentDay}</span>
            </li>
          {/if}
          {#if summary.cycle.medianLength !== null}
            <li class="row" data-testid="cycle-length">
              <span class="label">Cycle length</span>
              <span class="detail data"
                >{summary.cycle.medianLength} days median ({summary.cycle.minLength}–{summary.cycle
                  .maxLength})</span
              >
            </li>
          {:else}
            <li class="row" data-testid="cycle-insufficient">
              <span class="note muted">Not enough recorded cycles for length statistics yet.</span>
            </li>
          {/if}
          {#if summary.cycle.typicalPeriodDays !== null}
            <li class="row" data-testid="cycle-duration">
              <span class="label">Period duration</span>
              <span class="detail data">{summary.cycle.typicalPeriodDays} days typical</span>
            </li>
          {/if}
        </ul>
        <p class="cycle-footer muted" data-testid="cycle-footer">
          Based on {summary.cycle.cycleCount} recorded {summary.cycle.cycleCount === 1
            ? 'cycle'
            : 'cycles'}.
        </p>
      </section>
    {/if}

    <p class="coverage muted" data-testid="summary-coverage">
      Summary of structured records imported from source documents. Narrative notes and entries the
      source left uncoded are not included.
    </p>
  </div>

  {#if action && !readonly}
    {@const row = action.row}
    {@const isMed = action.section === 'med'}
    <Sheet onclose={closeAction}>
      <div class="action-sheet" data-testid="row-action-sheet">
        <h2 class="action-title">{row.label}</h2>

        <button type="button" class="tonal action" onclick={() => toggleStatus(row)} data-testid="action-toggle-status">
          {#if row.status === 'active'}
            {isMed ? 'Mark as past' : 'Mark as resolved'}
          {:else}
            {isMed ? 'Mark as current' : 'Mark as active'}
          {/if}
        </button>

        <label class="name-field">
          <span class="name-label">Edit name</span>
          <input type="text" bind:value={nameField} placeholder={row.label} data-testid="action-name-input" />
          <span class="name-hint muted">Clear the field to remove a custom name.</span>
        </label>

        <div class="action-buttons">
          <button type="button" class="ghost" onclick={closeAction} data-testid="action-cancel">Cancel</button>
          <button type="button" class="primary" onclick={() => saveName(row)} data-testid="action-save-name">
            Save name
          </button>
        </div>
      </div>
    </Sheet>
  {/if}
{/if}

<style>
  .toolbar {
    display: flex;
    justify-content: flex-end;
    margin-bottom: var(--space-3);
  }

  .print-btn {
    min-height: 36px;
    min-width: 0;
    font-size: var(--text-sm);
  }

  /* The Current+Past / Active+Resolved pairing: the inner SummarySection
     already carries the section's bottom margin, so the group is a bare wrapper
     that keeps the collapsed group's toggle and rows tucked under their parent. */
  .split-group {
    margin-bottom: var(--space-5);
  }

  .split-group :global(.section) {
    margin-bottom: var(--space-2);
  }

  .collapse-toggle {
    min-height: 36px;
    padding: var(--space-1) var(--space-2);
    font-size: var(--text-sm);
    margin-bottom: var(--space-2);
  }

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

  .action-buttons {
    display: flex;
    justify-content: flex-end;
    gap: var(--space-2);
  }

  .coverage {
    margin: var(--space-5) 0 0;
    font-size: var(--text-xs);
    line-height: 1.5;
  }

  /* The cycle section is bespoke (labelled stat rows, not the generic
     SummarySection folds), so it carries its own copy of the section idiom —
     dot + display heading + baseline-aligned rows — to match the sections above
     it. Class names mirror SummarySection so the @media print rules below reach
     it too. */
  .cycle-section {
    margin-bottom: var(--space-5);
  }

  .cycle-section .section-head {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    font-family: var(--font-display);
    font-size: var(--text-lg);
    margin-bottom: var(--space-2);
  }

  .cycle-section .dot {
    flex: none;
    width: 10px;
    height: 10px;
    border-radius: 50%;
    background: currentColor;
  }

  .cycle-section .rows {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
  }

  .cycle-section .row {
    display: flex;
    align-items: baseline;
    flex-wrap: wrap;
    gap: var(--space-2);
    padding: var(--space-1) 0;
    border-bottom: 1px solid var(--border);
  }

  .cycle-section .detail {
    margin-left: auto;
    flex: none;
  }

  .cycle-section .note {
    font-size: var(--text-sm);
  }

  .cycle-footer {
    margin: var(--space-2) 0 0;
    font-size: var(--text-xs);
  }

  /* Print: a clean black-on-white handoff regardless of theme, one section per
     unbroken block, and none of the app chrome (nav, the log FAB, the view
     toggle, the print button itself, tag chips). The :global rules reach the
     chrome that lives outside this component; they only apply while the summary
     view — and thus this component — is mounted. */
  @media print {
    :global(body) {
      background: #fff;
      color: #000;
    }
    :global(.fab),
    :global(.layer),
    :global(.settings-nav),
    :global(.seg),
    :global(.switcher),
    :global(.tag-chip) {
      display: none !important;
    }
    .print-btn {
      display: none;
    }
    .summary :global(.section) {
      break-inside: avoid;
    }
    .summary :global(.section-head),
    .summary :global(.label),
    .summary :global(.code),
    .summary :global(.hint),
    .summary :global(.detail),
    .summary :global(.date),
    .summary :global(.count),
    .cycle-section .note,
    .cycle-footer,
    .coverage {
      color: #000;
    }
  }
</style>
