<script lang="ts">
  import { onMount } from 'svelte'
  import { get, put } from '../../lib/db'
  import { navigate } from '../../lib/router.svelte'
  import { session } from '../../lib/session.svelte'
  import { RelayClient } from '../../lib/relay'
  import type { WasmKeyring } from '../../lib/svastha'
  import {
    buildExchangeCode,
    parseExchangeCode,
    extractExchangeCode,
    exchangeLinkFor,
    codeQrSvg,
    fingerprint,
    ExchangeCodeError,
    type ExchangeCode,
  } from '../../lib/exchange'
  import { listShares, removeShare, type Share } from '../../lib/shared'
  import {
    enrollGrantee,
    getGrantMeta,
    removeGrantMeta,
    buildOutgoing,
    granteesToReKey,
    type GrantKind,
    type OutgoingGrant,
  } from '../../lib/grants'
  import { revokeAndRotate } from '../../lib/keyring'
  import QrScanner from '../../components/QrScanner.svelte'

  let relayUrl = $state('')
  let relay = $state<RelayClient | null>(null)
  let displayName = $state('')

  // --- the grant graph, both directions (single source of truth: grantMeta) ---
  let outgoing = $state<OutgoingGrant[]>([])
  let incoming = $state<Share[]>([])
  const nodes = $derived(outgoing.filter((g) => g.kind === 'node'))
  const people = $derived(outgoing.filter((g) => g.kind !== 'node'))

  async function refresh(): Promise<void> {
    if (!relay) return
    const [grantees, meta] = await Promise.all([relay.listGrants(), getGrantMeta()])
    outgoing = buildOutgoing(grantees, meta)
    incoming = await listShares()
  }

  const myCode = $derived(
    session.identity
      ? buildExchangeCode(
          session.identity.ed25519_public_hex,
          session.identity.x25519_public_hex,
          displayName,
        )
      : '',
  )
  const myQrSvg = $derived(myCode ? codeQrSvg(exchangeLinkFor(window.location.origin, myCode)) : '')
  let copied = $state(false)

  async function saveDisplayName(): Promise<void> {
    await put('prefs', displayName, 'displayName')
  }

  async function copyCode(): Promise<void> {
    await navigator.clipboard.writeText(myCode)
    copied = true
    setTimeout(() => (copied = false), 2000)
  }

  const myFingerprint = $derived(
    session.identity ? fingerprint(session.identity.ed25519_public_hex) : '',
  )

  let showScanner = $state(false)
  // A scanned QR lands on `#/share?code=…` which redirects here as
  // `#/share/people?code=…` (see Share.svelte). Read it once, then strip it so a
  // refresh doesn't re-show the confirm box.
  const incomingCode = new URLSearchParams(window.location.hash.split('?')[1] ?? '').get('code')
  if (incomingCode) {
    history.replaceState(null, '', `${window.location.pathname}${window.location.search}#/share/people`)
  }
  let pasteInput = $state(incomingCode ?? '')
  let kind = $state<GrantKind>('household')
  let label = $state('')
  let expiry = $state('') // yyyy-mm-dd, empty = no expiry
  let enrollBusy = $state(false)
  let enrollError = $state('')
  let enrollDone = $state('')

  const parsed = $derived.by((): { code: ExchangeCode | null; error: string } => {
    if (!pasteInput.trim()) return { code: null, error: '' }
    try {
      return { code: parseExchangeCode(extractExchangeCode(pasteInput)), error: '' }
    } catch (err) {
      return {
        code: null,
        error: err instanceof ExchangeCodeError ? err.message : 'Could not read that code.',
      }
    }
  })

  function onScan(code: string): void {
    showScanner = false
    pasteInput = code
  }

  async function enroll(): Promise<void> {
    const code = parsed.code
    if (!code || !relay || !session.identity) return
    if (!session.keyring) {
      enrollError = 'Still connecting to the relay — try again in a moment.'
      return
    }
    enrollBusy = true
    enrollError = ''
    enrollDone = ''
    try {
      const expiresAt = expiry ? Math.floor(new Date(`${expiry}T23:59:59`).getTime() / 1000) : undefined
      await enrollGrantee({
        relay,
        identity: session.identity,
        keyring: session.keyring,
        ownerLabel: displayName,
        grantee: { ed: code.ed25519Hex, x25519: code.x25519Hex, label: label || code.label, kind, expiresAt },
      })
      enrollDone =
        kind === 'node'
          ? 'Node enrolled. It will pull your vault and begin proposing.'
          : "Shared. They'll see an invite next time they sync."
      pasteInput = ''
      label = ''
      expiry = ''
      await refresh()
    } catch (err) {
      enrollError = err instanceof Error ? err.message : 'Could not enroll that identity.'
    } finally {
      enrollBusy = false
    }
  }

  let confirming = $state<{ revoke: OutgoingGrant | null } | null>(null)
  let rotateBusy = $state(false)
  let rotateError = $state('')

  async function doRotate(): Promise<void> {
    if (!confirming || !relay || !session.identity || !session.keyring) return
    const revoke = confirming.revoke
    rotateBusy = true
    rotateError = ''
    try {
      const meta = await getGrantMeta()
      const rotated = await revokeAndRotate({
        relay,
        identity: session.identity,
        keyring: session.keyring,
        grantees: granteesToReKey(meta, revoke ? revoke.ed : null),
        revoke: revoke ? revoke.ed : null,
      })
      session.keyring = rotated as unknown as WasmKeyring
      if (revoke) await removeGrantMeta(revoke.ed)
      confirming = null
      await refresh()
    } catch (err) {
      rotateError = err instanceof Error ? err.message : 'Rotation failed.'
    } finally {
      rotateBusy = false
    }
  }

  async function forget(ownerEd: string): Promise<void> {
    await removeShare(ownerEd)
    await refresh()
  }

  function scopeText(g: OutgoingGrant): string {
    if (g.legacy) return 'unscoped (issued before scopes)'
    const parts: string[] = [g.prefixes.join(' ')]
    if (g.expiresAt) parts.push(`expires ${new Date(g.expiresAt * 1000).toLocaleDateString()}`)
    return parts.join(' · ')
  }

  onMount(async () => {
    displayName = (await get<string>('prefs', 'displayName')) ?? ''
    relayUrl = (await get<string>('prefs', 'relayUrl')) ?? ''
    if (relayUrl && session.identity) {
      relay = new RelayClient(relayUrl, session.identity)
      await refresh()
    }
  })
</script>

<h1>Your people</h1>
<p class="lede muted">
  Everyone your vault reaches, both ways — people you trust with read access, the processing node
  that answers your questions, and revoke-and-rotate when a key must be pulled back.
</p>

{#if !relayUrl}
  <p class="muted" data-testid="share-needs-relay">
    Sharing and node enrollment route through a relay. <button
      class="link"
      onclick={() => navigate('#/settings/sync')}
      data-testid="go-connect-relay">Connect one in Settings</button
    > to get started.
  </p>
{:else}
  <section class="stack">
    <h2>My code</h2>
    <label class="field">
      Your name
      <input bind:value={displayName} onchange={saveDisplayName} data-testid="display-name" />
    </label>
    {#if myQrSvg}
      <!-- App-generated code, never user input — see exchange.ts's codeQrSvg doc comment. -->
      <!-- eslint-disable-next-line svelte/no-at-html-tags -->
      <div class="qr" data-testid="my-qr">{@html myQrSvg}</div>
    {/if}
    <p class="data" data-testid="my-code">{myCode}</p>
    <div class="row-item" data-testid="my-fingerprint">
      <span class="data">{myFingerprint}</span>
      <span class="badge">you</span>
    </div>
    <button onclick={copyCode} data-testid="copy-code">{copied ? 'Copied' : 'Copy code'}</button>
  </section>

  <section class="stack">
    <h2>Add someone or a node</h2>
    <button class="primary" onclick={() => (showScanner = true)} data-testid="enroll-scan">
      Scan their code
    </button>
    <label class="field">
      …or paste their <code>svastha1:</code> code
      <textarea bind:value={pasteInput} rows="3" autocomplete="off" data-testid="enroll-paste"></textarea>
    </label>
    {#if parsed.error}
      <p class="error" data-testid="enroll-parse-error">{parsed.error}</p>
    {/if}
    {#if parsed.code}
      <div class="confirm-box">
        <p class="confirm-name" data-testid="enroll-label">{parsed.code.label || 'Their vault'}</p>
        <p class="data" data-testid="enroll-fingerprint">{fingerprint(parsed.code.ed25519Hex)}</p>
        <p class="muted small">Confirm these 16 characters match on their screen.</p>

        <fieldset class="kinds">
          <label class="radio">
            <input type="radio" bind:group={kind} value="household" data-testid="enroll-kind-household" />
            <span>Person <span class="muted">— record + captured documents</span></span>
          </label>
          <label class="radio">
            <input type="radio" bind:group={kind} value="node" data-testid="enroll-kind-node" />
            <span>Processing node <span class="muted">— full read for OCR &amp; answers</span></span>
          </label>
        </fieldset>

        <label class="field">
          A name for them (optional)
          <input bind:value={label} data-testid="enroll-name" />
        </label>
        <label class="field">
          Expires (optional)
          <input type="date" bind:value={expiry} data-testid="enroll-expiry" />
        </label>

        <button class="primary" disabled={enrollBusy} onclick={enroll} data-testid="enroll-submit">
          {kind === 'node' ? 'Enroll node' : 'Confirm and share'}
        </button>
      </div>
    {/if}
    {#if enrollError}
      <p class="error" data-testid="enroll-error">{enrollError}</p>
    {/if}
    {#if enrollDone}
      <p data-testid="enroll-done">{enrollDone}</p>
    {/if}
  </section>

  {#if nodes.length > 0}
    <section class="stack">
      <h2>Your node{nodes.length === 1 ? '' : 's'}</h2>
      <ul class="list">
        {#each nodes as g (g.ed)}
          <li data-testid="node-{g.ed}">
            <span class="row-main">
              <span class="data">{g.label || fingerprint(g.ed)}</span>
              <span class="sub muted">{scopeText(g)}</span>
            </span>
            <button onclick={() => (confirming = { revoke: g })} data-testid="grant-revoke-{g.ed}">
              Revoke
            </button>
          </li>
        {/each}
      </ul>
    </section>
  {/if}

  <section class="stack">
    <h2>You share with</h2>
    {#if people.length === 0}
      <p class="muted" data-testid="no-outgoing">You haven't shared with anyone yet.</p>
    {:else}
      <ul class="list">
        {#each people as g (g.ed)}
          <li data-testid="grant-{g.ed}">
            <span class="row-main">
              <span class="data">{g.label || fingerprint(g.ed)}</span>
              <span class="sub muted">{scopeText(g)}</span>
            </span>
            <button onclick={() => (confirming = { revoke: g })} data-testid="grant-revoke-{g.ed}">
              Revoke
            </button>
          </li>
        {/each}
      </ul>
    {/if}
  </section>

  <section class="stack">
    <h2>Shared with you</h2>
    {#if incoming.length === 0}
      <p class="muted" data-testid="no-incoming">No one has shared their vault with you yet.</p>
    {:else}
      <ul class="list">
        {#each incoming as s (s.ownerEd)}
          <li data-testid="incoming-{s.ownerEd}">
            <span class="row-main">
              <span class="data" style:color={`var(--person-${s.hue})`}>
                {s.label || fingerprint(s.ownerEd)}
              </span>
              {#if s.stale}
                <span class="sub muted" data-testid="share-stale-{s.ownerEd}">no longer shared</span>
              {/if}
            </span>
            <button onclick={() => forget(s.ownerEd)} data-testid="forget-{s.ownerEd}">Remove</button>
          </li>
        {/each}
      </ul>
    {/if}
  </section>

  <section class="stack">
    <h2>Rotate the vault key</h2>
    <p class="muted">
      Mint a new key epoch and re-key everyone still trusted, without revoking anyone — for when a
      key may have been exposed.
    </p>
    <button onclick={() => (confirming = { revoke: null })} data-testid="rotate-now">Rotate now</button>
  </section>
{/if}

{#if confirming}
  <div class="scrim" data-testid="rotate-confirm">
    <div class="dialog">
      {#if confirming.revoke}
        <h2>Revoke and rotate</h2>
        <p>
          Revoke <strong>{confirming.revoke.label || fingerprint(confirming.revoke.ed)}</strong> and rotate
          your vault key.
        </p>
      {:else}
        <h2>Rotate now</h2>
        <p>Mint a new key epoch and re-key everyone still trusted.</p>
      {/if}
      <p class="muted" data-testid="revoke-caveat">
        This cannot take back what has already been decrypted, or the old-epoch material a party
        already holds. Everything sealed from now on is beyond them.
      </p>
      {#if rotateError}
        <p class="error" data-testid="rotate-error">{rotateError}</p>
      {/if}
      <div class="dialog-actions">
        <button onclick={() => (confirming = null)} disabled={rotateBusy} data-testid="rotate-cancel">
          Cancel
        </button>
        <button class="primary" onclick={doRotate} disabled={rotateBusy} data-testid="rotate-confirm-yes">
          {confirming.revoke ? 'Revoke and rotate' : 'Rotate'}
        </button>
      </div>
    </div>
  </div>
{/if}

{#if showScanner}
  <QrScanner onclose={() => (showScanner = false)} ondetect={onScan} />
{/if}

<style>
  .lede {
    margin: 0 0 var(--space-4);
    font-size: var(--text-sm);
  }

  section {
    margin-top: var(--space-6);
  }

  h2 {
    font-size: var(--text-lg);
    margin: 0 0 var(--space-2);
  }

  .field {
    display: block;
    font-size: var(--text-sm);
    color: var(--muted);
    margin-top: var(--space-3);
  }

  .field input,
  .field textarea {
    margin-top: var(--space-2);
    font-size: var(--text-base);
    color: var(--text);
    max-width: 100%;
  }

  .small {
    font-size: var(--text-xs);
  }

  .qr :global(svg) {
    width: 200px;
    height: 200px;
  }

  .list {
    list-style: none;
    padding: 0;
    margin: 0;
  }

  .list li,
  .row-item {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    padding: var(--space-2) 0;
    border-bottom: 1px solid var(--border);
  }

  .row-main {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-width: 0;
  }

  .sub {
    font-size: var(--text-xs);
  }

  .list li button {
    margin-left: auto;
  }

  .badge {
    margin-left: auto;
    font-size: var(--text-xs);
    color: var(--muted);
  }

  .confirm-box {
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    padding: var(--space-4);
    margin-top: var(--space-3);
  }

  .confirm-name {
    margin: 0 0 var(--space-1);
    font-weight: 600;
  }

  /* Radios styled to the system: native control tinted to the accent, laid out
     as an aligned row. Replaces the old unstyled radios (and a stale `--ink`
     token reference). */
  .kinds {
    border: none;
    padding: 0;
    margin: var(--space-3) 0 var(--space-1);
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }

  .radio {
    display: flex;
    align-items: flex-start;
    gap: var(--space-2);
    color: var(--text);
    font-size: var(--text-sm);
    margin: 0;
  }

  .radio input[type='radio'] {
    accent-color: var(--action);
    width: 20px;
    height: 20px;
    min-height: 0;
    margin: 0;
    flex: none;
  }

  .link {
    display: inline;
    padding: 0;
    min-height: 0;
    border: none;
    background: none;
    color: var(--action);
    text-decoration: underline;
    font: inherit;
  }

  .scrim {
    position: fixed;
    inset: 0;
    z-index: 40;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: var(--space-4);
    background: var(--scrim);
  }

  .dialog {
    width: 100%;
    max-width: 26rem;
    padding: var(--space-4);
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    box-shadow: var(--shadow-2);
  }

  .dialog h2 {
    margin: 0 0 var(--space-2);
  }

  .dialog-actions {
    display: flex;
    gap: var(--space-2);
    justify-content: flex-end;
    margin-top: var(--space-4);
  }
</style>
