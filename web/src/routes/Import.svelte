<script lang="ts">
  import { navigate } from '../lib/router.svelte'
  import { event_id, import_ccda, import_fhir } from '../lib/svastha'
  import { analyzeFiles, commitImport, configureImportBackend, type DocPlan, type ImportPlan } from '../lib/import'
  import { categorize, CATEGORY_META, type Category } from '../lib/category'

  // Idempotent (see sync.ts's `configure` for the same pattern) — cheap to
  // call on every mount rather than threading it through App.svelte, since
  // only this screen needs the import backend.
  configureImportBackend({ import_ccda, import_fhir, event_id })

  type Stage = 'pick' | 'analyzing' | 'review' | 'importing' | 'done'
  let stage = $state<Stage>('pick')
  let error = $state('')
  let analyzeProgress = $state({ done: 0, total: 0 })
  let importProgress = $state({ index: 0, total: 0 })
  let plan = $state<ImportPlan | null>(null)
  let importedCount = $state(0)
  let expandedWarnings = $state<Set<string>>(new Set())
  let expandedSkipped = $state<Set<string>>(new Set())

  async function handleFiles(files: FileList | null): Promise<void> {
    if (!files || files.length === 0) return
    error = ''
    stage = 'analyzing'
    analyzeProgress = { done: 0, total: 0 }
    try {
      plan = await analyzeFiles(Array.from(files), (done, total) => {
        analyzeProgress = { done, total }
      })
      stage = 'review'
    } catch (err) {
      error = err instanceof Error ? err.message : 'Could not read those files.'
      stage = 'pick'
    }
  }

  function onFileInput(e: Event): void {
    void handleFiles((e.target as HTMLInputElement).files)
  }

  function onDrop(e: DragEvent): void {
    e.preventDefault()
    void handleFiles(e.dataTransfer?.files ?? null)
  }

  function toggle(set: Set<string>, key: string): Set<string> {
    const next = new Set(set)
    if (next.has(key)) next.delete(key)
    else next.add(key)
    return next
  }

  /** Per-doc counts by category (vitals/clinical/etc.), for a quick "what's in
   * here" line without listing every draft. */
  function kindCounts(doc: DocPlan): [Category, number][] {
    const counts = new Map<Category, number>()
    for (const draft of doc.drafts) {
      const category = categorize(draft)
      counts.set(category, (counts.get(category) ?? 0) + 1)
    }
    return [...counts.entries()]
  }

  async function doImport(): Promise<void> {
    if (!plan) return
    error = ''
    stage = 'importing'
    importProgress = { index: 0, total: plan.docs.length }
    try {
      const ids = await commitImport(plan, (p) => {
        importProgress = { index: p.index, total: p.total }
      })
      importedCount = ids.length
      stage = 'done'
    } catch (err) {
      error = err instanceof Error ? err.message : 'Import failed partway through — nothing further was changed.'
      stage = 'review'
    }
  }

  function startOver(): void {
    plan = null
    error = ''
    stage = 'pick'
  }
</script>

<h1>Import records</h1>

{#if stage === 'pick'}
  <p class="muted">
    Import a C-CDA export (an IHE_XDM zip package, e.g. from an Epic patient portal) or a FHIR R4
    Bundle JSON (e.g. from FollowMyHealth). Everything is mapped and matched against your existing
    record on this device — nothing leaves it unencrypted.
  </p>
  <div
    class="dropzone"
    role="region"
    aria-label="Drop files to import"
    ondragover={(e) => e.preventDefault()}
    ondrop={onDrop}
    data-testid="import-dropzone"
  >
    <p class="muted">Drop files here, or</p>
    <label class="primary file-picker">
      Choose files
      <input
        class="visually-hidden"
        type="file"
        multiple
        accept=".zip,.xml,.json"
        onchange={onFileInput}
        data-testid="import-file-input"
      />
    </label>
  </div>
  {#if error}
    <p class="error" data-testid="import-error">{error}</p>
  {/if}
{:else if stage === 'analyzing'}
  <p class="muted" data-testid="import-analyzing">
    Analyzing… {analyzeProgress.done} of {analyzeProgress.total || '?'} document{analyzeProgress.total === 1
      ? ''
      : 's'}
  </p>
{:else if stage === 'review' && plan}
  <div class="stack">
    <p data-testid="import-totals">
      <strong>{plan.totals.newCount}</strong> new, {plan.totals.dupCount} already in your record{#if plan.totals.warnings > 0},
        {plan.totals.warnings} warning{plan.totals.warnings === 1 ? '' : 's'}{/if}{#if plan.totals.skipped > 0},
        {plan.totals.skipped} skipped{/if}.
    </p>

    {#each plan.docs as doc (doc.sha256)}
      <div class="doc-row" data-testid="import-doc">
        <p class="data doc-name">{doc.name}</p>
        <p class="muted">
          {#each kindCounts(doc) as [category, count] (category)}
            <span class={CATEGORY_META[category].hueClass}
              >{CATEGORY_META[category].glyph} {count} {CATEGORY_META[category].label}</span
            >
          {/each}
        </p>
        <p data-testid="import-doc-counts">{doc.newCount} new / {doc.dupCount} duplicate</p>

        {#if doc.tooLargeToSync}
          <p class="warn" data-testid="import-doc-too-large">
            Too large to sync — kept locally. This document's records still import; only its verbatim
            copy stays on this device.
          </p>
        {/if}

        {#if doc.warnings.length > 0}
          <button
            type="button"
            onclick={() => (expandedWarnings = toggle(expandedWarnings, doc.sha256))}
            data-testid="import-warnings-toggle"
          >
            {expandedWarnings.has(doc.sha256) ? 'Hide' : 'Show'}
            {doc.warnings.length} warning{doc.warnings.length === 1 ? '' : 's'}
          </button>
          {#if expandedWarnings.has(doc.sha256)}
            <ul data-testid="import-warnings-list">
              {#each doc.warnings as warning}
                <li class="muted">{warning}</li>
              {/each}
            </ul>
          {/if}
        {/if}

        {#if doc.skipped.length > 0}
          <button
            type="button"
            onclick={() => (expandedSkipped = toggle(expandedSkipped, doc.sha256))}
            data-testid="import-skipped-toggle"
          >
            {expandedSkipped.has(doc.sha256) ? 'Hide' : 'Show'}
            {doc.skipped.length} skipped
          </button>
          {#if expandedSkipped.has(doc.sha256)}
            <ul data-testid="import-skipped-list">
              {#each doc.skipped as s}
                <li class="muted">{s.what}: {s.why}</li>
              {/each}
            </ul>
          {/if}
        {/if}
      </div>
    {/each}

    {#if error}
      <p class="error" data-testid="import-error">{error}</p>
    {/if}

    <div class="row">
      <button type="button" onclick={startOver} data-testid="import-cancel">Cancel</button>
      <button type="button" class="primary" onclick={doImport} data-testid="import-commit">
        Import {plan.totals.newCount} new event{plan.totals.newCount === 1 ? '' : 's'}
      </button>
    </div>
  </div>
{:else if stage === 'importing'}
  <p class="muted" data-testid="import-progress">
    Importing… document {importProgress.index} of {importProgress.total}
  </p>
{:else if stage === 'done'}
  <p data-testid="import-done">Imported {importedCount} new event{importedCount === 1 ? '' : 's'}.</p>
  <button type="button" class="primary" onclick={() => navigate('#/')} data-testid="import-view-timeline">
    View timeline
  </button>
{/if}

<style>
  .dropzone {
    border: 2px dashed var(--border);
    border-radius: var(--radius-sm);
    padding: var(--space-6) var(--space-4);
    text-align: center;
  }

  .file-picker {
    display: inline-block;
  }

  .visually-hidden {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
  }

  .doc-row {
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    padding: var(--space-3);
  }

  .doc-name {
    word-break: break-all;
  }

  .doc-row span + span {
    margin-left: var(--space-3);
  }

  .row {
    display: flex;
    gap: var(--space-2);
  }

  .warn {
    font-size: var(--text-sm);
    color: var(--flare);
  }

  ul {
    margin: var(--space-2) 0 0;
    padding-left: var(--space-4);
  }
</style>
