<script lang="ts">
  import { onMount } from 'svelte'
  import { allEvents, type StoredEvent } from '../lib/events'
  import {
    allCurationByPrefix,
    allStatuses,
    allNames,
    allRegimens,
    type ConceptStatus,
    type Regimen,
  } from '../lib/curation'
  import { buildSummary } from '../lib/summary'
  import { loadDictionaryIndex, dictionaryStatus } from '../lib/dictionary'
  import { loadListSize, setListSize, type ListSize } from '../lib/pharmacyPrefs'
  import PharmacyMedList from '../components/PharmacyMedList.svelte'

  // The pharmacy handoff: the med list as someone filling a prescription needs
  // it. Owner-only, like the Medications page it hangs off — it reads this
  // device's curation, which is where dose, directions and prescriber live.

  let events = $state<StoredEvent[]>([])
  let hiddenIds = $state<Set<string>>(new Set())
  let statusMap = $state<Map<string, ConceptStatus>>(new Map())
  let nameMap = $state<Map<string, string>>(new Map())
  let regimenMap = $state<Map<string, Regimen>>(new Map())
  let loaded = $state(false)
  let size = $state<ListSize>('standard')

  let dictionary = $state<Map<string, string>>(new Map())
  $effect(() => {
    void $dictionaryStatus.version
    void $dictionaryStatus.enabled
    void loadDictionaryIndex().then((d) => (dictionary = d))
  })

  const now = Date.now()
  const createdAt = new Date(now).toISOString()

  // One fold for the screen, its print stylesheet, and anything exported from
  // this page: `hiddenIds` is applied here, so an entry the owner hid cannot
  // reappear in one of them. Guaranteed by e2e/pharmacy-list.spec.ts's
  // "leaves a hidden medication off the list".
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

  onMount(async () => {
    events = await allEvents()
    const hideRecords = await allCurationByPrefix('hide:')
    hiddenIds = new Set(
      hideRecords
        .filter((r) => (r.value as { hidden?: boolean } | undefined)?.hidden === true)
        .map((r) => r.key.slice('hide:'.length)),
    )
    ;[statusMap, nameMap, regimenMap, size] = await Promise.all([
      allStatuses(),
      allNames(),
      allRegimens(),
      loadListSize(),
    ])
    loaded = true
  })
</script>

{#if loaded}
  <div class="page" data-testid="medications-pharmacy-page">
    <div class="toolbar">
      <h1 class="page-heading">For the pharmacy</h1>
      <button
        type="button"
        class="ghost print-btn"
        onclick={() => window.print()}
        data-testid="pharmacy-print"
      >
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M6 9V3h12v6" /><path d="M6 18H4a2 2 0 0 1-2-2v-4a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2h-2" /><rect x="6" y="14" width="12" height="7" rx="1" />
        </svg>
        Print
      </button>
    </div>
    <p class="lede muted">
      Every medication on record, numbered, with its dose, directions and prescriber.
    </p>

    <!-- The size is persisted here rather than inside the list: the list is
         also rendered where there is no vault to write to. -->
    <PharmacyMedList
      medications={summary.medications}
      allergies={summary.allergies}
      {createdAt}
      bind:size={
        () => size,
        (next) => {
          size = next
          void setListSize(next)
        }
      }
    />
  </div>
{/if}

<style>
  .toolbar {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    justify-content: space-between;
    gap: var(--space-3);
    margin-bottom: var(--space-2);
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
    flex: none;
  }

  .lede {
    font-size: var(--text-sm);
    margin-bottom: var(--space-5);
    max-width: 34rem;
  }

  /* The list component carries the rest of the print styling (see its TWIN
     note); the page only has to take its own chrome off the paper. */
  @media print {
    .print-btn,
    .lede {
      display: none;
    }
  }
</style>
