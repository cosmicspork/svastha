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
  import { get } from '../lib/db'
  import { session } from '../lib/session.svelte'
  import { RelayClient } from '../lib/relay'
  import { buildPharmacyPdf, pharmacyPdfFilename } from '../lib/pharmacyPdf'
  import { shareOrDownload } from '../lib/export'
  import PharmacyMedList from '../components/PharmacyMedList.svelte'
  import DoctorShareSheet from '../components/DoctorShareSheet.svelte'
  import Sheet from '../components/Sheet.svelte'

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

  // Sharing reuses the doctor-share sheet, locked to medications: the same
  // sealed bundle, the same expiry and revocation, scoped to the one list this
  // page is about. Nothing here re-implements the share path.
  let relayUrl = $state('')
  let relay = $state<RelayClient | null>(null)
  let shareOpen = $state(false)
  let chooserOpen = $state(false)
  let pdfError = $state('')

  // A file share is a plain copy, and saying so is the same honesty the
  // doctor-share sheet applies to its own file path.
  const PDF_HONEST_COPY =
    'A PDF is a plain copy: it never expires, cannot be revoked, and whoever holds it can read ' +
    'it. Hand it over the way you would a printout.'

  // Built when the chooser opens, not when the button is tapped: iOS grants a
  // tap a short window in which navigator.share may be called, and rendering a
  // PDF inside that window can spend it, leaving the share to fail.
  let pdfBytes: Uint8Array | null = null
  let pdfPending: Promise<Uint8Array> | null = null

  function startPdf(): void {
    pdfError = ''
    pdfBytes = null
    pdfPending = buildPharmacyPdf(
      summary.medications,
      summary.allergies.map((a) => a.label),
      createdAt,
    )
    void pdfPending
      .then((bytes) => (pdfBytes = bytes))
      .catch(() => (pdfError = 'The PDF could not be built. Print the list instead.'))
  }

  async function sharePdf(): Promise<void> {
    try {
      const bytes = pdfBytes ?? (await (pdfPending ?? buildPharmacyPdf(
        summary.medications,
        summary.allergies.map((a) => a.label),
        createdAt,
      )))
      const name = pharmacyPdfFilename(new Date())
      // A fresh ArrayBuffer copy: some engines reject a File over a view onto
      // a larger buffer.
      const file = new File([bytes.slice().buffer as ArrayBuffer], name, {
        type: 'application/pdf',
      })
      await shareOrDownload(file)
      chooserOpen = false
    } catch {
      pdfError = 'The PDF could not be built. Print the list instead.'
    }
  }

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
    relayUrl = (await get<string>('prefs', 'relayUrl')) ?? ''
    if (relayUrl && session.identity) relay = new RelayClient(relayUrl, session.identity)
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
      <div class="toolbar-actions">
      <button
        type="button"
        class="ghost print-btn"
        onclick={() => {
          chooserOpen = true
          startPdf()
        }}
        data-testid="pharmacy-share"
      >
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M12 15V4" /><path d="M8 8l4-4 4 4" /><path d="M5 12v7a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-7" />
        </svg>
        Share
      </button>
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

  {#if chooserOpen}
    <Sheet onclose={() => (chooserOpen = false)}>
      <section class="chooser">
        <h2>Share this list</h2>
        <button
          type="button"
          class="choice"
          onclick={() => {
            chooserOpen = false
            shareOpen = true
          }}
          data-testid="pharmacy-share-link"
        >
          <span class="choice-name">Link or QR code</span>
          <span class="choice-sub muted"
            >Medications only. Expires on its own, and you can revoke it.</span
          >
        </button>
        <button type="button" class="choice" onclick={sharePdf} data-testid="pharmacy-share-pdf">
          <span class="choice-name">PDF</span>
          <span class="choice-sub muted">{PDF_HONEST_COPY}</span>
        </button>
        {#if pdfError}
          <p class="error" data-testid="pharmacy-pdf-error">{pdfError}</p>
        {/if}
      </section>
    </Sheet>
  {/if}

  {#if shareOpen}
    <!-- Medications only, and not negotiable from inside the sheet: someone
         sharing from this page is sharing this list. Past meds stay the sheet's
         own opt-in, since including a stopped med only narrows what a
         pharmacist has to ask about. -->
    <DoctorShareSheet
      {relay}
      {relayUrl}
      presetCategories={['med']}
      lockScope
      onclose={() => (shareOpen = false)}
    />
  {/if}
{/if}

<style>
  .chooser {
    display: grid;
    gap: var(--space-3);
  }

  .choice {
    display: grid;
    gap: var(--space-1);
    text-align: left;
    padding: var(--space-3);
    min-height: 44px;
  }

  .choice-name {
    font-size: var(--text-base);
  }

  .choice-sub {
    font-size: var(--text-sm);
    line-height: 1.4;
  }

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

  .toolbar-actions {
    display: flex;
    align-items: center;
    gap: var(--space-2);
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
    .toolbar-actions,
    .lede {
      display: none;
    }
  }
</style>
