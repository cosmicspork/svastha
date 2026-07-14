<script lang="ts">
  import { onMount } from 'svelte'
  import { get, put } from '../lib/db'
  import { session } from '../lib/session.svelte'
  import { RelayClient } from '../lib/relay'
  import { toHex, fromHex } from '../lib/hex'
  import {
    buildExchangeCode,
    parseExchangeCode,
    fingerprint,
    codeQrSvg,
    ExchangeCodeError,
  } from '../lib/exchange'
  import {
    listShares,
    removeShare,
    checkMailboxForInvites,
    acceptInvite,
    declineInvite,
    pendingInvites,
    type Share,
    type PendingInvite,
  } from '../lib/shared'
  import DoctorShareSheet from '../components/DoctorShareSheet.svelte'

  /** Local-only label for a grantee — display convenience, never sent to the
   * relay (which sees only the public key). Keyed by hex Ed25519 key. */
  type Peers = Record<string, string>

  let relayUrl = $state('')
  let relay = $state<RelayClient | null>(null)
  let hue = $state<'a' | 'b'>('a')
  let showDoctorShare = $state(false)

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
  const myQrSvg = $derived(myCode ? codeQrSvg(myCode) : '')
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
  let pasteInput = $state('')
  const parsedCode = $derived.by(() => {
    if (!pasteInput.trim()) return { code: null, error: '' }
    try {
      return { code: parseExchangeCode(pasteInput), error: '' }
    } catch (err) {
      return {
        code: null,
        error: err instanceof ExchangeCodeError ? err.message : 'Could not read that code.',
      }
    }
  })

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

  // --- pending invites (mailbox) ---
  async function accept(invite: PendingInvite): Promise<void> {
    await acceptInvite(invite, hue === 'a' ? 'b' : 'a')
    await refreshShares()
  }

  async function decline(invite: PendingInvite): Promise<void> {
    await declineInvite(invite)
  }

  onMount(async () => {
    const storedHue = await get<'a' | 'b'>('prefs', 'hue')
    if (storedHue) hue = storedHue
    displayName = (await get<string>('prefs', 'displayName')) ?? ''

    relayUrl = (await get<string>('prefs', 'relayUrl')) ?? ''
    if (relayUrl && session.identity) {
      relay = new RelayClient(relayUrl, session.identity)
      await refreshGrants()
    }

    await refreshShares()
    await checkMailboxForInvites()
  })
</script>

<h1>Share</h1>

{#each $pendingInvites as invite (invite.mailboxId)}
  <div class="invite" data-testid="invite-banner">
    <p>
      <strong>{invite.label || 'Someone'}</strong> shared their vault with you — accept?
    </p>
    <p class="data muted" data-testid="invite-fingerprint">{fingerprint(invite.fromEd)}</p>
    <div class="row">
      <button class="primary" onclick={() => accept(invite)} data-testid="invite-accept">
        Accept
      </button>
      <button onclick={() => decline(invite)} data-testid="invite-decline">Decline</button>
    </div>
  </div>
{/each}

{#if !relayUrl}
  <p class="muted" data-testid="share-needs-relay">
    Connect a relay in Settings first — sharing exchanges routing metadata through it.
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
    <h2>Share my vault</h2>
    <label>
      Their code
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
        <p class="data" data-testid="parsed-fingerprint">{fingerprint(parsedCode.code.ed25519Hex)}</p>
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

    <div class="doctor-share">
      <h2>Share with a doctor</h2>
      <p class="muted">
        Hand a clinician a link (or QR) to part of your record, sealed under a one-off key. No
        Svastha account needed on their end, and it expires on its own.
      </p>
      <button class="primary" onclick={() => (showDoctorShare = true)} data-testid="open-doctor-share">
        Create a doctor link
      </button>
    </div>

    {#if grantees.length > 0}
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
    {/if}
  </section>
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

{#if showDoctorShare && relay}
  <DoctorShareSheet {relay} {relayUrl} onclose={() => (showDoctorShare = false)} />
{/if}

<style>
  .doctor-share {
    margin-top: var(--space-6);
    padding-top: var(--space-5);
    border-top: 1px solid var(--border);
  }

  section {
    margin-top: var(--space-6);
  }

  label {
    display: block;
    font-size: var(--text-sm);
    color: var(--muted);
  }

  .invite {
    border: 1px solid var(--action);
    border-radius: var(--radius-sm);
    padding: var(--space-3);
    margin-bottom: var(--space-4);
  }

  .row {
    display: flex;
    gap: var(--space-2);
  }

  .qr :global(svg) {
    width: 200px;
    height: 200px;
  }

  .confirm-box {
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    padding: var(--space-3);
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
