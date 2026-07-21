<script lang="ts">
  import { onMount } from 'svelte'
  import { allEvents, type StoredEvent } from '../lib/events'
  import { allCurationByPrefix } from '../lib/curation'
  import { buildSummary } from '../lib/summary'
  import { loadDictionaryIndex, dictionaryStatus } from '../lib/dictionary'
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

  // The offline code dictionary (see lib/dictionary.ts): empty unless enabled.
  // Hydrated once and re-hydrated when the Settings toggle bumps the version.
  let dictionary = $state<Map<string, string>>(new Map())
  $effect(() => {
    void $dictionaryStatus.version
    void $dictionaryStatus.enabled
    void loadDictionaryIndex().then((d) => (dictionary = d))
  })

  const summary = $derived(
    buildSummary(events, readonly ? { dictionary } : { hiddenIds, dictionary }),
  )

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
