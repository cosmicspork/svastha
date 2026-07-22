<script lang="ts">
  import { onMount } from 'svelte'
  import { contract_version } from '../lib/svastha'
  import { session } from '../lib/session.svelte'
  import {
    unlock,
    changePassphrase,
    WrongPassphraseError,
    enrollPasskey as storePasskey,
    listPasskeys,
    removePasskey,
    type PasskeyRecord,
  } from '../lib/keyvault'
  import {
    passkeysSupported,
    enrollPasskey as createPasskey,
    PasskeyNotSupportedError,
    PasskeyCeremonyError,
  } from '../lib/passkey'
  import { get, put, del, getAll } from '../lib/db'
  import Sheet from '../components/Sheet.svelte'
  import { RelayClient, checkRelayInfo, normalizeRelayUrl } from '../lib/relay'
  import { connectRelay } from '../lib/vault'
  import {
    syncTeardown,
    syncStatus,
    pullAll,
    listLocalBlobIds,
    sealLocalBlob,
    applySealedBlob,
    enqueue,
    drain,
    type ProvenanceRecord,
  } from '../lib/sync'
  import { navigate } from '../lib/router.svelte'
  import { loadTheme, setTheme, type ThemePref } from '../lib/theme'
  import { dismissInstallNudge } from '../lib/install'
  import InstallSheet from '../components/InstallSheet.svelte'
  import { copySensitive } from '../lib/clipboard'
  import { deviceLinkUrl, codeQrSvg } from '../lib/exchange'
  import { allEvents } from '../lib/events'
  import type { CurationRecord } from '../lib/curation'
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
  } from '../lib/export'
  import { fromHex } from '../lib/hex'
  import {
    dictionaryStatus,
    fetchManifest,
    manifestBytes,
    downloadDictionary,
    removeDictionary,
    refreshDictionaryStatus,
    checkForUpdate,
    type DictManifest,
  } from '../lib/dictionary'

  /** Show a public key as spaced hex byte-groups, truncated — enough to eyeball
   * a match, not the full 64-char key. */
  function fingerprint(hex: string, groups = 8): string {
    return (hex.match(/.{2}/g) ?? []).slice(0, groups).join(' ') + '…'
  }

  const ed25519 = $derived(session.identity ? fingerprint(session.identity.ed25519_public_hex) : '')
  const x25519 = $derived(session.identity ? fingerprint(session.identity.x25519_public_hex) : '')

  // --- show seed phrase ---
  let showingSeedForm = $state(false)
  let seedPassphrase = $state('')
  let seedError = $state('')
  let revealedMnemonic = $state('')

  async function revealSeed(e: SubmitEvent) {
    e.preventDefault()
    seedError = ''
    try {
      const { identity } = await unlock(seedPassphrase)
      revealedMnemonic = identity.mnemonic ?? ''
      showingSeedForm = false
    } catch (err) {
      seedError = err instanceof WrongPassphraseError ? err.message : 'Could not verify that passphrase.'
    }
  }

  let seedCopied = $state(false)

  async function copyRevealedMnemonic() {
    await copySensitive(revealedMnemonic)
    seedCopied = true
    setTimeout(() => (seedCopied = false), 2500)
  }

  // --- change passphrase ---
  let oldPassphrase = $state('')
  let newPassphrase = $state('')
  let newPassphraseConfirm = $state('')
  let changeError = $state('')
  let changeDone = $state(false)

  async function submitChangePassphrase(e: SubmitEvent) {
    e.preventDefault()
    changeError = ''
    changeDone = false
    if (newPassphrase.length < 8) {
      changeError = 'Use at least 8 characters.'
      return
    }
    if (newPassphrase !== newPassphraseConfirm) {
      changeError = "Those passphrases don't match."
      return
    }
    try {
      await changePassphrase(oldPassphrase, newPassphrase)
      oldPassphrase = ''
      newPassphrase = ''
      newPassphraseConfirm = ''
      changeDone = true
    } catch (err) {
      changeError = err instanceof WrongPassphraseError ? err.message : 'Could not change passphrase.'
    }
  }

  // --- passkeys (alternative unlock; see lib/passkey.ts + keyvault.ts) ---
  const passkeysAvailable = passkeysSupported()
  let passkeys = $state<PasskeyRecord[]>([])
  let passkeyBusy = $state(false)
  let passkeyError = $state('')
  let passkeyNotice = $state('')
  let confirmRemove = $state<PasskeyRecord | null>(null)

  onMount(async () => {
    if (passkeysAvailable) passkeys = await listPasskeys()
  })

  async function addPasskey() {
    passkeyError = ''
    passkeyNotice = ''
    const { identity, vaultKey, wrapKey } = session
    if (!identity || !vaultKey || !wrapKey) return
    passkeyBusy = true
    try {
      const created = await createPasskey(passkeys.map((p) => p.credId))
      const label = `Passkey · ${created.credId.slice(0, 6)}`
      const mk = await storePasskey(
        { identity, vaultKey, wrapKey },
        created.secret,
        { credId: created.credId, rpId: created.rpId, label },
      )
      // Migrating v1->v2 swaps the session's wrap key from kdfOut to MK, so a
      // later relay-won key adoption reseals the right (canonical) record.
      session.wrapKey = mk
      passkeys = await listPasskeys()
    } catch (err) {
      if (err instanceof PasskeyCeremonyError) {
        // A cancel and a platform refusal look identical to WebAuthn, so name
        // the outcome and show the underlying reason rather than guessing.
        passkeyNotice = `No passkey was added (${err.detail}).`
      } else {
        passkeyError =
          err instanceof PasskeyNotSupportedError ? err.message : 'Could not add a passkey — try again.'
      }
    } finally {
      passkeyBusy = false
    }
  }

  async function doRemovePasskey() {
    if (!confirmRemove) return
    await removePasskey(confirmRemove.credId)
    confirmRemove = null
    passkeys = await listPasskeys()
  }

  // --- appearance ---
  let theme = $state<ThemePref>('system')
  onMount(async () => {
    theme = await loadTheme()
  })
  async function pickTheme(pref: ThemePref) {
    theme = pref
    await setTheme(pref)
  }

  let hue = $state<'a' | 'b'>('a')
  onMount(async () => {
    const stored = await get<'a' | 'b'>('prefs', 'hue')
    if (stored) hue = stored
  })
  async function setHue(value: 'a' | 'b') {
    hue = value
    await put('prefs', value, 'hue')
  }

  let fabHand = $state<'right' | 'left'>('right')
  onMount(async () => {
    const stored = await get<'right' | 'left'>('prefs', 'fab-hand')
    if (stored) fabHand = stored
  })
  async function setFabHand(value: 'right' | 'left') {
    fabHand = value
    await put('prefs', value, 'fab-hand')
  }

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
      await downloadDictionary(dictManifest ?? (await fetchManifest()))
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

  // --- relay sync ---
  let relayUrlInput = $state('')
  let relayConnected = $state(false)
  let relayError = $state('')
  let relayBusy = $state(false)

  onMount(async () => {
    const stored = await get<string>('prefs', 'relayUrl')
    if (stored) {
      relayUrlInput = stored
      relayConnected = true
    }
  })

  const lastPullText = $derived(
    $syncStatus.lastPullAt ? new Date($syncStatus.lastPullAt).toLocaleTimeString() : 'never',
  )

  async function submitConnect(e: SubmitEvent) {
    e.preventDefault()
    relayError = ''
    if (!session.identity) return

    const url = normalizeRelayUrl(relayUrlInput)
    relayBusy = true
    try {
      await checkRelayInfo(url)
      await put('prefs', url, 'relayUrl')
      relayUrlInput = url
      await connectRelay(new RelayClient(url, session.identity))
      relayConnected = true
    } catch (err) {
      relayError = err instanceof Error ? err.message : 'Could not connect to the relay.'
    } finally {
      relayBusy = false
    }
  }

  async function disconnect() {
    // Stops pushing/pulling and forgets the relay URL; the local event log
    // (and everything already pushed) is untouched.
    syncTeardown()
    await del('prefs', 'relayUrl')
    relayConnected = false
    relayUrlInput = ''
  }

  function syncNow() {
    void pullAll()
  }

  // --- link another device (device → device QR linking) ---
  // The new device's native camera opens this directly — no in-app scanner,
  // no new relay protocol. It lands the new device on Onboard's restore tab
  // with this relay prefilled (see `Onboard.svelte`'s `relay=` handling); the
  // seed phrase itself is entered by hand there, never carried by the QR.
  let showLinkDevice = $state(false)
  const linkDeviceUrl = $derived(deviceLinkUrl(window.location.origin, relayUrlInput))
  const linkDeviceQrSvg = $derived(showLinkDevice ? codeQrSvg(linkDeviceUrl) : '')

  // --- install instructions ---
  let showInstallSheet = $state(false)

  async function closeInstallSheet(): Promise<void> {
    // Idempotent with the first-run nudge's pref write — reopening from here
    // isn't itself a nudge, but writing the same "dismissed" flag again is
    // harmless and keeps this component as dumb as the sheet it wraps.
    await dismissInstallNudge()
    showInstallSheet = false
  }

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

<h1>Settings</h1>

<section class="stack">
  <h2>Identity</h2>
  <dl>
    <dt>Ed25519 fingerprint</dt>
    <dd class="data" data-testid="ed25519-fingerprint">{ed25519}</dd>
    <dt>X25519 fingerprint</dt>
    <dd class="data" data-testid="x25519-fingerprint">{x25519}</dd>
  </dl>

  {#if revealedMnemonic}
    <p class="error">Anyone who sees this can restore your identity. Keep it private.</p>
    <p class="data" data-testid="revealed-mnemonic">{revealedMnemonic}</p>
    <button
      class="tonal"
      style:width="100%"
      onclick={copyRevealedMnemonic}
      data-testid="copy-mnemonic-settings"
    >
      {seedCopied ? 'Copied — clears in 60 s' : 'Copy phrase'}
    </button>
    <p class="warnnote">
      Paper is still the safest home for these words. If you copy, paste into a password manager
      right away — the clipboard clears itself in 60 seconds.
    </p>
  {:else if showingSeedForm}
    <form class="stack" onsubmit={revealSeed}>
      <label>
        Passphrase
        <input type="password" bind:value={seedPassphrase} data-testid="reveal-passphrase" />
      </label>
      {#if seedError}
        <p class="error" data-testid="reveal-error">{seedError}</p>
      {/if}
      <button type="submit" data-testid="reveal-submit">Confirm</button>
    </form>
  {:else}
    <button onclick={() => (showingSeedForm = true)} data-testid="show-seed-phrase">
      Show seed phrase
    </button>
  {/if}
</section>

<section class="stack">
  <h2>Security</h2>
  <form class="stack" onsubmit={submitChangePassphrase}>
    <label>
      Current passphrase
      <input type="password" bind:value={oldPassphrase} data-testid="change-old-passphrase" />
    </label>
    <label>
      New passphrase
      <input type="password" bind:value={newPassphrase} data-testid="change-new-passphrase" />
    </label>
    <label>
      Confirm new passphrase
      <input
        type="password"
        bind:value={newPassphraseConfirm}
        data-testid="change-new-passphrase-confirm"
      />
    </label>
    {#if changeError}
      <p class="error" data-testid="change-passphrase-error">{changeError}</p>
    {/if}
    {#if changeDone}
      <p data-testid="change-passphrase-done">Passphrase changed.</p>
    {/if}
    <button type="submit" data-testid="change-passphrase-submit">Change passphrase</button>
  </form>
</section>

<section class="stack">
  <h2>Passkeys</h2>
  {#if !passkeysAvailable}
    <p class="muted" data-testid="passkey-unsupported">
      This browser doesn't support passkeys. Your passphrase unlocks the vault.
    </p>
  {:else}
    <p class="muted">
      Unlock this device with Face ID, Touch ID, or a passkey from your password manager. Your
      passphrase always still works, and your seed phrase is still the only way to recover.
    </p>
    {#if passkeys.length}
      <ul class="passkeys" data-testid="passkey-list">
        {#each passkeys as pk (pk.credId)}
          <li>
            <span class="data">{pk.label}</span>
            <button class="ghost" onclick={() => (confirmRemove = pk)} data-testid="remove-passkey">
              Remove
            </button>
          </li>
        {/each}
      </ul>
    {/if}
    {#if passkeyError}
      <p class="error" data-testid="passkey-error">{passkeyError}</p>
    {/if}
    {#if passkeyNotice}
      <p class="muted" data-testid="passkey-notice">{passkeyNotice}</p>
    {/if}
    <button onclick={addPasskey} disabled={passkeyBusy} data-testid="add-passkey">
      {passkeyBusy ? 'Follow the prompts…' : 'Add a passkey'}
    </button>
    <p class="hint">
      Adding a passkey asks for two confirmations — once to create it, once to link it to your
      vault.
    </p>
  {/if}
</section>

<section class="stack">
  <h2>Appearance</h2>
  <div class="setrow">
    <span class="l">Theme</span>
    <div class="seg" style:width="13rem">
      <button
        aria-pressed={theme === 'light'}
        onclick={() => pickTheme('light')}
        data-testid="theme-light"
      >
        Light
      </button>
      <button
        aria-pressed={theme === 'dark'}
        onclick={() => pickTheme('dark')}
        data-testid="theme-dark"
      >
        Dark
      </button>
      <button
        aria-pressed={theme === 'system'}
        onclick={() => pickTheme('system')}
        data-testid="theme-system"
      >
        System
      </button>
    </div>
  </div>
  <div class="setrow">
    <span class="l">Timeline accent<small>Colors the spine of your own record</small></span>
    <div class="swatches">
      <button
        class="swatch"
        style:background="var(--person-a)"
        aria-pressed={hue === 'a'}
        onclick={() => setHue('a')}
        data-testid="hue-a"
        aria-label="Indigo"
      ></button>
      <button
        class="swatch"
        style:background="var(--person-b)"
        aria-pressed={hue === 'b'}
        onclick={() => setHue('b')}
        data-testid="hue-b"
        aria-label="Madder"
      ></button>
    </div>
  </div>
  <div class="setrow">
    <span class="l">Add button<small>Which thumb opens the bloom</small></span>
    <div class="seg" style:width="10rem">
      <button
        aria-pressed={fabHand === 'right'}
        onclick={() => setFabHand('right')}
        data-testid="fab-hand-right"
      >
        Right
      </button>
      <button
        aria-pressed={fabHand === 'left'}
        onclick={() => setFabHand('left')}
        data-testid="fab-hand-left"
      >
        Left
      </button>
    </div>
  </div>
</section>

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
  <h2>Sync</h2>
  {#if !relayConnected}
    <form class="stack" onsubmit={submitConnect}>
      <label>
        Relay URL
        <input
          bind:value={relayUrlInput}
          placeholder="https://relay.example.com"
          data-testid="relay-url"
        />
      </label>
      {#if relayError}
        <p class="error" data-testid="relay-error">{relayError}</p>
      {/if}
      <button type="submit" class="primary" disabled={relayBusy} data-testid="relay-connect">
        Connect
      </button>
    </form>
  {:else}
    <dl>
      <dt>Relay</dt>
      <dd class="data" data-testid="relay-connected-url">{relayUrlInput}</dd>
      <dt>Status</dt>
      <dd data-testid="sync-online">{$syncStatus.online ? 'Online' : 'Offline'}</dd>
      <dt>Pending</dt>
      <dd data-testid="sync-pending">{$syncStatus.pendingCount}</dd>
      <dt>Last pull</dt>
      <dd data-testid="sync-last-pull">{lastPullText}</dd>
      {#if $syncStatus.lastError}
        <dt>Last error</dt>
        <dd class="error" data-testid="sync-last-error">{$syncStatus.lastError}</dd>
      {/if}
    </dl>
    <div class="swatches">
      <button onclick={syncNow} data-testid="sync-now">Sync now</button>
      <button onclick={disconnect} data-testid="relay-disconnect">Disconnect</button>
    </div>
    <button
      class="ghost"
      onclick={() => (showLinkDevice = !showLinkDevice)}
      data-testid="link-device"
    >
      Link another device
    </button>
    {#if showLinkDevice}
      <!-- App-generated URL, never user input — see exchange.ts's codeQrSvg doc comment. -->
      <!-- eslint-disable-next-line svelte/no-at-html-tags -->
      <div class="qr" data-testid="link-device-qr">{@html linkDeviceQrSvg}</div>
      <p class="data" data-testid="link-device-url">{linkDeviceUrl}</p>
      <p class="muted">
        Scan with the new device's camera. You'll enter your seed phrase there — it never travels
        in this code.
      </p>
    {/if}
  {/if}
</section>

<section class="stack">
  <h2>Import</h2>
  <p class="muted">Bring in records from a C-CDA export or a FHIR bundle.</p>
  <button onclick={() => navigate('#/import')} data-testid="nav-import">Import records</button>
</section>

<section class="stack">
  <h2>Export & backup</h2>

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

{#if relayConnected}
  <section class="stack">
    <h2>Sharing</h2>
    <p class="muted">Give your partner ongoing, read-only access to your vault.</p>
    <button onclick={() => navigate('#/share')} data-testid="nav-share">Share my vault</button>
  </section>
{/if}

<section class="stack">
  <h2>About</h2>
  <p class="muted" data-testid="about-app-version">Svastha v{__APP_VERSION__}</p>
  <p class="muted" data-testid="about-version">Trust contract v{version}</p>
  <button
    class="ghost"
    onclick={() => (showInstallSheet = true)}
    data-testid="install-instructions"
  >
    Install instructions
  </button>
</section>

{#if showInstallSheet}
  <InstallSheet onclose={closeInstallSheet} />
{/if}

{#if confirmRemove}
  <Sheet onclose={() => (confirmRemove = null)}>
    <h2>Remove this passkey?</h2>
    <p>
      This device won't unlock with it anymore. Your passphrase still works. The passkey itself
      stays in your password manager until you delete it there.
    </p>
    <div class="row">
      <button class="ghost" onclick={() => (confirmRemove = null)}>Cancel</button>
      <button class="danger-outline" onclick={doRemovePasskey} data-testid="confirm-remove-passkey">
        Remove
      </button>
    </div>
  </Sheet>
{/if}

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

  label {
    display: block;
    font-size: var(--text-sm);
    color: var(--muted);
  }

  /* A settings row: a label (with optional muted caption) paired with its
     control, e.g. the .seg theme picker or the hue swatches below. */
  .setrow {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-3);
    margin-bottom: var(--space-3);
  }

  .setrow .l {
    font-size: var(--text-sm);
  }

  .setrow .l small {
    display: block;
    color: var(--muted);
    font-size: var(--text-xs);
  }

  .swatches {
    display: flex;
    gap: var(--space-3);
  }

  /* Sub-heading within a section (Restore, under Export & backup). */
  h3 {
    font-size: var(--text-sm);
    margin: var(--space-2) 0 0;
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

  .passkeys {
    list-style: none;
    padding: 0;
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }

  .passkeys li {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-3);
  }

  .hint {
    font-size: var(--text-xs);
    color: var(--muted);
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

  .qr :global(svg) {
    width: 200px;
    height: 200px;
  }

  .swatch {
    width: 44px;
    height: 44px;
    border-radius: 50%;
    border: 2px solid transparent;
    padding: 0;
  }

  .swatch[aria-pressed='true'] {
    border-color: var(--text);
  }

  /* Honest-tradeoff caption under the copy-phrase button (Onboard.svelte
     repeats this verbatim for the create-flow words step). */
  .warnnote {
    font-size: var(--text-xs);
    color: var(--muted);
    border-left: 2px solid var(--flare);
    padding-left: var(--space-3);
  }
</style>
