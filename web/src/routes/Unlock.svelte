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
        onclick={() => (showPassphrase = !showPassphrase)}
        data-testid="toggle-passphrase-visibility"
      >
        {showPassphrase ? 'Hide' : 'Show'}
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
    display: flex;
    gap: var(--space-2);
  }

  label {
    display: block;
    font-size: var(--text-sm);
    color: var(--muted);
  }
</style>
