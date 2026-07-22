<script lang="ts">
  import { onMount } from 'svelte'
  import { get, put } from '../../lib/db'
  import { navigate } from '../../lib/router.svelte'
  import { session } from '../../lib/session.svelte'
  import { RelayClient } from '../../lib/relay'
  import { toHex, fromHex } from '../../lib/hex'
  import {
    buildExchangeCode,
    parseExchangeCode,
    fingerprint,
    codeQrSvg,
    exchangeLinkFor,
    extractExchangeCode,
    ExchangeCodeError,
  } from '../../lib/exchange'
  import { listShares, removeShare, type Share } from '../../lib/shared'
  import QrScanner from '../../components/QrScanner.svelte'

  /** Local-only label for a grantee — display convenience, never sent to the
   * relay (which sees only the public key). Keyed by hex Ed25519 key. */
  type Peers = Record<string, string>

  let relayUrl = $state('')
  let relay = $state<RelayClient | null>(null)
  let showScanner = $state(false)

  // --- my code ---
  let displayName = $state('')
  const myCode = $derived(
    session.identity
      ? buildExchangeCode(
          session.identity.ed25519_public_hex,
          session.identity.x25519_public_hex,
          displayName,
        )
      : '',
  )
  // The QR encodes a link to the share screen, not the bare code: an unknown
  // `svastha1:` scheme reads as "no usable data" to a generic camera app, so
  // wrapping it in our own origin's URL is what makes it openable at all. The
  // link lands on `#/share`, which redirects here with the code applied (see
  // Share.svelte). "Copy code" below still copies the raw code.
  const myQrSvg = $derived(myCode ? codeQrSvg(exchangeLinkFor(window.location.origin, myCode)) : '')
  let copied = $state(false)

  async function saveDisplayName() {
    await put('prefs', displayName, 'displayName')
  }

  async function copyCode() {
    await navigator.clipboard.writeText(myCode)
    copied = true
    setTimeout(() => (copied = false), 2000)
  }

  // --- share my vault ---
  // A scanned QR (see `exchangeLinkFor`) lands on `#/share?code=...`; Share.svelte
  // redirects that here as `#/share/people?code=...`, whether or not the vault was
  // locked when the link opened — App.svelte renders Unlock in place of the route
  // without touching the hash, so the param survives an intervening unlock. Read
  // it once, at mount, then strip it so a refresh doesn't re-show the confirm box.
  const incomingCode = new URLSearchParams(window.location.hash.split('?')[1] ?? '').get('code')
  if (incomingCode) {
    history.replaceState(
      null,
      '',
      `${window.location.pathname}${window.location.search}#/share/people`,
    )
  }
  let pasteInput = $state(incomingCode ?? '')
  const parsedCode = $derived.by(() => {
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

  function onScan(code: string) {
    showScanner = false
    pasteInput = code
  }

  let shareBusy = $state(false)
  let shareError = $state('')
  let shareDone = $state(false)

  async function confirmShare() {
    const parsed = parsedCode.code
    if (!parsed || !relay || !session.identity || !session.vaultKey) return
    shareBusy = true
    shareError = ''
    shareDone = false
    try {
      await relay.putGrant(parsed.ed25519Hex)

      const wrapped = session.vaultKey.wrap_to(fromHex(parsed.x25519Hex))
      const myEd8 = session.identity.ed25519_public_hex.slice(0, 8)
      const payload = {
        v: 1,
        from_ed: session.identity.ed25519_public_hex,
        from_x25519: session.identity.x25519_public_hex,
        label: displayName,
        wrapped_hex: toHex(wrapped),
      }
      await relay.putMailbox(
        parsed.ed25519Hex,
        `vaultkey-${myEd8}`,
        new TextEncoder().encode(JSON.stringify(payload)),
      )

      await rememberPeer(parsed.ed25519Hex, parsed.label)
      pasteInput = ''
      shareDone = true
      await refreshGrants()
    } catch (err) {
      shareError = err instanceof Error ? err.message : 'Could not share your vault.'
    } finally {
      shareBusy = false
    }
  }

  // --- active grants (people this identity has granted) ---
  let grantees = $state<string[]>([])
  let peers = $state<Peers>({})

  async function loadPeers(): Promise<Peers> {
    return (await get<Peers>('prefs', 'peers')) ?? {}
  }

  async function rememberPeer(edHex: string, label: string): Promise<void> {
    const all = await loadPeers()
    all[edHex] = label || all[edHex] || ''
    await put('prefs', all, 'peers')
    peers = all
  }

  async function refreshGrants(): Promise<void> {
    if (!relay) return
    grantees = await relay.listGrants()
    peers = await loadPeers()
  }

  async function revoke(edHex: string): Promise<void> {
    if (!relay) return
    await relay.deleteGrant(edHex)
    await refreshGrants()
  }

  // --- shared with me ---
  let shares = $state<Share[]>([])

  async function refreshShares(): Promise<void> {
    shares = await listShares()
  }

  async function forget(ownerEd: string): Promise<void> {
    await removeShare(ownerEd)
    await refreshShares()
  }

  onMount(async () => {
    displayName = (await get<string>('prefs', 'displayName')) ?? ''

    relayUrl = (await get<string>('prefs', 'relayUrl')) ?? ''
    if (relayUrl && session.identity) {
      relay = new RelayClient(relayUrl, session.identity)
      await refreshGrants()
    }

    await refreshShares()
  })
</script>

<h1>Your people</h1>
<p class="lede muted">Ongoing, read-only access to your record for someone you trust.</p>

{#if !relayUrl}
  <p class="muted" data-testid="share-needs-relay">
    Sharing routes handshake metadata through a relay. <button
      class="link"
      onclick={() => navigate('#/settings/sync')}
      data-testid="go-connect-relay">Connect one in Settings</button
    > to invite someone.
  </p>
{:else}
  <section class="stack">
    <h2>My code</h2>
    <label>
      Your name
      <input bind:value={displayName} onchange={saveDisplayName} data-testid="display-name" />
    </label>
    {#if myQrSvg}
      <!-- App-generated code, never user input — see exchange.ts's codeQrSvg doc comment. -->
      <!-- eslint-disable-next-line svelte/no-at-html-tags -->
      <div class="qr" data-testid="my-qr">{@html myQrSvg}</div>
    {/if}
    <p class="data" data-testid="my-code">{myCode}</p>
    <button onclick={copyCode} data-testid="copy-code">{copied ? 'Copied' : 'Copy code'}</button>
  </section>

  <section class="stack">
    <h2>Add someone</h2>
    <button class="primary" onclick={() => (showScanner = true)} data-testid="scan-code">
      Scan their code
    </button>
    <label>
      …or paste their code
      <textarea
        bind:value={pasteInput}
        rows="3"
        autocomplete="off"
        data-testid="paste-code"
      ></textarea>
    </label>
    {#if parsedCode.error}
      <p class="error" data-testid="parse-error">{parsedCode.error}</p>
    {/if}
    {#if parsedCode.code}
      <div class="confirm-box">
        <p data-testid="parsed-label">{parsedCode.code.label || 'Their vault'}</p>
        <p class="data" data-testid="parsed-fingerprint">
          {fingerprint(parsedCode.code.ed25519Hex)}
        </p>
        <p class="muted">Confirm these 16 characters match on their screen.</p>
        <button
          class="primary"
          disabled={shareBusy}
          onclick={confirmShare}
          data-testid="confirm-share"
        >
          Confirm and share
        </button>
      </div>
    {/if}
    {#if shareError}
      <p class="error" data-testid="share-error">{shareError}</p>
    {/if}
    {#if shareDone}
      <p data-testid="share-done">Shared. They'll see an invite next time they sync.</p>
    {/if}
  </section>

  {#if grantees.length > 0}
    <section class="stack">
      <h2>Active grants</h2>
      <ul class="grant-list">
        {#each grantees as edHex (edHex)}
          <li>
            <span class="data">{peers[edHex] || fingerprint(edHex)}</span>
            <button onclick={() => revoke(edHex)} data-testid="revoke-{edHex}">Revoke</button>
          </li>
        {/each}
      </ul>
      <p class="muted">
        They keep anything already synced to their device. Full lock-out needs key rotation — not
        built yet.
      </p>
    </section>
  {/if}
{/if}

<section class="stack">
  <h2>Shared with me</h2>
  {#if shares.length === 0}
    <p class="muted" data-testid="no-shares">No one has shared their vault with you yet.</p>
  {:else}
    <ul class="share-list">
      {#each shares as share (share.ownerEd)}
        <li>
          <span style:color={`var(--person-${share.hue})`}>{share.label}</span>
          {#if share.stale}
            <span class="muted" data-testid="share-stale-{share.ownerEd}">no longer shared</span>
          {/if}
          <button onclick={() => forget(share.ownerEd)} data-testid="forget-{share.ownerEd}">
            Remove
          </button>
        </li>
      {/each}
    </ul>
  {/if}
</section>

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

  label {
    display: block;
    font-size: var(--text-sm);
    color: var(--muted);
    margin-top: var(--space-3);
  }

  .qr :global(svg) {
    width: 200px;
    height: 200px;
  }

  .confirm-box {
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    padding: var(--space-3);
    margin-top: var(--space-3);
  }

  .link {
    display: inline;
    padding: 0;
    border: none;
    background: none;
    color: var(--action);
    text-decoration: underline;
    font: inherit;
  }

  .grant-list,
  .share-list {
    list-style: none;
    padding: 0;
    margin: 0;
  }

  .grant-list li,
  .share-list li {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    padding: var(--space-1) 0;
  }

  .grant-list li button,
  .share-list li button {
    margin-left: auto;
  }
</style>
