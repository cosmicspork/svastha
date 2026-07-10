<script lang="ts">
  import { unlock, wipe, WrongPassphraseError } from '../lib/keyvault'
  import { setSession } from '../lib/session.svelte'

  let passphrase = $state('')
  let showPassphrase = $state(false)
  let error = $state('')
  let busy = $state(false)
  let input = $state<HTMLInputElement>()

  $effect(() => {
    input?.focus()
  })

  async function submit(e: SubmitEvent) {
    e.preventDefault()
    error = ''
    busy = true
    try {
      const { identity, vaultKey, kdfOut } = await unlock(passphrase)
      setSession(identity, vaultKey, kdfOut)
    } catch (err) {
      error =
        err instanceof WrongPassphraseError
          ? err.message
          : 'Something went wrong opening your vault — try again.'
    } finally {
      busy = false
    }
  }

  async function forgotPassphrase() {
    const confirmed = window.confirm(
      'This wipes all local data on this device and restores your identity from your seed phrase. Continue?',
    )
    if (!confirmed) return
    await wipe()
    // Full reload so every module (session, App's vault check) starts clean —
    // simpler and safer than threading a "just wiped" flag through state.
    window.location.hash = '#/onboard?tab=restore'
    window.location.reload()
  }
</script>

<h1>Unlock Svastha</h1>

<form class="stack" onsubmit={submit}>
  <label>
    Passphrase
    <div class="field">
      <input
        bind:this={input}
        bind:value={passphrase}
        type={showPassphrase ? 'text' : 'password'}
        autocomplete="current-password"
        data-testid="unlock-passphrase"
      />
      <button
        type="button"
        class="reveal"
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

  <button type="submit" class="primary" disabled={busy || !passphrase} data-testid="unlock-submit">
    Unlock
  </button>

  <button type="button" onclick={forgotPassphrase} data-testid="forgot-passphrase">
    Forgot? Restore from seed phrase
  </button>
</form>

<style>
  .field {
    position: relative;
  }

  /* Leave room for the reveal button so the passphrase never runs under it. */
  .field input {
    padding-right: 2.75rem;
  }

  /* An in-field icon button: full field height (≥44px tap target via the input's
     min-height) but visually just the eye glyph, no border or fill. */
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
    border: none;
    background: none;
    color: var(--muted);
  }

  .reveal:hover {
    border-color: transparent;
    color: var(--text);
  }

  .reveal svg {
    width: 1.25rem;
    height: 1.25rem;
  }

  label {
    display: block;
    font-size: var(--text-sm);
    color: var(--muted);
  }
</style>
