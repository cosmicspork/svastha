<script lang="ts">
  import { SYMPTOMS } from '../../lib/codes'
  import { symptomDraft, freeTextSymptomDraft, type Draft, type DraftTemplate } from '../../lib/drafts'
  import LogShell from './LogShell.svelte'

  let selectedKey = $state<string | null>(null)
  let freeText = $state('')
  let severity = $state(5)

  const selected = $derived(SYMPTOMS.find((s) => s.key === selectedKey) ?? null)

  function pick(key: string) {
    selectedKey = selectedKey === key ? null : key
    if (selectedKey) freeText = ''
  }

  function buildDrafts(effectiveAt: string): Draft[] | null {
    // Severity applies to coded symptoms only: a free-text symptom's single
    // value slot holds the name (see freeTextSymptomDraft).
    if (selected) return [symptomDraft(selected.snomed, severity, effectiveAt)]
    const name = freeText.trim()
    return name ? [freeTextSymptomDraft(name, effectiveAt)] : null
  }

  function favoriteLabel(): string {
    return selected?.label ?? freeText.trim()
  }

  function onReset() {
    selectedKey = null
    freeText = ''
    severity = 5
  }

  function onPrefill(templates: DraftTemplate[]) {
    const t = templates[0]
    if (!t) return
    if (t.code) {
      const def = SYMPTOMS.find((s) => s.snomed.code === t.code!.code)
      if (def) {
        selectedKey = def.key
        freeText = ''
        if ('quantity' in t.value) {
          const n = Number(t.value.quantity.value)
          if (Number.isFinite(n)) severity = Math.min(10, Math.max(0, Math.round(n)))
        }
      }
    } else if ('text' in t.value) {
      selectedKey = null
      freeText = t.value.text
    }
  }
</script>

<LogShell title="Symptom" category="symptom" {buildDrafts} {favoriteLabel} {onPrefill} {onReset}>
  <div class="grid" role="listbox" aria-label="Symptom">
    {#each SYMPTOMS as symptom (symptom.key)}
      <button
        type="button"
        role="option"
        aria-selected={selectedKey === symptom.key}
        onclick={() => pick(symptom.key)}
        data-testid="symptom-{symptom.key}"
      >
        {symptom.label}
      </button>
    {/each}
  </div>

  {#if selected}
    <label class="severity">
      Severity: <span class="data" data-testid="severity-value">{severity}</span>/10
      <input type="range" min="0" max="10" step="1" bind:value={severity} data-testid="severity" />
    </label>
  {:else}
    <label>
      Something else
      <input
        bind:value={freeText}
        autocomplete="off"
        placeholder="Describe it in a few words"
        data-testid="symptom-text"
      />
    </label>
  {/if}
</LogShell>

<style>
  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(9rem, 1fr));
    gap: var(--space-2);
  }

  .grid button {
    min-width: 0;
    font-size: var(--text-sm);
    padding: var(--space-2);
  }

  .grid button[aria-selected='true'] {
    border-color: var(--action);
    color: var(--action);
    background: var(--action-muted);
  }

  label {
    display: block;
    font-size: var(--text-sm);
    color: var(--muted);
  }

  .severity input {
    min-height: 44px;
    padding: 0;
    border: none;
    background: none;
  }
</style>
