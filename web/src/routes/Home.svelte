<script lang="ts">
  import { onMount } from 'svelte'
  import { get, getAll } from '../lib/db'
  import { navigate } from '../lib/router.svelte'
  import { fingerprint } from '../lib/exchange'
  import { allEvents, type StoredEvent } from '../lib/events'
  import { pendingRecords, type ProposalRecord } from '../lib/proposals'
  import { relativeTime } from '../lib/time'
  import { BP_SYSTOLIC, BP_DIASTOLIC } from '../lib/codes'
  import {
    listShares,
    acceptInvite,
    declineInvite,
    pendingInvites,
    type Share,
    type PendingInvite,
  } from '../lib/shared'
  import InstallSheet from '../components/InstallSheet.svelte'
  import { shouldNudgeInstall, dismissInstallNudge } from '../lib/install'

  let hue = $state<'a' | 'b'>('a')
  let shares = $state<Share[]>([])
  let showInstallSheet = $state(false)

  // Glanceable dashboard stats, computed cheaply from raw events (no curation
  // load — the full clinical read lives on the Summary page).
  let entryCount = $state(0)
  let lastLoggedAt = $state<string | null>(null)
  let latestBp = $state<string | null>(null)
  let pendingProposals = $state(0)

  onMount(async () => {
    const stored = await get<'a' | 'b'>('prefs', 'hue')
    if (stored) hue = stored
    shares = await listShares()

    const events = await allEvents()
    entryCount = events.length
    lastLoggedAt = newestEffectiveAt(events)
    latestBp = latestBloodPressure(events)

    const proposals = await getAll<ProposalRecord>('proposals')
    pendingProposals = pendingRecords(proposals).reduce(
      (n, r) => n + r.drafts.filter((d) => d.status === 'pending').length,
      0,
    )
  })

  function newestEffectiveAt(events: StoredEvent[]): string | null {
    let newest: string | null = null
    for (const e of events) {
      const at = e.event.effective_at
      if (at && (!newest || at > newest)) newest = at
    }
    return newest
  }

  function newestQuantity(events: StoredEvent[], code: string): { value: string; at: string | null } | null {
    let best: { value: string; at: string | null } | null = null
    for (const { event } of events) {
      if (event.code?.code !== code || !event.value || !('quantity' in event.value)) continue
      const at = event.effective_at
      if (!best || (at && (!best.at || at > best.at))) best = { value: event.value.quantity.value, at }
    }
    return best
  }

  function latestBloodPressure(events: StoredEvent[]): string | null {
    const sys = newestQuantity(events, BP_SYSTOLIC.code)
    const dia = newestQuantity(events, BP_DIASTOLIC.code)
    return sys && dia ? `${sys.value}/${dia.value}` : null
  }

  // Separate from the above so a slow install-nudge read never delays the
  // dashboard data it has nothing to do with.
  onMount(async () => {
    if (await shouldNudgeInstall()) showInstallSheet = true
  })

  async function dismissAndClose(): Promise<void> {
    await dismissInstallNudge()
    showInstallSheet = false
  }

  async function accept(invite: PendingInvite): Promise<void> {
    await acceptInvite(invite, hue === 'a' ? 'b' : 'a')
    shares = await listShares()
  }

  async function decline(invite: PendingInvite): Promise<void> {
    await declineInvite(invite)
  }

  function initials(name: string): string {
    const parts = name.trim().split(/\s+/).filter(Boolean)
    if (parts.length === 0) return '·'
    return (parts[0][0] + (parts[1]?.[0] ?? '')).toUpperCase()
  }
</script>

{#each $pendingInvites as invite (invite.mailboxId)}
  <div class="invite" data-testid="home-invite-banner">
    <p><strong>{invite.label || 'Someone'}</strong> shared their vault with you — accept?</p>
    <p class="data muted" data-testid="home-invite-fingerprint">{fingerprint(invite.fromEd)}</p>
    <div class="row">
      <button class="primary" onclick={() => accept(invite)} data-testid="home-invite-accept">Accept</button>
      <button onclick={() => decline(invite)} data-testid="home-invite-decline">Decline</button>
    </div>
  </div>
{/each}

<section>
  <h2 class="eyebrow">Records</h2>
  <div class="vaults" data-testid="home-records">
    <div class="vault">
      <div class="vault-top">
        <span class="av mine" aria-hidden="true">✦</span>
        <span class="vault-id">
          <span class="nm">My record</span>
          <span class="sub muted">
            {entryCount} {entryCount === 1 ? 'entry' : 'entries'}{#if lastLoggedAt} · last {relativeTime(lastLoggedAt)}{/if}
          </span>
        </span>
      </div>
      <div class="vault-actions">
        <button class="ghost act" onclick={() => navigate('#/timeline')} data-testid="open-timeline">Timeline</button>
        <button class="ghost act" onclick={() => navigate('#/summary')} data-testid="open-summary">Summary</button>
      </div>
    </div>

    {#each shares as share (share.ownerEd)}
      <button
        class="vault person"
        onclick={() => navigate(`#/person/${share.ownerEd}`)}
        data-testid="open-person-{share.ownerEd}"
      >
        <div class="vault-top">
          <span class="av" style:background={`var(--person-${share.hue})`} aria-hidden="true">{initials(share.label)}</span>
          <span class="vault-id">
            <span class="nm" style:color={`var(--person-${share.hue})`}>{share.label || fingerprint(share.ownerEd)}</span>
            <span class="sub muted">read-only{#if share.stale} · no longer shared{/if}</span>
          </span>
        </div>
        <span class="chev" aria-hidden="true">›</span>
      </button>
    {/each}
  </div>
</section>

<section>
  <h2 class="eyebrow">At a glance</h2>
  <div class="cards">
    {#if latestBp}
      <div class="card" data-testid="glance-bp">
        <span class="k">Latest BP</span>
        <span class="v" style:color="var(--cat-vital)">{latestBp}</span>
      </div>
    {/if}
    <div class="card" data-testid="glance-entries">
      <span class="k">Entries</span>
      <span class="v">{entryCount}</span>
    </div>
    <button class="card tappable" onclick={() => navigate('#/proposals')} data-testid="glance-proposals">
      <span class="k">Proposals</span>
      <span class="v" style:color={pendingProposals > 0 ? 'var(--flare)' : undefined}>
        {pendingProposals}<span class="unit"> waiting</span>
      </span>
    </button>
    <button class="card tappable" onclick={() => navigate('#/share')} data-testid="glance-shared">
      <span class="k">Shared with you</span>
      <span class="v">{shares.length}</span>
    </button>
  </div>
</section>

<section class="links">
  <button class="ghost link-btn" onclick={() => navigate('#/correlate')} data-testid="nav-correlate">
    <span aria-hidden="true">◈</span> Patterns
  </button>
  <button class="ghost link-btn" onclick={() => navigate('#/share')} data-testid="nav-share">
    <span aria-hidden="true">◉</span> Sharing
  </button>
</section>

{#if showInstallSheet}
  <InstallSheet onclose={dismissAndClose} />
{/if}

<style>
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

  section {
    margin-top: var(--space-5);
  }

  .eyebrow {
    font-family: var(--font-data);
    font-size: var(--text-xs);
    font-weight: normal;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: var(--muted);
    margin: 0 0 var(--space-2);
  }

  .vaults {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }

  .vault {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    padding: var(--space-3);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    background: var(--surface);
    width: 100%;
    text-align: left;
  }

  .vault.person {
    flex-direction: row;
    align-items: center;
    cursor: pointer;
  }

  .vault.person:hover {
    border-color: var(--action);
  }

  .vault-top {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    flex: 1;
    min-width: 0;
  }

  .av {
    width: 36px;
    height: 36px;
    border-radius: var(--radius-full);
    flex: none;
    display: grid;
    place-items: center;
    font-family: var(--font-data);
    font-size: var(--text-sm);
    color: var(--bg);
  }

  .av.mine {
    background: var(--action);
  }

  .vault-id {
    display: flex;
    flex-direction: column;
    min-width: 0;
  }

  .nm {
    font-weight: 600;
  }

  .sub {
    font-size: var(--text-xs);
  }

  .chev {
    color: var(--muted);
    font-size: var(--text-lg);
    flex: none;
  }

  .vault-actions {
    display: flex;
    gap: var(--space-2);
  }

  .vault-actions .act {
    flex: 1;
    border: 1px solid var(--border);
    color: var(--text);
    min-height: 38px;
  }

  .vault-actions .act:hover {
    border-color: var(--action);
    color: var(--action);
  }

  .cards {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: var(--space-2);
  }

  .card {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    padding: var(--space-3);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    background: var(--surface);
    min-height: 76px;
    text-align: left;
  }

  .card.tappable {
    cursor: pointer;
  }

  .card.tappable:hover {
    border-color: var(--action);
  }

  .card .k {
    font-family: var(--font-data);
    font-size: var(--text-xs);
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--muted);
  }

  .card .v {
    font-family: var(--font-display);
    font-size: var(--text-2xl);
    line-height: 1;
  }

  .card .v .unit {
    font-family: var(--font-body);
    font-size: var(--text-sm);
    color: var(--muted);
  }

  .links {
    display: flex;
    gap: var(--space-2);
  }

  .link-btn {
    flex: 1;
    border: 1px solid var(--border);
    color: var(--text);
  }

  .link-btn:hover {
    border-color: var(--action);
    color: var(--action);
  }
</style>
