<script lang="ts">
  import { onMount } from 'svelte'
  import { session } from '../../lib/session.svelte'
  import {
    unlock,
    changePassphrase,
    WrongPassphraseError,
    enrollPasskey as storePasskey,
    listPasskeys,
    removePasskey,
    type PasskeyRecord,
  } from '../../lib/keyvault'
  import {
    passkeysSupported,
    enrollPasskey as createPasskey,
    PasskeyNotSupportedError,
    PasskeyCeremonyError,
  } from '../../lib/passkey'
  import Sheet from '../../components/Sheet.svelte'
  import { copySensitive } from '../../lib/clipboard'

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
</script>

<h1>Security &amp; recovery</h1>

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

  /* Confirm-sheet action row (matches Unlock.svelte's forgot sheet). */
  .row {
    display: flex;
    gap: var(--space-2);
    margin-top: var(--space-4);
  }

  .row button {
    flex: 1;
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
