<script lang="ts">
  import { initSvastha, WasmIdentity } from '../lib/svastha'
  import { initVault, unlock } from '../lib/keyvault'
  import { setSession } from '../lib/session.svelte'
  import { navigate } from '../lib/router.svelte'
  import { RelayClient, checkRelayInfo, normalizeRelayUrl } from '../lib/relay'
  import { connectRelay } from '../lib/vault'
  import { pullAll, syncStatus } from '../lib/sync'
  import { put } from '../lib/db'
  import { copySensitive } from '../lib/clipboard'

  let { onCreated }: { onCreated: () => void } = $props()

  type Tab = 'create' | 'restore'
  const hashParams = new URLSearchParams(window.location.hash.split('?')[1] ?? '')

  // Device → device linking: Settings' "Link another device" QR encodes
  // `#/onboard?relay={relay url}` (see `lib/exchange.ts`'s `deviceLinkUrl`).
  // The new device's camera opens this directly — no in-app scanner. A
  // malformed value is discarded rather than surfaced as an error: this
  // param is just a convenience prefill, and the restore tab still works
  // with the relay field left blank or typed by hand.
  function parseLinkedRelay(relayParam: string | null): { url: string; hostname: string } | null {
    if (!relayParam) return null
    try {
      const parsed = new URL(relayParam)
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
        return { url: relayParam, hostname: parsed.hostname }
      }
    } catch {
      // Not a valid URL — ignore the param entirely.
    }
    return null
  }
  const linkedRelay = parseLinkedRelay(hashParams.get('relay'))
  const linkRelayUrl = linkedRelay?.url ?? ''
  const linkRelayHostname = linkedRelay?.hostname ?? ''

  const initialTab: Tab =
    linkRelayHostname || hashParams.get('tab') === 'restore' ? 'restore' : 'create'
  let tab = $state<Tab>(initialTab)

  // --- create flow ---
  type CreateStep = 'intro' | 'words' | 'confirm' | 'passphrase'
  let createStep = $state<CreateStep>('intro')
  let identity = $state<WasmIdentity | null>(null)
  let words = $derived(identity?.mnemonic?.split(' ') ?? [])

  let confirmPositions = $state<number[]>([])
  let confirmInputs = $state<Record<number, string>>({})
  let confirmError = $state('')

  let passphrase = $state('')
  let passphraseConfirm = $state('')
  let passphraseError = $state('')
  let busy = $state(false)
  let persistNote = $state('')

  async function generate() {
    await initSvastha()
    identity = WasmIdentity.generate()
    createStep = 'words'
  }

  let mnemonicCopied = $state(false)

  async function copyMnemonic() {
    await copySensitive(words.join(' '))
    mnemonicCopied = true
    setTimeout(() => (mnemonicCopied = false), 2500)
  }

  function pickConfirmPositions() {
    const positions = new Set<number>()
    while (positions.size < 3) {
      positions.add(1 + Math.floor(Math.random() * words.length))
    }
    confirmPositions = [...positions].sort((a, b) => a - b)
    confirmInputs = {}
    confirmError = ''
    createStep = 'confirm'
  }

  function submitConfirm(e: SubmitEvent) {
    e.preventDefault()
    const ok = confirmPositions.every(
      (pos) => (confirmInputs[pos] ?? '').trim().toLowerCase() === words[pos - 1],
    )
    if (!ok) {
      confirmError = "Those don't match — check the words and try again."
      return
    }
    confirmError = ''
    createStep = 'passphrase'
  }

  function passphraseStrength(pw: string): 'weak' | 'fair' | 'good' {
    if (pw.length < 12) return 'weak'
    const varied = /[a-z]/.test(pw) && /[A-Z0-9]/.test(pw)
    return varied ? 'good' : 'fair'
  }
  let strength = $derived(passphraseStrength(passphrase))

  async function submitCreatePassphrase(e: SubmitEvent) {
    e.preventDefault()
    passphraseError = ''
    if (passphrase.length < 8) {
      passphraseError = 'Use at least 8 characters.'
      return
    }
    if (passphrase !== passphraseConfirm) {
      passphraseError = "Those passphrases don't match."
      return
    }
    if (!identity?.mnemonic) return

    busy = true
    try {
      await initVault(identity.mnemonic, passphrase)
      await finishOnboarding(passphrase)
    } finally {
      busy = false
    }
  }

  // --- restore flow ---
  let restorePhrase = $state('')
  let restoreError = $state('')
  let restorePassphrase = $state('')
  let restoreRelayUrl = $state(linkRelayUrl)
  let restoreProgress = $state('')
  let restoreBusy = $state(false)

  async function submitRestore(e: SubmitEvent) {
    e.preventDefault()
    restoreError = ''
    if (restorePassphrase.length < 8) {
      restoreError = 'Use a passphrase of at least 8 characters.'
      return
    }
    restoreBusy = true
    try {
      await initSvastha()
      const phrase = restorePhrase.trim().toLowerCase().replace(/\s+/g, ' ')
      let restored: WasmIdentity
      try {
        restored = WasmIdentity.from_mnemonic(phrase, '')
      } catch {
        restoreError = "That doesn't look like a valid seed phrase — check the words and order."
        return
      }

      // Relay URL is optional and skippable; validate it up front (before
      // touching local storage) so a bad address fails without the user
      // having to redo the passphrase step.
      let relayUrl = ''
      if (restoreRelayUrl.trim()) {
        relayUrl = normalizeRelayUrl(restoreRelayUrl)
        try {
          await checkRelayInfo(relayUrl)
        } catch (err) {
          restoreError = err instanceof Error ? err.message : 'Could not connect to the relay.'
          return
        }
      }

      await initVault(restored.mnemonic ?? phrase, restorePassphrase)
      await finishOnboarding(restorePassphrase, relayUrl || undefined)
    } finally {
      restoreBusy = false
    }
  }

  // Shared tail: re-derive the session from what was just sealed (guarantees
  // it matches storage exactly), optionally connect to a relay and restore
  // from it, offer persistence, then hand off to the app.
  async function finishOnboarding(pass: string, relayUrl?: string) {
    const { identity: sessionIdentity, vaultKey, kdfOut } = await unlock(pass)
    setSession(sessionIdentity, vaultKey, kdfOut)

    if (relayUrl) {
      restoreProgress = 'Connecting to the relay…'
      const client = new RelayClient(relayUrl, sessionIdentity)
      await connectRelay(client) // adopts vault.key first — see vault.ts
      await put('prefs', relayUrl, 'relayUrl')

      const unsubscribe = syncStatus.subscribe((s) => {
        restoreProgress = `Restoring your records — ${s.pulledCount} so far`
      })
      // connectRelay's syncInit already kicked off a background pull; this
      // explicit, awaited one may re-process a few of the same ids (harmless
      // — put/markDone are idempotent) but guarantees the spine is populated
      // before navigating away.
      await pullAll()
      unsubscribe()
      restoreProgress = ''
    }

    if (navigator.storage?.persist) {
      const granted = await navigator.storage.persist()
      if (!granted) {
        persistNote =
          'Your browser may evict local data — install the app to your home screen to protect it.'
      }
    } else {
      persistNote =
        'Your browser may evict local data — install the app to your home screen to protect it.'
    }

    onCreated()
    navigate('#/')
  }
</script>

<h1>Svastha</h1>

<div class="tabs" role="tablist">
  <button
    role="tab"
    aria-selected={tab === 'create'}
    onclick={() => (tab = 'create')}
    data-testid="tab-create"
  >
    Create
  </button>
  <button
    role="tab"
    aria-selected={tab === 'restore'}
    onclick={() => (tab = 'restore')}
    data-testid="tab-restore"
  >
    Restore
  </button>
</div>

{#if tab === 'create'}
  {#if createStep === 'intro'}
    <div class="stack">
      <p>
        Your records live on this device, encrypted. One seed phrase is the only
        key — write it down.
      </p>
      <button class="primary" onclick={generate} data-testid="generate-mnemonic">
        Generate
      </button>
    </div>
  {:else if createStep === 'words'}
    <div class="stack">
      <p class="muted">
        Write these 24 words down on paper, in order. Avoid a screenshot — a photo
        or file can be copied off this device.
      </p>
      <ol class="mnemonic-grid">
        {#each words as word, i (i)}
          <li data-testid="mnemonic-word-{i + 1}">{word}</li>
        {/each}
      </ol>
      <button
        class="tonal"
        style:width="100%"
        onclick={copyMnemonic}
        data-testid="copy-mnemonic"
      >
        {mnemonicCopied ? 'Copied — clears in 60 s' : 'Copy phrase'}
      </button>
      <p class="warnnote">
        Paper is still the safest home for these words. If you copy, paste into a password manager
        right away — the clipboard clears itself in 60 seconds.
      </p>
      <button class="primary" onclick={pickConfirmPositions} data-testid="wrote-it-down">
        I wrote it down
      </button>
    </div>
  {:else if createStep === 'confirm'}
    <form class="stack" onsubmit={submitConfirm}>
      <p>Type these words to confirm you wrote them down correctly.</p>
      {#each confirmPositions as pos (pos)}
        <label>
          Word #{pos}
          <input
            bind:value={confirmInputs[pos]}
            autocomplete="off"
            autocapitalize="off"
            data-testid="confirm-word-{pos}"
          />
        </label>
      {/each}
      {#if confirmError}
        <p class="error" data-testid="confirm-error">{confirmError}</p>
      {/if}
      <button type="submit" class="primary" data-testid="confirm-words-submit">Continue</button>
    </form>
  {:else if createStep === 'passphrase'}
    <form class="stack" onsubmit={submitCreatePassphrase}>
      <p>Set a passphrase to lock your seed phrase on this device.</p>
      <label>
        Passphrase
        <input type="password" bind:value={passphrase} data-testid="passphrase" />
      </label>
      <p class="muted" data-testid="passphrase-strength">Strength: {strength}</p>
      <label>
        Confirm passphrase
        <input type="password" bind:value={passphraseConfirm} data-testid="passphrase-confirm" />
      </label>
      {#if passphraseError}
        <p class="error" data-testid="passphrase-error">{passphraseError}</p>
      {/if}
      <button type="submit" class="primary" disabled={busy} data-testid="set-passphrase-submit">
        Finish setup
      </button>
    </form>
  {/if}
{:else}
  {#if linkRelayHostname}
    <p class="muted" data-testid="link-intro">
      Linking this device — your records will restore from {linkRelayHostname} once you enter your
      seed phrase.
    </p>
  {/if}
  <form class="stack" onsubmit={submitRestore}>
    <p>Paste your 24-word seed phrase to recreate your identity on this device.</p>
    <label>
      Seed phrase
      <textarea
        bind:value={restorePhrase}
        rows="3"
        autocomplete="off"
        data-testid="restore-mnemonic"
      ></textarea>
    </label>
    <label>
      Passphrase
      <input type="password" bind:value={restorePassphrase} data-testid="restore-passphrase" />
    </label>
    <label>
      Relay URL <span class="muted">(optional — restores your records from backup)</span>
      <input
        bind:value={restoreRelayUrl}
        placeholder="https://relay.example.com"
        data-testid="restore-relay-url"
      />
    </label>
    {#if restoreError}
      <p class="error" data-testid="restore-error">{restoreError}</p>
    {/if}
    {#if restoreProgress}
      <p class="muted" data-testid="restore-progress">{restoreProgress}</p>
    {/if}
    <button type="submit" class="primary" disabled={restoreBusy} data-testid="restore-submit">
      Restore
    </button>
  </form>
{/if}

{#if persistNote}
  <p class="muted" data-testid="persist-note">{persistNote}</p>
{/if}

<style>
  .tabs {
    display: flex;
    gap: var(--space-2);
    margin-bottom: var(--space-5);
  }

  .tabs button[aria-selected='true'] {
    border-color: var(--action);
    color: var(--action);
  }

  .mnemonic-grid {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: var(--space-2);
    font-family: var(--font-data);
    list-style: decimal;
    padding-left: var(--space-5);
    user-select: none;
  }

  label {
    display: block;
    font-size: var(--text-sm);
    color: var(--muted);
  }

  /* Honest-tradeoff caption under the copy-phrase button (Settings.svelte
     repeats this verbatim for the seed reveal). */
  .warnnote {
    font-size: var(--text-xs);
    color: var(--muted);
    border-left: 2px solid var(--flare);
    padding-left: var(--space-3);
  }
</style>
