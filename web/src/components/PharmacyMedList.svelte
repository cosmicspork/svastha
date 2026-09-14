<script lang="ts">
  import { buildPharmacyGroups, pharmacyRowCount } from '../lib/pharmacy'
  import type { SummaryRow } from '../lib/summary'

  // The pharmacy handoff, rendered identically wherever it appears: the owner's
  // export page, and (later) a share recipient's cold-loaded view. One numbered
  // list down the page, because a pharmacist reads it against a prescription
  // rather than scanning it for one drug — which is what the owner's
  // Medications page is shaped for.

  let {
    medications,
    allergies,
    createdAt,
    size = 'standard',
  }: {
    /** `buildSummary(...).medications` — the host folds, so hidden entries are
     * already gone and this component never reads the vault. */
    medications: SummaryRow[]
    /** The allergies to show, or null when the source cannot carry them (a
     * meds-scoped share). Null and empty say different things and must not be
     * collapsed: `[]` is "nothing on record", null is "not in this export". */
    allergies: SummaryRow[] | null
    /** ISO instant this list was produced, shown in the provenance footer. */
    createdAt: string
    /** Counter mode enlarges the name, dose and prescriber so a phone can be
     * read across a counter. Not a page zoom: the numbers a pharmacist needs
     * grow, the chrome does not. */
    size?: 'standard' | 'counter'
  } = $props()

  const groups = $derived(buildPharmacyGroups(medications))
  const total = $derived(pharmacyRowCount(groups))
  // The past group is always last (see buildPharmacyGroups) and is the only one
  // folded away on screen.
  const pastCount = $derived(groups.find((g) => g.id === 'past')?.rows.length ?? 0)

  let pastOpen = $state(false)

  function fmtStamp(iso: string): string {
    const d = new Date(iso)
    if (Number.isNaN(d.getTime())) return iso
    return d.toLocaleString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    })
  }
</script>

<div class="pharmacy" data-size={size} data-testid="pharmacy-list">
  <section class="header-card" aria-labelledby="pharmacy-allergies-heading">
    <h2 class="card-heading" id="pharmacy-allergies-heading">Drug allergies</h2>
    {#if allergies === null}
      <p class="allergy-note muted" data-testid="pharmacy-allergies-absent">
        Not included in this share. Ask before dispensing.
      </p>
    {:else if allergies.length === 0}
      <p class="allergy-note muted" data-testid="pharmacy-allergies-none">
        None recorded. An empty record is not the same as none — ask.
      </p>
    {:else}
      <ul class="allergy-chips" data-testid="pharmacy-allergies">
        {#each allergies as allergy (allergy.key)}
          <li class="chip danger">{allergy.label}</li>
        {/each}
      </ul>
    {/if}
  </section>

  {#if total === 0}
    <p class="muted empty" data-testid="pharmacy-empty">No medications on record.</p>
  {:else}
    {#each groups as group (group.id)}
      {#if group.id === 'past'}
        <button
          type="button"
          class="ghost collapse-toggle"
          aria-expanded={pastOpen}
          onclick={() => (pastOpen = !pastOpen)}
          data-testid="pharmacy-past-toggle"
        >
          {pastOpen ? 'Hide' : 'Show'}
          {pastCount} past
        </button>
      {/if}
      <!-- Past stays in the DOM while collapsed: paper has no toggle, so a
           printed list must carry the past meds. Same idiom as the owner's
           Medications page. -->
      <section
        class="group"
        class:past-group={group.id === 'past'}
        class:open={pastOpen}
        aria-labelledby="pharmacy-group-{group.id}"
        data-testid="pharmacy-group"
        data-group={group.id}
      >
        <h3 class="group-head" id="pharmacy-group-{group.id}">
          <span class="dot cat-med" aria-hidden="true"></span>
          {group.title}
          <span class="group-count data">{group.rows.length}</span>
        </h3>
        <ol class="rows">
          {#each group.rows as row (row.key)}
            <li class="med" data-testid="pharmacy-row" data-n={row.n} data-past={row.past}>
              <span class="num data" aria-hidden="true">{row.n}</span>
              <!-- The number is decorative for a screen reader (the list
                   already numbers itself), but sighted readers need it large:
                   it is how a pharmacist and a patient refer to one line. -->
              <div class="med-main">
                <span class="name" data-testid="pharmacy-name">{row.name}</span>
                {#if row.dose}
                  <span class="dose" data-testid="pharmacy-dose">{row.dose}</span>
                {/if}
                {#if row.sig}
                  <span class="sig" data-testid="pharmacy-sig">{row.sig}</span>
                {/if}
                {#if row.asNeeded}
                  <span class="chips"><span class="chip prn">As needed</span></span>
                {/if}
              </div>
              <dl class="med-facts">
                <div class="fact">
                  <dt>Prescribed by</dt>
                  <dd data-testid="pharmacy-prescriber">
                    {#if row.prescriber}{row.prescriber}{:else}<span class="muted"
                        >Not recorded</span
                      >{/if}
                  </dd>
                </div>
              </dl>
            </li>
          {/each}
        </ol>
      </section>
    {/each}
  {/if}

  <footer class="provenance">
    <span
      >{total}
      {total === 1 ? 'medication' : 'medications'} as recorded on this device, {fmtStamp(
        createdAt,
      )}.</span
    >
    <span>Doses and directions are as recorded by the patient and their clinicians.</span>
  </footer>
</div>

<style>
  /* The handoff type scale. Counter mode raises only these three, so the list
     grows and the chrome around it does not. */
  .pharmacy {
    --ph-name: var(--text-xl);
    --ph-dose: var(--text-lg);
    --ph-fact: var(--text-base);
  }

  .pharmacy[data-size='counter'] {
    --ph-name: var(--text-2xl);
    --ph-dose: var(--text-xl);
    --ph-fact: var(--text-lg);
  }

  /* The one lifted surface: allergies are what a pharmacist checks before
     anything else on this page. */
  .header-card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    box-shadow: var(--shadow-1);
    padding: var(--space-4);
    margin-bottom: var(--space-5);
  }

  .card-heading {
    font-family: var(--font-body);
    font-size: var(--text-xs);
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--muted);
    margin: 0 0 var(--space-2);
  }

  .allergy-note {
    margin: 0;
    font-size: var(--text-sm);
  }

  .allergy-chips {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
  }

  .chip {
    display: inline-block;
    padding: 2px var(--space-2);
    border-radius: var(--radius-full);
    font-size: var(--text-sm);
    line-height: 1.5;
    background: var(--action-muted);
    color: var(--text);
  }

  .chip.danger {
    background: var(--danger-muted);
    color: var(--danger);
    font-weight: 700;
  }

  .chip.prn {
    background: var(--flare-muted);
    color: var(--text);
  }

  .empty {
    margin: 0 0 var(--space-5);
  }

  /* Groups are sub-lists of one list, not independent sections: a tighter gap
     than the app's section rhythm, as the Medications page does for shelves. */
  .group {
    margin-bottom: var(--space-4);
  }

  .group-head {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    font-family: var(--font-display);
    font-size: var(--text-lg);
    margin: 0 0 var(--space-2);
  }

  .group-count {
    margin-left: auto;
    font-size: var(--text-sm);
    color: var(--muted);
  }

  .dot {
    flex: none;
    width: 10px;
    height: 10px;
    border-radius: 50%;
    background: currentColor;
  }

  .rows {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
  }

  .med {
    display: grid;
    grid-template-columns: auto minmax(0, 1.3fr) minmax(0, 1fr);
    gap: var(--space-2) var(--space-4);
    padding: var(--space-3) var(--space-1);
    border-bottom: 1px solid var(--border);
  }

  .num {
    font-size: var(--ph-dose);
    color: var(--cat-med);
    line-height: 1.15;
    min-width: 2ch;
    text-align: right;
    padding-top: 0.15em;
  }

  .med-main {
    min-width: 0;
    display: grid;
    gap: var(--space-1);
  }

  .name {
    font-family: var(--font-display);
    font-size: var(--ph-name);
    line-height: 1.15;
    overflow-wrap: anywhere;
  }

  .dose {
    font-size: var(--ph-dose);
    font-weight: 700;
  }

  .sig {
    font-size: var(--ph-dose);
    line-height: 1.3;
  }

  .chips {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-1) var(--space-2);
  }

  .med-facts {
    display: grid;
    gap: var(--space-2);
    align-content: start;
    margin: 0;
  }

  .fact {
    display: grid;
    gap: 1px;
  }

  .fact dt {
    font-size: var(--text-xs);
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--muted);
  }

  .fact dd {
    margin: 0;
    font-size: var(--ph-fact);
    line-height: 1.35;
  }

  .med[data-past='true'] .name,
  .med[data-past='true'] .dose,
  .med[data-past='true'] .sig,
  .med[data-past='true'] .num {
    color: var(--muted);
  }

  .med[data-past='true'] .dose {
    font-weight: 400;
  }

  .collapse-toggle {
    min-height: 36px;
    padding: var(--space-1) var(--space-2);
    font-size: var(--text-sm);
    margin-bottom: var(--space-2);
  }

  /* Collapsed past meds are in the DOM but not on screen (see the markup note). */
  @media screen {
    .past-group:not(.open) {
      display: none;
    }
  }

  .provenance {
    margin-top: var(--space-5);
    padding-top: var(--space-4);
    border-top: 1px solid var(--border);
    font-size: var(--text-sm);
    color: var(--muted);
    display: grid;
    gap: var(--space-1);
  }

  /* Print: the black-on-white handoff a pharmacist can keep. The list owns
     this block rather than the page, so a share recipient who prints the same
     component gets the same paper.

     TWIN: routes/Medications.svelte and components/ClinicianSummary.svelte
     carry near-identical blocks; all three must change together. Svelte styles
     are component-scoped, so sharing one stylesheet would give up the scoping
     that keeps these rules off every other screen. */
  @media print {
    :global(body) {
      background: #fff;
      color: #000;
    }

    :global(.app-header),
    :global(.fab),
    :global(.layer) {
      display: none !important;
    }

    .collapse-toggle {
      display: none;
    }

    /* Paper has no toggle, so the past meds print whether or not the reader
       opened them on screen — a med list missing its recently-stopped entries
       is the one a pharmacist most needs to see. */
    .past-group {
      display: block !important;
    }

    .header-card {
      box-shadow: none;
      border-color: #000;
    }

    .chip {
      border: 1px solid #000;
      background: none !important;
      color: #000;
    }

    /* Every hue collapses to ink: the category dot, the muted captions and the
       past-med greys all have to survive a monochrome printer. */
    .group-head,
    .group-count,
    .num,
    .fact dt,
    .fact dd,
    .card-heading,
    .allergy-note,
    .provenance,
    .med[data-past='true'] .name,
    .med[data-past='true'] .dose,
    .med[data-past='true'] .sig,
    .med[data-past='true'] .num {
      color: #000;
    }

    .dot {
      background: #000;
    }

    .group,
    .med {
      break-inside: avoid;
    }

    /* Paper is read at reading distance, and ink is dearer than pixels. */
    .pharmacy,
    .pharmacy[data-size='counter'] {
      --ph-name: 1.125rem;
      --ph-dose: 1rem;
      --ph-fact: 0.9375rem;
    }
  }

  /* Phone: the row becomes a card so nothing sits beside anything else, and the
     scale grows — this list is read at arm's length, not held up close. */
  @media (max-width: 40rem) {
    .pharmacy {
      --ph-name: 1.75rem;
      --ph-dose: var(--text-xl);
      --ph-fact: var(--text-lg);
    }

    .pharmacy[data-size='counter'] {
      --ph-name: 2.25rem;
      --ph-dose: 1.75rem;
      --ph-fact: var(--text-xl);
    }

    .med {
      grid-template-columns: auto minmax(0, 1fr);
      padding-block: var(--space-4);
    }

    .med-facts {
      grid-column: 2;
    }
  }
</style>
