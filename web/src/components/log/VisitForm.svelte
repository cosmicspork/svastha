<script lang="ts">
  import { encounterDraft, noteDraft, type Draft, type DraftTemplate } from '../../lib/drafts'
  import LogShell from './LogShell.svelte'

  let provider = $state('')
  let reason = $state('')
  let note = $state('')

  function buildDrafts(effectiveAt: string): Draft[] | null {
    if (!provider.trim()) return null
    const drafts = [encounterDraft(provider, reason, effectiveAt)]
    const body = note.trim()
    if (body) drafts.push(noteDraft(body, effectiveAt))
    return drafts
  }

  function favoriteLabel(): string {
    const name = provider.trim()
    const why = reason.trim()
    return why ? `${name} — ${why}` : name
  }

  function onReset() {
    provider = ''
    reason = ''
    note = ''
  }

  function onPrefill(templates: DraftTemplate[]) {
    // Recents/favorites carry the whole "provider — reason" text; prefill it as
    // the provider so re-saving reproduces the identical value (same content id
    // shape), rather than lossily re-parsing it into fields — same as MedForm.
    const visit = templates.find((t) => t.kind === 'encounter')
    if (visit && visit.value && 'text' in visit.value) {
      provider = visit.value.text
      reason = ''
    }
    const body = templates.find((t) => t.kind === 'document')
    note = body && body.value && 'text' in body.value ? body.value.text : ''
  }
</script>

<LogShell title="Visit" category="clinical" {buildDrafts} {favoriteLabel} {onPrefill} {onReset}>
  <label class="field">
    Provider
    <input
      bind:value={provider}
      autocomplete="off"
      placeholder="Dr. Sharma"
      data-testid="visit-provider"
    />
  </label>

  <label class="field">
    Reason <span class="optional">(optional)</span>
    <input
      bind:value={reason}
      autocomplete="off"
      placeholder="cardiology follow-up"
      data-testid="visit-reason"
    />
  </label>

  <label class="field">
    Note <span class="optional">(optional)</span>
    <textarea
      bind:value={note}
      placeholder="What was said, what happens next"
      data-testid="visit-note"
    ></textarea>
  </label>
</LogShell>

<style>
  .optional {
    opacity: 0.6;
  }
</style>
