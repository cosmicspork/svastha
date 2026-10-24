<script lang="ts">
  import { onMount } from 'svelte'
  import { OCCUPATION, OCCUPATIONAL_HAZARD } from '../../lib/codes'
  import { workDrafts, freeJobStart, type Draft, type DraftTemplate } from '../../lib/drafts'
  import { allEvents } from '../../lib/events'
  import { getStatus, setStatus } from '../../lib/curation'
  import { conceptKey } from '../../lib/summary'
  import { toLocalIso } from '../../lib/time'
  import LogShell from './LogShell.svelte'

  const PRESETS = [
    'noise',
    'dust',
    'solvents & chemicals',
    'asbestos',
    'radiation',
    'night shifts',
    'needlesticks',
    'heavy lifting',
  ]
  const MIN_YEAR = 1900

  let title = $state('')
  let current = $state(true)
  let year = $state('')
  let custom = $state<string[]>([])
  let picked = $state<string[]>([])
  let pending = $state('')

  // Start instants already used by a logged job; see freeJobStart.
  let takenStarts = $state<Set<string>>(new Set())
  onMount(async () => {
    const events = await allEvents()
    takenStarts = new Set(
      events
        .filter(
          ({ event }) =>
            event.code?.system === OCCUPATION.system &&
            event.code.code === OCCUPATION.code &&
            event.effective_at,
        )
        .map(({ event }) => event.effective_at!),
    )
  })

  const chips = $derived([...PRESETS, ...custom])

  function isPicked(label: string): boolean {
    return picked.some((p) => p.toLowerCase() === label.toLowerCase())
  }

  function toggle(label: string) {
    picked = isPicked(label)
      ? picked.filter((p) => p.toLowerCase() !== label.toLowerCase())
      : [...picked, label]
  }

  function addPending() {
    const label = pending.trim().replace(/,+$/, '')
    if (label && !chips.some((c) => c.toLowerCase() === label.toLowerCase())) custom = [...custom, label]
    if (label && !isPicked(label)) picked = [...picked, label]
    pending = ''
  }

  function onKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault()
      addPending()
    }
  }

  /** The chosen start year as a number, null when blank, NaN when invalid. */
  function parsedYear(): number | null {
    const y = year.trim()
    if (!y) return null
    const n = Number(y)
    return /^\d{4}$/.test(y) && n >= MIN_YEAR && n <= new Date().getFullYear() ? n : NaN
  }

  function exposureList(): string[] {
    return pending.trim() ? [...picked, pending.trim().replace(/,+$/, '')] : picked
  }

  function buildDrafts(effectiveAt: string): Draft[] | null {
    const y = parsedYear()
    if (Number.isNaN(y)) return null
    // No year: the job is dated by when it was logged. That is the only date
    // the form can honestly offer, and the summary reads it as "since <that
    // year>"; give a year to say otherwise.
    const start = y === null ? effectiveAt : freeJobStart(new Date(y, 0, 1), takenStarts, toLocalIso)
    return workDrafts(title, exposureList(), start)
  }

  function favoriteLabel(): string {
    return title.trim()
  }

  async function afterSave(drafts: Draft[]) {
    const key = conceptKey(drafts[0])
    takenStarts = new Set([...takenStarts, drafts[0].effective_at])
    if (!current) await setStatus(key, 'inactive')
    // Logging a job as current again undoes an earlier "past" mark.
    else if ((await getStatus(key)) === 'inactive') await setStatus(key, 'active')
  }

  function onReset() {
    title = ''
    current = true
    year = ''
    custom = []
    picked = []
    pending = ''
  }

  function onPrefill(templates: DraftTemplate[]) {
    for (const t of templates) {
      if (!t.value || !('text' in t.value)) continue
      if (t.code?.code === OCCUPATION.code) title = t.value.text
      else if (t.code?.code === OCCUPATIONAL_HAZARD.code) {
        const label = t.value.text
        if (!chips.some((c) => c.toLowerCase() === label.toLowerCase())) custom = [...custom, label]
        if (!isPicked(label)) picked = [...picked, label]
      }
    }
  }
</script>

<LogShell title="Work" category="work" {buildDrafts} {favoriteLabel} {onPrefill} {onReset} {afterSave}>
  <label class="field">
    Job title
    <input bind:value={title} autocomplete="off" placeholder="welder" data-testid="work-title" />
  </label>

  <div class="seg" role="group" aria-label="Current or past job">
    <button type="button" aria-pressed={current} onclick={() => (current = true)} data-testid="work-current">
      Current
    </button>
    <button type="button" aria-pressed={!current} onclick={() => (current = false)} data-testid="work-past">
      Past
    </button>
  </div>

  <label class="field">
    Started (year, optional)
    <input
      bind:value={year}
      inputmode="numeric"
      autocomplete="off"
      placeholder="2019"
      aria-invalid={Number.isNaN(parsedYear())}
      data-testid="work-year"
    />
  </label>

  <div class="field">
    Exposures
    <div class="chips" role="group" aria-label="Exposures">
      {#each chips as label (label)}
        <button
          type="button"
          class="chip"
          aria-pressed={isPicked(label)}
          onclick={() => toggle(label)}
          data-testid="work-exposure"
        >
          {label}
        </button>
      {/each}
    </div>
  </div>

  <label class="field">
    Add another
    <input
      bind:value={pending}
      onkeydown={onKeydown}
      autocomplete="off"
      placeholder="Enter or comma adds it"
      data-testid="work-exposure-input"
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
</style>
