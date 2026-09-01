<script lang="ts">
  import { onMount } from 'svelte'
  import { allEvents, type StoredEvent } from '../lib/events'
  import {
    allCurationByPrefix,
    allStatuses,
    allNames,
    allRegimens,
    REGIMEN_ROUTE_LABELS,
    type ConceptStatus,
    type Regimen,
  } from '../lib/curation'
  import { buildSummary, shelveMedications, type SummaryRow } from '../lib/summary'
  import { loadDictionaryIndex, dictionaryStatus } from '../lib/dictionary'
  import { shortenSystem } from '../lib/codes'
  import { focusedEventId } from '../lib/spine-focus'
  import { navigate } from '../lib/router.svelte'
  import SummarySection from '../components/SummarySection.svelte'
  import RowActionSheet from '../components/RowActionSheet.svelte'

  // The whole med list on one screen, filed the way a person takes them: one
  // shelf per route, alphabetical within, past meds folded away. Owner-only in
  // v1 — it reads this device's curation, which a shared record has none of.

  let events = $state<StoredEvent[]>([])
  let hiddenIds = $state<Set<string>>(new Set())
  let statusMap = $state<Map<string, ConceptStatus>>(new Map())
  let nameMap = $state<Map<string, string>>(new Map())
  let regimenMap = $state<Map<string, Regimen>>(new Map())
  let loaded = $state(false)

  let dictionary = $state<Map<string, string>>(new Map())
  $effect(() => {
    void $dictionaryStatus.version
    void $dictionaryStatus.enabled
    void loadDictionaryIndex().then((d) => (dictionary = d))
  })

  const now = Date.now()

  // The page needs only `.medications`, but it goes through `buildSummary`
  // rather than reaching for the fold directly: `foldSection` is private, and
  // one folding path means a med reads identically here and on the summary.
  const summary = $derived(
    buildSummary(events, {
      now,
      hiddenIds,
      dictionary,
      status: statusMap,
      names: nameMap,
      regimen: regimenMap,
    }),
  )
  const shelves = $derived(shelveMedications(summary.medications))

  /** See ClinicianSummary: the systems the installed dictionary covers, so an
   * unnamed row's hint can be honest about whether an update could ever name it. */
  const coveredSystems = $derived(
    new Set(
      $dictionaryStatus.fileStatuses
        .filter((f) => f.state === 'verified')
        .map((f) => shortenSystem(f.system)),
    ),
  )

  let pastOpen = $state(false)

  let action = $state<SummaryRow | null>(null)

  /** Curation does not push: a write updates IndexedDB, and nothing tells this
   * page its derived shelves are stale. Re-reading after every save is what
   * moves a freshly-routed med onto its shelf. */
  async function reloadCuration() {
    ;[statusMap, nameMap, regimenMap] = await Promise.all([allStatuses(), allNames(), allRegimens()])
  }

  /** Focus first, navigate second: the spine reads `focusedEventId` as it
   * mounts, so setting it after the hash change lands on an unfocused timeline. */
  function viewOnTimeline(row: SummaryRow): void {
    focusedEventId.set(row.focusId)
    navigate('#/timeline')
  }

  onMount(async () => {
    events = await allEvents()
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
  <div class="meds" data-testid="medications-page">
    <div class="toolbar">
      <h1 class="page-heading">Medications</h1>
      <button type="button" class="ghost print-btn" onclick={() => window.print()} data-testid="medications-print">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M6 9V3h12v6" /><path d="M6 18H4a2 2 0 0 1-2-2v-4a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2h-2" /><rect x="6" y="14" width="12" height="7" rx="1" />
        </svg>
        Print
      </button>
    </div>

    {#if summary.medications.length === 0}
      <p class="muted" data-testid="medications-empty">
        No medications on record yet. Imported records and quick-logged meds both land here.
      </p>
    {:else}
      <div class="split-group">
        <!-- The catch-all leads. A route is only ever set by hand — nothing
             parses one out of a drug name — so these are the meds still asking
             to be filed, not the remainder. Unlabelled on screen because the
             heading would be a label for rows that have none. -->
        {#if shelves.unrouted.length > 0}
          <SummarySection
            title="Needs a route"
            rows={shelves.unrouted}
            hueClass="cat-med"
            heading="h3"
            headingHidden
            dictionaryEnabled={$dictionaryStatus.enabled}
            {coveredSystems}
            curateLabel="Edit details"
            detailLabel="Dose"
            onviewtimeline={viewOnTimeline}
            onrowtap={(row) => (action = row)}
          />
          <p class="caption muted" data-testid="medications-unrouted-caption">
            No route set — Edit details files these on a shelf
          </p>
        {/if}

        {#each shelves.shelves as shelf (shelf.route)}
          <SummarySection
            title={REGIMEN_ROUTE_LABELS[shelf.route]}
            rows={shelf.rows}
            hueClass="cat-med"
            heading="h3"
            dictionaryEnabled={$dictionaryStatus.enabled}
            {coveredSystems}
            curateLabel="Edit details"
            detailLabel="Dose"
            onviewtimeline={viewOnTimeline}
            onrowtap={(row) => (action = row)}
          />
        {/each}

        {#if shelves.past.length > 0}
          <button
            type="button"
            class="ghost collapse-toggle"
            aria-expanded={pastOpen}
            onclick={() => (pastOpen = !pastOpen)}
            data-testid="page-past-toggle"
          >
            {pastOpen ? 'Hide' : 'Show'}
            {shelves.past.length} past
          </button>
          <!-- Always rendered, hidden on screen until the toggle opens it: paper
               has no toggle, so a printed med list must carry the past meds. -->
          <div class="older" class:open={pastOpen}>
            <SummarySection
              title="Past"
              rows={shelves.past}
              hueClass="cat-med"
              heading="h3"
              dictionaryEnabled={$dictionaryStatus.enabled}
              {coveredSystems}
              curateLabel="Edit details"
              detailLabel="Dose"
              onviewtimeline={viewOnTimeline}
              onrowtap={(row) => (action = row)}
            />
          </div>
        {/if}
      </div>
    {/if}
  </div>

  {#if action}
    <RowActionSheet
      row={action}
      section="med"
      name={nameMap.get(action.key) ?? ''}
      regimen={regimenMap.get(action.key)}
      onclose={() => (action = null)}
      onsaved={reloadCuration}
    />
  {/if}
{/if}

<style>
  .toolbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-3);
    margin-bottom: var(--space-4);
  }

  .page-heading {
    margin: 0;
  }

  .print-btn {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
    min-height: 36px;
    min-width: 0;
    font-size: var(--text-sm);
  }

  /* The shelves are sub-groups of one list, not independent sections: the same
     margin override ClinicianSummary applies to its Current/Past pairing, or
     each shelf floats a full section-gap away from its neighbours. */
  .split-group {
    margin-bottom: var(--space-5);
  }

  .split-group :global(.section) {
    margin-bottom: var(--space-2);
  }

  .caption {
    margin: calc(-1 * var(--space-1)) 0 var(--space-3);
    font-size: var(--text-xs);
  }

  .collapse-toggle {
    min-height: 36px;
    padding: var(--space-1) var(--space-2);
    font-size: var(--text-sm);
    margin-bottom: var(--space-2);
  }

  /* A collapsed past group stays in the DOM so the print stylesheet can reveal
     it; on screen it is simply not there. */
  @media screen {
    .older:not(.open) {
      display: none;
    }
  }

  /* Print: the same black-on-white handoff the summary produces.

     TWIN: components/ClinicianSummary.svelte carries a near-identical block,
     and the two must change together. Svelte styles are component-scoped, so
     this cannot be shared without giving up the scoping that keeps the :global
     rules off every other screen. */
  @media print {
    :global(body) {
      background: #fff;
      color: #000;
    }
    :global(.app-header),
    :global(.fab),
    :global(.layer),
    :global(.tag-chip) {
      display: none !important;
    }
    .print-btn,
    .collapse-toggle {
      display: none;
    }
    /* Codes live in the expanded panel on screen, where they're one tap away.
       Paper has no taps, so each row reveals its code inline instead and the
       panels stay shut. */
    .meds :global(.paper) {
      display: inline !important;
    }
    .meds :global(.panel-wrap),
    .meds :global(.action),
    .meds :global(.chevron) {
      display: none !important;
    }
    /* The row face carries the app background so it can slide over the swipe
       actions beneath it. On paper that prints as a grey block behind every
       row. */
    .meds :global(.row) {
      background: transparent !important;
    }
    .meds :global(.section) {
      break-inside: avoid;
    }
    .meds :global(.section-head),
    .meds :global(.label),
    .meds :global(.code),
    .meds :global(.hint),
    .meds :global(.subline),
    .meds :global(.prn),
    .meds :global(.detail),
    .meds :global(.date),
    .meds :global(.count),
    .caption {
      color: #000;
    }
  }
</style>
