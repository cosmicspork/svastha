<script lang="ts">
  import { onMount } from 'svelte'
  import { get } from '../lib/db'
  import { navigate } from '../lib/router.svelte'
  import { session } from '../lib/session.svelte'
  import { RelayClient } from '../lib/relay'
  import { fingerprint } from '../lib/exchange'
  import {
    listShares,
    acceptInvite,
    declineInvite,
    pendingInvites,
    type PendingInvite,
  } from '../lib/shared'
  import { pullMailbox } from '../lib/mailbox'
  import { listDoctorShares, shareStatus } from '../lib/doctorShare'

  let relayUrl = $state('')
  let hue = $state<'a' | 'b'>('a')

  // Card counts. Grants live on the relay; shares and doctor links are local.
  let grantCount = $state(0)
  let sharedWithMeCount = $state(0)
  let doctorTotal = $state(0)
  let doctorActive = $state(0)

  // A QR minted by People.svelte encodes a link to *this* screen
  // (`#/share?code=…`) — the stable public entry the app has always advertised.
  // Redirect it into the people screen with the code applied, so both old links
  // in the wild and freshly-minted ones land in the confirm flow. Runs before
  // any relay gating, since accepting an incoming code doesn't need one.
  const incomingCode = new URLSearchParams(window.location.hash.split('?')[1] ?? '').get('code')
  if (incomingCode) {
    navigate(`#/share/people?code=${encodeURIComponent(incomingCode)}`)
  }

  async function accept(invite: PendingInvite): Promise<void> {
    await acceptInvite(invite, hue === 'a' ? 'b' : 'a')
    sharedWithMeCount = (await listShares()).length
  }

  async function decline(invite: PendingInvite): Promise<void> {
    await declineInvite(invite)
  }

  onMount(async () => {
    if (incomingCode) return // redirecting away; skip the home load entirely
    const storedHue = await get<'a' | 'b'>('prefs', 'hue')
    if (storedHue) hue = storedHue

    relayUrl = (await get<string>('prefs', 'relayUrl')) ?? ''

    const doctorShares = await listDoctorShares()
    doctorTotal = doctorShares.length
    doctorActive = doctorShares.filter((r) => shareStatus(r) === 'active').length

    sharedWithMeCount = (await listShares()).length

    if (relayUrl && session.identity) {
      const relay = new RelayClient(relayUrl, session.identity)
      grantCount = (await relay.listGrants()).length
      await pullMailbox()
    }
  })
</script>

<h1>Sharing</h1>

{#if !relayUrl}
  <p class="muted" data-testid="share-needs-relay">
    Sharing routes handshake metadata through a relay, so it stays reachable across your devices and
    the people you share with. <button
      class="link"
      onclick={() => navigate('#/settings/sync')}
      data-testid="go-connect-relay">Connect a relay in Settings</button
    > to get started.
  </p>
{:else}
  <div class="cards">
    <button class="card" onclick={() => navigate('#/share/people')} data-testid="card-people">
      <span class="card-glyph" aria-hidden="true">⚭</span>
      <span class="card-text">
        <span class="card-title">Your people</span>
        <span class="card-sub muted" data-testid="people-counts">
          Ongoing, read-only access for someone you trust. {grantCount} active grant{grantCount === 1
            ? ''
            : 's'} · {sharedWithMeCount} shared with you.
        </span>
      </span>
      <span class="card-chevron" aria-hidden="true">›</span>
    </button>

    <button class="card" onclick={() => navigate('#/share/doctor')} data-testid="card-doctor">
      <span class="card-glyph" aria-hidden="true">✚</span>
      <span class="card-text">
        <span class="card-title">Doctor links</span>
        <span class="card-sub muted" data-testid="doctor-counts">
          One-time, expiring summaries for a visit. {doctorTotal} link{doctorTotal === 1
            ? ''
            : 's'} · {doctorActive} active.
        </span>
      </span>
      <span class="card-chevron" aria-hidden="true">›</span>
    </button>
  </div>

  {#if $pendingInvites.length > 0}
    <section class="waiting">
      <h2>Waiting for you</h2>
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
    </section>
  {/if}
{/if}

<style>
  .cards {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    margin-top: var(--space-4);
  }

  /* The hub-row idiom (see Settings.svelte): a surfaced, bordered card with a
     leading glyph, a title + muted sub-line, and a trailing chevron. */
  .card {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    width: 100%;
    padding: var(--space-3) var(--space-4);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    background: var(--surface);
    text-align: left;
  }

  .card-glyph {
    flex: none;
    width: 1.5em;
    font-size: var(--text-lg);
    text-align: center;
  }

  .card-text {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-width: 0;
  }

  .card-title {
    font-size: var(--text-base);
  }

  .card-sub {
    font-size: var(--text-xs);
  }

  .card-chevron {
    flex: none;
    color: var(--muted);
    font-size: var(--text-lg);
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

  .waiting {
    margin-top: var(--space-6);
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
</style>
