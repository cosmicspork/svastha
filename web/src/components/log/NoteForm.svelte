<script lang="ts">
  import { noteDraft, type Draft, type DraftTemplate } from '../../lib/drafts'
  import LogShell from './LogShell.svelte'

  let body = $state('')

  function buildDrafts(effectiveAt: string): Draft[] | null {
    const text = body.trim()
    return text ? [noteDraft(text, effectiveAt)] : null
  }

  function favoriteLabel(): string {
    const text = body.trim()
    return text.length > 40 ? `${text.slice(0, 40)}…` : text
  }

  function onReset() {
    body = ''
  }

  function onPrefill(templates: DraftTemplate[]) {
    const t = templates[0]
    if (t && 'text' in t.value) body = t.value.text
  }
</script>

<LogShell title="Note" category="note" {buildDrafts} {favoriteLabel} {onPrefill} {onReset}>
  <label class="field">
    Note
    <textarea
      bind:value={body}
      placeholder="Anything worth remembering"
      data-testid="note-body"
    ></textarea>
  </label>
</LogShell>
