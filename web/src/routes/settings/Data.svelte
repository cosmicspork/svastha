<script lang="ts">
  import { onMount } from 'svelte'
  import { contract_version } from '../../lib/svastha'
  import { session } from '../../lib/session.svelte'
  import { getAll } from '../../lib/db'
  import Sheet from '../../components/Sheet.svelte'
  import {
    listLocalBlobIds,
    sealLocalBlob,
    applySealedBlob,
    enqueue,
    drain,
    type ProvenanceRecord,
  } from '../../lib/sync'
  import { navigate } from '../../lib/router.svelte'
  import { allEvents } from '../../lib/events'
  import type { CurationRecord } from '../../lib/curation'
  import {
    buildPlaintextExport,
    provenanceMeta,
    plaintextExportFilename,
    downloadJson,
    buildEncryptedExport,
    encryptedExportFilename,
    parseEncryptedExport,
    importEncryptedExport,
    type ImportSummary,
  } from '../../lib/export'
  import { fromHex } from '../../lib/hex'
  import {
    dictionaryStatus,
    fetchManifest,
    manifestBytes,
    downloadDictionary,
    removeDictionary,
    refreshDictionaryStatus,
    checkForUpdate,
    type DictManifest,
  } from '../../lib/dictionary'

  // --- storage ---
  let persisted = $state<boolean | null>(null)
  let estimateText = $state('')
  onMount(async () => {
    if (navigator.storage?.persisted) {
      persisted = await navigator.storage.persisted()
    }
    if (navigator.storage?.estimate) {
      const { usage, quota } = await navigator.storage.estimate()
      if (usage !== undefined && quota !== undefined) {
        const mb = (n: number) => (n / (1024 * 1024)).toFixed(1)
        estimateText = `${mb(usage)} MB of ${mb(quota)} MB`
      }
    }
  })

  // --- code dictionary (offline names for coded records; see
  // lib/dictionary.ts). Opt-in; files come only from this app's own origin. ---
  let dictManifest = $state<DictManifest | null>(null)
  let dictBusy = $state(false)
  let dictError = $state('')
  let dictUpdate = $state('')

  onMount(refreshDictionaryStatus)

  function formatMb(bytes: number): string {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  }

  /** "RxNorm ✓ ICD-10 … CVX ✗" — the per-file checkmark line shared by the
   * downloading, failed, and installed views. */
  function fileChecklist(statuses: { label: string; state: string }[]): string {
    return statuses
      .map((f) => `${f.label} ${f.state === 'verified' ? '✓' : f.state === 'failed' ? '✗' : '…'}`)
      .join(' ')
  }

  function joinList(items: string[]): string {
    if (items.length === 0) return ''
    if (items.length === 1) return items[0]
    if (items.length === 2) return `${items[0]} and ${items[1]}`
    return `${items.slice(0, -1).join(', ')}, and ${items[items.length - 1]}`
  }

  /** "ICD-10 (8.2 MB) failed to verify. RxNorm and CVX are saved — retry
   * continues from ICD-10." Reads the store directly rather than taking a
   * parameter so it always reflects the latest attempt. */
  function dictFailedBody(): string {
    const failed = $dictionaryStatus.failedFile
    if (!failed) return 'Something went wrong. Try again.'
    const saved = $dictionaryStatus.fileStatuses.filter((f) => f.state === 'verified').map((f) => f.label)
    const savedText = saved.length
      ? `${joinList(saved)} ${saved.length === 1 ? 'is' : 'are'} saved — retry continues from ${failed.label}.`
      : `Retry will start from ${failed.label}.`
    return `${failed.label} (${formatMb(failed.bytes)}) failed to verify. ${savedText}`
  }

  // True once a download attempt has failed and hasn't yet been retried
  // successfully. Checked ahead of `enabled` in the template below, because a
  // failed *update* leaves the previously-installed dictionary marked enabled
  // — without that ordering the failure would be silently swallowed by the
  // installed view instead of offering Retry.
  const dictFailed = $derived($dictionaryStatus.failedFile !== null && !$dictionaryStatus.downloading)

  async function previewDictionary() {
    dictError = ''
    dictUpdate = ''
    dictBusy = true
    try {
      dictManifest = await fetchManifest()
    } catch (err) {
      dictError = err instanceof Error ? err.message : 'Could not reach the dictionary.'
    } finally {
      dictBusy = false
    }
  }

  async function enableDictionary() {
    dictError = ''
    dictBusy = true
    try {
      // Snapshot, not the raw $state proxy: downloadDictionary stores the
      // manifest via IndexedDB's structured-clone put, which cannot serialize
      // a reactivity proxy ("The object can not be cloned") — same pitfall as
      // TagEditor's commit().
      await downloadDictionary(dictManifest ? $state.snapshot(dictManifest) : undefined)
      dictManifest = null
      dictUpdate = ''
    } catch (err) {
      // A per-file failure is already reflected in $dictionaryStatus
      // (error + failedFile) and rendered by the failed-state view below;
      // this only catches fetchManifest() failing before a download starts.
      if (!$dictionaryStatus.failedFile) {
        dictError = err instanceof Error ? err.message : 'Could not reach the dictionary.'
      }
    } finally {
      dictBusy = false
    }
  }

  async function removeDict() {
    dictError = ''
    dictUpdate = ''
    await removeDictionary()
    dictManifest = null
  }

  async function checkDictUpdate() {
    dictError = ''
    dictUpdate = ''
    dictBusy = true
    try {
      const r = await checkForUpdate()
      dictUpdate = r.updateAvailable
        ? `An update is available (${r.latest}).`
        : `You have the latest version (${r.latest}).`
      if (r.updateAvailable) dictManifest = await fetchManifest()
    } catch (err) {
      dictError = err instanceof Error ? err.message : 'Could not check for updates.'
    } finally {
      dictBusy = false
    }
  }

  const version = contract_version()

  // --- plaintext export (see lib/export.ts's module doc comment: one-way
  // out, no matching import path) ---
  let showExportConfirm = $state(false)
  let exportBusy = $state(false)
  let exportError = $state('')

  async function doExportPlaintext() {
    exportError = ''
    exportBusy = true
    try {
      const [events, curation, provenance] = await Promise.all([
        allEvents(),
        getAll<CurationRecord>('curation'),
        getAll<ProvenanceRecord>('provenance'),
      ])
      const now = new Date()
      const built = buildPlaintextExport(events, curation, provenanceMeta(provenance), version, now)
      downloadJson(plaintextExportFilename(now), JSON.stringify(built, null, 2))
      showExportConfirm = false
    } catch (err) {
      exportError = err instanceof Error ? err.message : 'Could not build the export.'
    } finally {
      exportBusy = false
    }
  }

  // --- encrypted backup (see lib/export.ts: the same sealed blobs the relay
  // stores, packaged into one file; importable, unlike the plaintext export) ---
  let exportEncBusy = $state(false)
  let exportEncError = $state('')

  async function doExportEncrypted() {
    exportEncError = ''
    const { identity, vaultKey } = session
    if (!identity || !vaultKey) {
      exportEncError = 'Unlock your vault first.'
      return
    }
    exportEncBusy = true
    try {
      const now = new Date()
      const built = await buildEncryptedExport({
        ids: await listLocalBlobIds(),
        seal: (id) => sealLocalBlob(id, vaultKey),
        // Self-wrap idiom from vault.ts's ensureVaultKeyBlob — the same bytes
        // the relay's vault.key blob holds.
        wrappedVaultKey: vaultKey.wrap_to(fromHex(identity.x25519_public_hex)),
        contractVersion: version,
        now,
      })
      downloadJson(encryptedExportFilename(now), JSON.stringify(built))
    } catch (err) {
      exportEncError = err instanceof Error ? err.message : 'Could not build the backup.'
    } finally {
      exportEncBusy = false
    }
  }

  // --- restore from backup ---
  let importBusy = $state(false)
  let importError = $state('')
  let importResult = $state('')

  function summarizeImport(s: ImportSummary): string {
    const ev = `${s.events.new} new event${s.events.new === 1 ? '' : 's'} (${s.events.duplicate} already present)`
    const docs = `${s.docs.new} document${s.docs.new === 1 ? '' : 's'}`
    const cur = `${s.curation.merged} curation record${s.curation.merged === 1 ? '' : 's'} merged`
    let line = `Imported ${ev}, ${docs}, ${cur}.`
    if (s.staleVaultKey) line += ' Backup used an older vault key.'
    if (s.failed.length) {
      line += ` ${s.failed.length} blob${s.failed.length === 1 ? '' : 's'} could not be imported.`
    }
    return line
  }

  async function onBackupFile(e: Event) {
    const input = e.target as HTMLInputElement
    const file = input.files?.[0]
    if (!file) return
    importError = ''
    importResult = ''
    const { identity, vaultKey } = session
    if (!identity || !vaultKey) {
      importError = 'Unlock your vault first.'
      input.value = ''
      return
    }
    importBusy = true
    try {
      const parsed = parseEncryptedExport(await file.text())
      const summary = await importEncryptedExport(parsed, {
        unwrapKey: (wrapped) => identity.unwrap_key(wrapped),
        sessionKeyBytes: vaultKey.to_bytes(),
        keyBytes: (k) => (k as unknown as { to_bytes(): Uint8Array }).to_bytes(),
        apply: applySealedBlob,
        enqueue,
        drain,
      })
      importResult = summarizeImport(summary)
    } catch (err) {
      importError = err instanceof Error ? err.message : 'Could not import that backup.'
    } finally {
      importBusy = false
      input.value = '' // let the same file be re-selected
    }
  }
</script>

<h1>Your data</h1>

<section class="stack">
  <h2>Storage</h2>
  <p data-testid="storage-persisted">
    Persisted: {persisted === null ? 'unknown' : persisted ? 'yes' : 'no'}
  </p>
  {#if estimateText}
    <p class="muted" data-testid="storage-estimate">{estimateText}</p>
  {/if}
</section>

<section class="stack">
  <h2>Code dictionary</h2>
  <p class="muted">
    Optional offline names for lab, medication, diagnosis, and vaccine codes that were imported
    without a readable label. The files download only from this app — no code is ever looked up
    against an outside service — and work offline once stored.
  </p>

  {#if $dictionaryStatus.downloading}
    <p data-testid="dict-progress">
      Downloading{$dictionaryStatus.progress
        ? ` ${$dictionaryStatus.progress.done} of ${$dictionaryStatus.progress.total}`
        : ''}…
    </p>
    {#if $dictionaryStatus.fileStatuses.length}
      <p class="muted" data-testid="dict-file-progress">
        {fileChecklist($dictionaryStatus.fileStatuses)}
      </p>
    {/if}
  {:else if dictFailed}
    <p class="error" data-testid="dict-failed-title">Download didn't finish</p>
    <p class="error" data-testid="dict-failed-body">{dictFailedBody()}</p>
    <button class="primary" onclick={enableDictionary} disabled={dictBusy} data-testid="dict-retry">
      {dictBusy ? 'Retrying…' : 'Retry'}
    </button>
  {:else if $dictionaryStatus.enabled}
    <dl>
      <dt>Version</dt>
      <dd class="data" data-testid="dict-version">{$dictionaryStatus.version}</dd>
      <dt>Names</dt>
      <dd data-testid="dict-entry-count">{$dictionaryStatus.entryCount.toLocaleString()}</dd>
    </dl>
    <p class="muted" data-testid="dict-installed-summary">
      {$dictionaryStatus.version} edition · {$dictionaryStatus.entryCount.toLocaleString()} names ·
      {fileChecklist($dictionaryStatus.fileStatuses)}
    </p>
    {#if dictUpdate}
      <p class="muted" data-testid="dict-update-status">{dictUpdate}</p>
    {/if}
    <div class="swatches">
      <button onclick={checkDictUpdate} disabled={dictBusy} data-testid="dict-check-update">
        {dictBusy ? 'Checking…' : 'Check for updates'}
      </button>
      {#if dictManifest}
        <button class="primary" onclick={enableDictionary} disabled={dictBusy} data-testid="dict-update">
          {dictBusy ? 'Updating…' : `Update (${formatMb(manifestBytes(dictManifest))})`}
        </button>
      {/if}
      <button class="ghost" onclick={removeDict} disabled={dictBusy} data-testid="dict-remove">
        Remove
      </button>
    </div>
  {:else if dictManifest}
    <p data-testid="dict-size">
      {formatMb(manifestBytes(dictManifest))} across {dictManifest.files.length} code sets.
    </p>
    <button class="primary" onclick={enableDictionary} disabled={dictBusy} data-testid="dict-download">
      {dictBusy ? 'Downloading…' : `Download ${formatMb(manifestBytes(dictManifest))}`}
    </button>
  {:else}
    <button onclick={previewDictionary} disabled={dictBusy} data-testid="dict-preview">
      {dictBusy ? 'Checking…' : 'Check download size'}
    </button>
  {/if}

  {#if dictError}
    <p class="error" data-testid="dict-error">{dictError}</p>
  {/if}

  {#if $dictionaryStatus.enabled || dictManifest}
    {@const files = $dictionaryStatus.enabled ? $dictionaryStatus.files : dictManifest?.files ?? []}
    <div class="attributions" data-testid="dict-attributions">
      {#each files as f (f.label)}
        <p class="attribution">{f.attribution}</p>
      {/each}
    </div>
  {/if}
</section>

<section class="stack">
  <h2>Import</h2>
  <p class="muted">Bring in records from a C-CDA export or a FHIR bundle.</p>
  <button onclick={() => navigate('#/import')} data-testid="nav-import">Import records</button>
</section>

<section class="stack">
  <h2>Export &amp; backup</h2>

  <button onclick={doExportEncrypted} disabled={exportEncBusy} data-testid="export-encrypted">
    {exportEncBusy ? 'Preparing…' : 'Download encrypted backup'}
  </button>
  <p class="muted">Encrypted with your vault key — only your seed phrase can open it.</p>
  {#if exportEncError}
    <p class="error" data-testid="export-encrypted-error">{exportEncError}</p>
  {/if}

  <p class="muted">
    You can also export your events, tags, and notes as <strong>unencrypted</strong> JSON — a
    one-way export for reading elsewhere, not a backup you can restore. Does not include the
    original imported documents.
  </p>
  <button
    class="tonal"
    onclick={() => (showExportConfirm = true)}
    data-testid="export-plaintext"
  >
    Export unencrypted JSON…
  </button>

  <h3>Restore from backup</h3>
  <p class="muted">
    Import an encrypted backup. Records already on this device are skipped automatically.
  </p>
  <label class="file-picker" class:busy={importBusy}>
    {importBusy ? 'Importing…' : 'Choose backup file'}
    <input
      class="visually-hidden"
      type="file"
      accept=".json"
      disabled={importBusy}
      onchange={onBackupFile}
      data-testid="import-backup-input"
    />
  </label>
  {#if importResult}
    <p data-testid="import-backup-result">{importResult}</p>
  {/if}
  {#if importError}
    <p class="error" data-testid="import-backup-error">{importError}</p>
  {/if}
</section>

{#if showExportConfirm}
  <Sheet onclose={() => (showExportConfirm = false)}>
    <h2>Export your records unencrypted?</h2>
    <p>
      The downloaded file will contain your <strong>unencrypted medical data</strong>, readable by
      anyone who gets hold of it. Store it carefully and delete it when you're done with it.
    </p>
    {#if exportError}
      <p class="error" data-testid="export-plaintext-error">{exportError}</p>
    {/if}
    <div class="row">
      <button class="ghost" onclick={() => (showExportConfirm = false)}>Cancel</button>
      <button
        class="danger-outline"
        onclick={doExportPlaintext}
        disabled={exportBusy}
        data-testid="confirm-export-plaintext"
      >
        {exportBusy ? 'Exporting…' : 'Export'}
      </button>
    </div>
  </Sheet>
{/if}

<style>
  section {
    margin-top: var(--space-6);
  }

  dl {
    display: grid;
    grid-template-columns: max-content 1fr;
    gap: var(--space-1) var(--space-4);
  }

  dt {
    color: var(--muted);
    font-size: var(--text-sm);
  }

  dd {
    margin: 0;
  }

  .swatches {
    display: flex;
    gap: var(--space-3);
  }

  /* Sub-heading within a section (Restore, under Export & backup); extra top
     margin so it reads as a new block, not a caption on the export button. */
  h3 {
    font-size: var(--text-sm);
    margin: var(--space-5) 0 0;
  }

  /* A file <input> wrapped in a label, styled to read as a tonal button — the
     hidden-input picker pattern Import.svelte uses, dressed up as a control. */
  .file-picker {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-height: 44px;
    padding: var(--space-2) var(--space-4);
    border: 1px solid transparent;
    border-radius: var(--radius-sm);
    background: var(--action-muted);
    cursor: pointer;
    align-self: flex-start;
  }

  .file-picker.busy {
    cursor: not-allowed;
    opacity: 0.5;
  }

  .visually-hidden {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
  }

  .attributions {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    margin-top: var(--space-2);
  }

  /* Legal/courtesy notices — deliberately quiet but must stay legible (the
     LOINC line is a license requirement, not decoration). */
  .attribution {
    font-size: var(--text-xs);
    color: var(--muted);
    margin: 0;
  }

  /* Confirm-sheet action row (matches Unlock.svelte's forgot sheet). */
  .row {
    display: flex;
    gap: var(--space-2);
    margin-top: var(--space-4);
  }

  .row button {
    flex: 1;
  }
</style>
