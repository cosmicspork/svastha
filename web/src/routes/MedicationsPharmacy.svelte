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
    ;[statusMap, nameMap, regimenMap] = await Promise.all([
      allStatuses(),
      allNames(),
      allRegimens(),
    ])
    loaded = true
  })
</script>

{#if loaded}
  <div class="page" data-testid="medications-pharmacy-page">
    <h1 class="page-heading">For the pharmacy</h1>
    <p class="lede muted">
      Every medication on record, numbered, with its dose, directions and prescriber.
    </p>

    <PharmacyMedList medications={summary.medications} allergies={summary.allergies} {createdAt} />
  </div>
{/if}

<style>
  .page-heading {
    margin: 0 0 var(--space-2);
  }

  .lede {
    font-size: var(--text-sm);
    margin-bottom: var(--space-5);
    max-width: 34rem;
  }
</style>
