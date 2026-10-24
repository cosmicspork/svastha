<script lang="ts">
  import { onMount } from 'svelte'
  import {
    asDoseTemplate,
    doseDraft,
    doseIdentityOf,
    DOSE_AMOUNT,
    type DoseIdentity,
    type Draft,
    type DraftTemplate,
  } from '../../lib/drafts'
  import { allEvents, templateLabel } from '../../lib/events'
  import { allNames, allRegimens, allStatuses, loadHiddenIds } from '../../lib/curation'
  import { buildSummary, conceptKey, standingKeyForDose } from '../../lib/summary'
  import { DOSE_UNITS } from '../../lib/codes'
  import LogShell from './LogShell.svelte'

  // "Took a dose": one medication_dose per save. The owner's current
  // medications are the quick choices, because a dose links to its standing
  // medication only by copying that statement's identity exactly (summary.ts's
  // `standingKeyForDose`) — picking it is how the copy stays exact. Something
  // not on the list is typed by hand and stands alone ("Taken recently").

  interface Choice {
    /** The standing concept key. */
    key: string
    label: string
    identity: DoseIdentity
    /** The regimen's dose, shown for a free-text med (whose dose carries no
     * amount of its own). */
    regimenDose: string
  }

  let choices = $state<Choice[]>([])
  let picked = $state<Choice | null>(null)
  let typed = $state('')
  let amount = $state('')
  let unitIndex = $state(0)

  onMount(async () => {
    const [events, status, names, regimen, hiddenIds] = await Promise.all([
      allEvents(),
      allStatuses(),
      allNames(),
      allRegimens(),
      loadHiddenIds(),
    ])
    const byId = new Map(events.map((se) => [se.event.id, se.event]))
    const { medications } = buildSummary(events, { status, names, regimen, hiddenIds })
    choices = medications
      .filter((row) => row.status === 'active')
      .flatMap((row) => {
        const statement = byId.get(row.focusId)
        const identity = statement ? doseIdentityOf(statement) : null
        return identity ? [{ key: row.key, label: row.label, identity, regimenDose: row.regimen?.dose ?? '' }] : []
      })
  })

  const coded = $derived(picked !== null && 'code' in picked.identity)
  const amountValid = $derived(amount.trim() === '' || DOSE_AMOUNT.test(amount.trim()))

  function pick(choice: Choice) {
    picked = picked?.key === choice.key ? null : choice
    typed = ''
    amount = ''
  }

  function onTyped() {
    picked = null
    amount = ''
  }

  function buildDrafts(effectiveAt: string): Draft[] | null {
    if (picked) {
      if (!coded) return [doseDraft(picked.identity, effectiveAt)]
      if (!amountValid) return null
      const a = amount.trim()
      return [doseDraft(picked.identity, effectiveAt, a ? { value: a, unit: DOSE_UNITS[unitIndex].unit } : undefined)]
    }
    const name = typed.trim()
    return name ? [doseDraft({ text: name }, effectiveAt)] : null
  }

  function favoriteLabel(): string {
    if (!picked) return typed.trim()
    const a = amount.trim()
    return coded && a ? `${picked.label} ${a} ${DOSE_UNITS[unitIndex].label}` : picked.label
  }

  function onReset() {
    picked = null
    typed = ''
    amount = ''
  }

  function onPrefill(templates: DraftTemplate[]) {
    if (!templates[0]) return
    const t = asDoseTemplate(templates[0])
    const standing = standingKeyForDose(conceptKey(t))
    const listed = choices.find((c) => c.key === standing)
    typed = ''
    amount = ''
    if (listed) picked = listed
    else if (t.code) {
      // A coded dose of something no longer current: keep its identity so the
      // re-log still links, even without a chip to show for it.
      picked = { key: standing ?? '', label: templateLabel(t), identity: { code: t.code }, regimenDose: '' }
    } else {
      picked = null
      if (t.value && 'text' in t.value) typed = t.value.text
    }
    if (picked && 'code' in picked.identity && t.value && 'quantity' in t.value) {
      const q = t.value.quantity
      const i = DOSE_UNITS.findIndex((d) => d.unit.code === q.unit?.code)
      if (i >= 0) {
        amount = q.value
        unitIndex = i
      }
    }
  }

  const adaptTemplates = (templates: DraftTemplate[]) => templates.map(asDoseTemplate)
</script>

<LogShell
  title="Took a dose"
  category="med"
  {buildDrafts}
  {favoriteLabel}
  {onPrefill}
  {onReset}
  {adaptTemplates}
>
  <div class="field">
    Your medications
    {#if choices.length > 0}
      <div class="chips" role="group" aria-label="Your medications">
        {#each choices as choice (choice.key)}
          <button
            type="button"
            class="chip"
            aria-pressed={picked?.key === choice.key}
            onclick={() => pick(choice)}
            data-testid="dose-med-chip"
          >
            {choice.label}
          </button>
        {/each}
      </div>
    {:else}
      <span class="hint muted" data-testid="dose-no-meds">
        Medications you take show up here — add them on the Medications page.
      </span>
    {/if}
  </div>

  {#if picked && coded}
    <div class="dose">
      <label class="field">
        Amount (optional)
        <input
          bind:value={amount}
          inputmode="decimal"
          autocomplete="off"
          placeholder="2"
          aria-invalid={!amountValid}
          data-testid="dose-amount"
        />
      </label>
      <label class="field">
        Unit
        <select bind:value={unitIndex} data-testid="dose-unit">
          {#each DOSE_UNITS as u, i (u.label)}
            <option value={i}>{u.label}</option>
          {/each}
        </select>
      </label>
    </div>
  {:else if picked}
    <!-- A free-text medication's dose is its name and nothing else: an amount
         would have to go into that text, and then it would no longer match the
         medication it is a dose of. -->
    <p class="hint muted" data-testid="dose-regimen-note">
      {#if picked.regimenDose}
        Logged as one dose of {picked.regimenDose}, the dose in this medication's details.
      {:else}
        The amount is the dose in this medication's details (Medications page).
      {/if}
    </p>
  {/if}

  <label class="field">
    Or something else
    <input
      bind:value={typed}
      oninput={onTyped}
      autocomplete="off"
      placeholder="ibuprofen"
      data-testid="med-name"
    />
  </label>
</LogShell>

<style>
  .chips {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
    margin-top: var(--space-2);
  }

  .chip {
    min-height: 40px;
    border: 1px solid var(--border);
    border-radius: 999px;
    background: var(--surface);
    padding: var(--space-1) var(--space-3);
    font-size: var(--text-sm);
    color: var(--text);
  }

  .chip[aria-pressed='true'] {
    background: var(--action-muted);
    box-shadow: inset 0 0 0 1px var(--action);
  }

  .hint {
    display: block;
    margin: var(--space-1) 0 0;
    font-size: var(--text-sm);
  }

  .dose {
    display: flex;
    gap: var(--space-3);
    align-items: flex-end;
  }

  select {
    min-height: 44px;
    padding: var(--space-2) var(--space-3);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--surface);
  }
</style>
