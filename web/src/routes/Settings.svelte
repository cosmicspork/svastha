<script lang="ts">
  import { onMount } from 'svelte'
  import { contract_version } from '../lib/svastha'
  import { session } from '../lib/session.svelte'
  import { unlock, changePassphrase, WrongPassphraseError } from '../lib/keyvault'
  import { get, put, del } from '../lib/db'
  import { RelayClient, checkRelayInfo, normalizeRelayUrl } from '../lib/relay'
  import { connectRelay } from '../lib/vault'
  import { syncTeardown, syncStatus, pullAll } from '../lib/sync'
  import { navigate } from '../lib/router.svelte'
  import { loadTheme, setTheme, type ThemePref } from '../lib/theme'
  import { dismissInstallNudge } from '../lib/install'
  import InstallSheet from '../components/InstallSheet.svelte'
  import { copySensitive } from '../lib/clipboard'

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

  // --- install instructions ---
  let showInstallSheet = $state(false)

  async function closeInstallSheet(): Promise<void> {
    // Idempotent with the first-run nudge's pref write — reopening from here
    // isn't itself a nudge, but writing the same "dismissed" flag again is
    // harmless and keeps this component as dumb as the sheet it wraps.
    await dismissInstallNudge()
    showInstallSheet = false
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
  {/if}
</section>

<section class="stack">
  <h2>Import</h2>
  <p class="muted">Bring in records from a C-CDA export or a FHIR bundle.</p>
  <button onclick={() => navigate('#/import')} data-testid="nav-import">Import records</button>
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
