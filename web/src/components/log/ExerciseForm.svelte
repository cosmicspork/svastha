<script lang="ts">
  import { EXERCISE_DURATION } from '../../lib/codes'
  import { exerciseDrafts, type Draft, type DraftTemplate } from '../../lib/drafts'
  import LogShell from './LogShell.svelte'

  let activity = $state('')
  let minutes = $state('')

  function buildDrafts(effectiveAt: string): Draft[] | null {
    const a = activity.trim()
    if (!a) return null
    const m = minutes.trim()
    if (m && !/^\d+$/.test(m)) return null
    return exerciseDrafts(a, effectiveAt, m || undefined)
  }

  function favoriteLabel(): string {
    const m = minutes.trim()
    return m ? `${activity.trim()} ${m} min` : activity.trim()
  }

  function onReset() {
    activity = ''
    minutes = ''
  }

  function onPrefill(templates: DraftTemplate[]) {
    for (const t of templates) {
      if (t.code?.code === EXERCISE_DURATION.code && 'quantity' in t.value) {
        minutes = t.value.quantity.value
      } else if ('text' in t.value) {
        activity = t.value.text
      }
    }
  }
</script>

<LogShell title="Move" category="exercise" {buildDrafts} {favoriteLabel} {onPrefill} {onReset}>
  <label class="field">
    Activity
    <input
      bind:value={activity}
      autocomplete="off"
      placeholder="walk, yoga, bike…"
      data-testid="exercise-activity"
    />
  </label>

  <label class="field minutes">
    Minutes (optional)
    <input
      bind:value={minutes}
      inputmode="numeric"
      autocomplete="off"
      placeholder="30"
      data-testid="exercise-minutes"
    />
  </label>
</LogShell>

<style>
  .minutes input {
    max-width: 8rem;
    font-family: var(--font-data);
  }
</style>
