<script lang="ts">
  import { onMount } from 'svelte'
  import { contract_version } from '../lib/svastha'
  import { unlock, unlockWithPasskey, listPasskeys, wipe, WrongPassphraseError, PasskeyUnlockError } from '../lib/keyvault'
  import { passkeysSupported, authenticate, PasskeyNotSupportedError, PasskeyCeremonyError } from '../lib/passkey'
  import { setSession } from '../lib/session.svelte'
  import { get } from '../lib/db'
  import Sheet from '../components/Sheet.svelte'

  let passphrase = $state('')
  let showPassphrase = $state(false)
  let error = $state('')
  let notice = $state('')
  let busy = $state(false)
  let input = $state<HTMLInputElement>()
  let showForgotSheet = $state(false)

  let pubkeyHex = $state<string>()
  let hue = $state<'a' | 'b'>('a')
  // Credential ids enrolled on this device; the passkey control shows only when
  // the browser supports WebAuthn and at least one is enrolled.
  let passkeyCredIds = $state<string[]>([])

  // Safe to call synchronously: App gates rendering behind initSvastha().
  const version = contract_version()

  onMount(async () => {
    pubkeyHex = await get<string>('prefs', 'ed25519-pub')
    const storedHue = await get<'a' | 'b'>('prefs', 'hue')
    if (storedHue) hue = storedHue
    if (passkeysSupported()) passkeyCredIds = (await listPasskeys()).map((p) => p.credId)
  })

  /** Show a public key as spaced hex byte-groups, truncated — enough to eyeball
   * a match, not the full 64-char key. Duplicated from Settings.svelte (not
   * exported there) — small enough not to be worth sharing. */
  function fingerprint(hex: string, groups = 8): string {
    return (hex.match(/.{2}/g) ?? []).slice(0, groups).join(' ') + '…'
  }

  $effect(() => {
    input?.focus()
  })

  // 24 ticks = 24 BIP39 words; angle math from the mockup's tick-ring generator.
  function tick(k: number) {
    const a = (k / 24) * 2 * Math.PI
    return {
      x1: 32 + 23 * Math.sin(a),
      y1: 32 - 23 * Math.cos(a),
      x2: 32 + 29 * Math.sin(a),
      y2: 32 - 29 * Math.cos(a),
    }
  }

  async function submit(e: SubmitEvent) {
    e.preventDefault()
    error = ''
    busy = true
    try {
      const { identity, vaultKey, wrapKey } = await unlock(passphrase)
      setSession(identity, vaultKey, wrapKey)
    } catch (err) {
      error =
        err instanceof WrongPassphraseError
          ? err.message
          : 'Something went wrong opening your vault — try again.'
    } finally {
      busy = false
    }
  }

  async function unlockWithPasskeyFlow() {
    error = ''
    notice = ''
    busy = true
    try {
      const asserted = await authenticate(passkeyCredIds)
      const { identity, vaultKey, wrapKey } = await unlockWithPasskey(asserted.credId, asserted.secret)
      setSession(identity, vaultKey, wrapKey)
    } catch (err) {
      if (err instanceof PasskeyCeremonyError) {
        // Cancel and platform refusal are the same error to WebAuthn; show the
        // reason (muted, not alarming) so an iOS failure isn't a silent no-op.
        notice = `The vault stays locked (${err.detail}). Your passphrase always works.`
      } else {
        error =
          err instanceof PasskeyUnlockError || err instanceof PasskeyNotSupportedError
            ? err.message
            : 'Something went wrong opening your vault — try again.'
      }
    } finally {
      busy = false
    }
  }

  async function confirmWipe() {
    await wipe()
    // Full reload so every module (session, App's vault check) starts clean —
    // simpler and safer than threading a "just wiped" flag through state.
    window.location.hash = '#/onboard?tab=restore'
    window.location.reload()
  }
</script>

<div class="unlock-body" class:err={!!error}>
  <svg class="seal" viewBox="0 0 64 64" aria-hidden="true">
    {#each Array.from({ length: 24 }) as _, k}
      {@const t = tick(k)}
      <line
        class="seal-line"
        x1={t.x1}
        y1={t.y1}
        x2={t.x2}
        y2={t.y2}
        stroke-width="1.6"
        stroke-linecap="round"
      />
    {/each}
    <circle cx="32" cy="32" r="3.5" fill="var(--action)" />
  </svg>

  <span class="word">Svastha</span>

  {#if pubkeyHex}
    <div class="fingerprint">
      <i style:background={hue === 'b' ? 'var(--person-b)' : 'var(--person-a)'}></i>
      ed25519 · {fingerprint(pubkeyHex)} · this device
    </div>
  {/if}

  <form class="stack" onsubmit={submit}>
    <label class="field">
      Passphrase
      <div class="pass-row">
        <input
          bind:this={input}
          bind:value={passphrase}
          oninput={() => (error = '')}
          type={showPassphrase ? 'text' : 'password'}
          autocomplete="current-password"
          data-testid="unlock-passphrase"
        />
        <button
          type="button"
          class="reveal ghost"
          onclick={() => (showPassphrase = !showPassphrase)}
          aria-label={showPassphrase ? 'Hide passphrase' : 'Show passphrase'}
          aria-pressed={showPassphrase}
          data-testid="toggle-passphrase-visibility"
        >
          {#if showPassphrase}
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c6.5 0 10 7 10 7a13.2 13.2 0 0 1-1.67 2.36M6.6 6.6C3.9 8.2 2 11 2 11s3.5 7 10 7a9 9 0 0 0 4.4-1.1" />
              <path d="M9.9 9.9a3 3 0 0 0 4.2 4.2" />
              <path d="m2 2 20 20" />
            </svg>
          {:else}
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z" />
              <circle cx="12" cy="12" r="3" />
            </svg>
          {/if}
        </button>
      </div>
    </label>

    {#if error}
      <p class="error" data-testid="unlock-error">{error}</p>
    {/if}

    <button
      type="submit"
      class="primary"
      style:width="100%"
      disabled={busy || !passphrase}
      data-testid="unlock-submit"
    >
      Unlock
    </button>
  </form>

  {#if passkeyCredIds.length}
    <button
      type="button"
      class="tonal passkey"
      disabled={busy}
      onclick={unlockWithPasskeyFlow}
      data-testid="unlock-passkey"
    >
      Unlock with passkey
    </button>
    {#if notice}
      <p class="muted notice" data-testid="unlock-passkey-notice">{notice}</p>
    {/if}
  {/if}

  <button type="button" class="ghost forgot" onclick={() => (showForgotSheet = true)} data-testid="forgot-passphrase">
    Forgot? Start over from your seed phrase
  </button>

  <footer class="version">
    <p data-testid="unlock-app-version">Svastha v{__APP_VERSION__}</p>
    <p data-testid="unlock-contract-version">Trust contract v{version}</p>
  </footer>
</div>

{#if showForgotSheet}
  <Sheet onclose={() => (showForgotSheet = false)}>
    <h2>Start over from your seed phrase?</h2>
    <p>
      This wipes all local data on this device and restores your identity from your seed phrase.
      Continue?
    </p>
    <div class="row">
      <button type="button" class="ghost" onclick={() => (showForgotSheet = false)}>Cancel</button>
      <button type="button" class="danger-outline" data-testid="confirm-wipe" onclick={confirmWipe}>
        Continue
      </button>
    </div>
  </Sheet>
{/if}

<style>
  .unlock-body {
    display: flex;
    flex-direction: column;
    align-items: center;
    text-align: center;
    padding: var(--space-7) var(--space-5) var(--space-5);
  }

  .seal {
    width: 64px;
    height: 64px;
    margin-bottom: var(--space-4);
  }

  .seal-line {
    stroke: var(--border);
    transition: stroke var(--duration-base);
  }

  .unlock-body:focus-within .seal-line {
    stroke: var(--action);
  }

  .unlock-body.err .seal-line {
    stroke: var(--danger);
  }

  .word {
    font-family: var(--font-display);
    font-size: var(--text-2xl);
  }

  .fingerprint {
    font-family: var(--font-data);
    font-size: var(--text-xs);
    color: var(--muted);
    margin: var(--space-2) 0 var(--space-6);
  }

  .fingerprint i {
    display: inline-block;
    width: 7px;
    height: 7px;
    border-radius: 50%;
    margin-right: 0.4rem;
  }

  form {
    width: 100%;
  }

  .pass-row {
    position: relative;
  }

  /* Leave room for the reveal button so the passphrase never runs under it. */
  .pass-row input {
    padding-right: 2.75rem;
  }

  /* In-field icon button: full field height (≥44px tap target via the input's
     min-height) but visually just the eye glyph. */
  .reveal {
    position: absolute;
    top: 0;
    right: 0;
    height: 100%;
    width: 2.75rem;
    min-height: 0;
    min-width: 0;
    padding: 0;
    display: grid;
    place-items: center;
  }

  .reveal svg {
    width: 1.25rem;
    height: 1.25rem;
  }

  .passkey {
    width: 100%;
    margin-top: var(--space-3);
  }

  .notice {
    margin-top: var(--space-2);
    font-size: var(--text-sm);
    text-align: center;
  }

  .forgot {
    margin-top: var(--space-6);
    font-size: var(--text-sm);
  }

  .forgot:hover {
    color: var(--danger);
  }

  .row {
    display: flex;
    gap: var(--space-2);
    margin-top: var(--space-4);
  }

  .row button {
    flex: 1;
  }

  .version {
    margin-top: var(--space-7);
    font-size: var(--text-xs);
    color: var(--muted);
    line-height: 1.5;
  }
</style>
