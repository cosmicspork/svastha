<script lang="ts">
  import { onMount } from 'svelte'
  import { allEvents, type StoredEvent } from '../lib/events'
  import { allCurationByPrefix } from '../lib/curation'
  import { buildSummary } from '../lib/summary'
  import SummarySection from './SummarySection.svelte'

  // Same contract as Spine.svelte: `readonly` (the person screen, over a
  // share's cached events) supplies its own already-loaded events and skips the
  // own-vault fetch and all curation reads — curation (including hides) is
  // owner-only in v1 (see docs/ARCHITECTURE.md, "Sync and backup").
  let {
    events: providedEvents,
    readonly = false,
  }: { events?: StoredEvent[]; readonly?: boolean } = $props()

  let ownEvents = $state<StoredEvent[]>([])
  let hiddenIds = $state<Set<string>>(new Set())
  let loaded = $state(false)

  const events = $derived(readonly ? (providedEvents ?? []) : ownEvents)
  const summary = $derived(buildSummary(events, readonly ? {} : { hiddenIds }))

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

    <SummarySection title="Problems" rows={summary.problems} hueClass="cat-clinical" />
    <SummarySection title="Medications" rows={summary.medications} hueClass="cat-med" />
    <SummarySection
      title="Allergies"
      rows={summary.allergies}
      hueClass="cat-symptom"
      alwaysShow
      emptyText="None recorded"
    />
    <SummarySection title="Immunizations" rows={summary.immunizations} hueClass="cat-clinical" />
    <SummarySection title="Latest vitals" rows={summary.latestVitals} hueClass="cat-vital" />
    <SummarySection title="Recent results" rows={summary.recentResults} hueClass="cat-clinical" />

    <p class="coverage muted" data-testid="summary-coverage">
      Summary of structured records imported from source documents. Narrative notes and entries the
      source left uncoded are not included.
    </p>
  </div>
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

  .coverage {
    margin: var(--space-5) 0 0;
    font-size: var(--text-xs);
    line-height: 1.5;
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
    .summary :global(.detail),
    .summary :global(.date),
    .summary :global(.count),
    .coverage {
      color: #000;
    }
  }
</style>
