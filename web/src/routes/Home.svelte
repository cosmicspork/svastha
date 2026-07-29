<script lang="ts">
  import { onMount } from 'svelte'
  import { get } from '../lib/db'
  import { navigate } from '../lib/router.svelte'
  import { fingerprint } from '../lib/exchange'
  import { allEvents, type StoredEvent } from '../lib/events'
  import { relativeTime } from '../lib/time'
  import {
    recentActivity,
    vitalGlances,
    recentSymptoms,
    medicationGlance,
    type ActivityItem,
    type VitalGlance,
    type SymptomGlance,
    type MedsGlance,
  } from '../lib/glance'
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
  import { loadDictionaryIndex } from '../lib/dictionary'

  let hue = $state<'a' | 'b'>('a')
  let shares = $state<Share[]>([])
  let showInstallSheet = $state(false)

  // Glanceable dashboard stats, computed cheaply from raw events (no curation
  // load — the full clinical read lives on the Summary page). An empty array or
  // a zero count hides that card entirely (see markup), and each vital falls
  // back to its latest reading when there isn't a week of data.
  let entryCount = $state(0)
  let lastLoggedAt = $state<string | null>(null)
  let activity = $state<ActivityItem[]>([])
  let vitals = $state<VitalGlance[]>([])
  let symptoms = $state<SymptomGlance[]>([])
  let meds = $state<MedsGlance>({ count: 0, names: [] })

  onMount(async () => {
    const stored = await get<'a' | 'b'>('prefs', 'hue')
    if (stored) hue = stored
    shares = await listShares()

    const events = await allEvents()
    entryCount = events.length
    lastLoggedAt = newestEffectiveAt(events)
    activity = recentActivity(events)
    vitals = vitalGlances(events)
    // Symptom rows are named through the dictionary; hydrated per mount rather
    // than reactively, since the card is computed once here anyway.
    symptoms = recentSymptoms(events, Date.now(), 14, 5, await loadDictionaryIndex())
    meds = medicationGlance(events)
  })

  function newestEffectiveAt(events: StoredEvent[]): string | null {
    let newest: string | null = null
    for (const e of events) {
      const at = e.event.effective_at
      if (at && (!newest || at > newest)) newest = at
    }
    return newest
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
      <div class="vault" data-testid="open-person-{share.ownerEd}">
        <div class="vault-top">
          <span class="av" style:background={`var(--person-${share.hue})`} aria-hidden="true">{initials(share.label)}</span>
          <span class="vault-id">
            <span class="nm" style:color={`var(--person-${share.hue})`}>{share.label || fingerprint(share.ownerEd)}</span>
            <span class="sub muted">read-only{#if share.stale} · no longer shared{/if}</span>
          </span>
        </div>
        <div class="vault-actions">
          <button class="ghost act" onclick={() => navigate(`#/person/${share.ownerEd}/timeline`)} data-testid="person-timeline-{share.ownerEd}">Timeline</button>
          <button class="ghost act" onclick={() => navigate(`#/person/${share.ownerEd}/summary`)} data-testid="person-summary-{share.ownerEd}">Summary</button>
        </div>
      </div>
    {/each}
  </div>
</section>

<section>
  <div class="links">
    <button class="ghost link-btn" onclick={() => navigate('#/correlate')} data-testid="nav-correlate">
      <span aria-hidden="true">◈</span> Patterns
    </button>
    <button class="ghost link-btn" onclick={() => navigate('#/share')} data-testid="nav-share">
      <span aria-hidden="true">◉</span> Sharing
    </button>
  </div>
</section>

{#if activity.length > 0 || vitals.length > 0 || symptoms.length > 0 || meds.count > 0}
  <section>
    <h2 class="eyebrow">At a glance</h2>
    <div class="cards">
      {#if activity.length > 0}
        <div class="card wide" data-testid="glance-activity">
          <span class="k">Recently logged</span>
          <ul class="loglist">
            {#each activity as item (item.id)}
              <li>
                <span class="cdot" style:background={`var(--cat-${item.category})`}></span>
                <span class="llabel">{item.label}</span>
                {#if item.value}<span class="lvalue data">{item.value}</span>{/if}
                <span class="lago">{relativeTime(item.atIso)}</span>
              </li>
            {/each}
          </ul>
        </div>
      {/if}

      {#if vitals.length > 0}
        <div class="card wide" data-testid="glance-vitals">
          <span class="k">Vitals</span>
          <div class="vitals">
            {#each vitals as v (v.key)}
              <div class="vit">
                <span class="vk">{v.label}</span>
                <span class="vv">
                  {v.value}{#if v.unit} <span class="vu">{v.unit}</span>{/if}
                  {#if v.trend}
                    <span class="trend {v.trend}" aria-hidden="true"
                      >{v.trend === 'down' ? '↓' : v.trend === 'up' ? '↑' : '→'}</span
                    >
                  {/if}
                </span>
                <span class="vsub">{v.basis === 'avg' ? '7-day avg' : 'latest'}</span>
              </div>
            {/each}
          </div>
        </div>
      {/if}

      {#if symptoms.length > 0}
        <button
          class="card wide tappable"
          onclick={() => navigate('#/correlate')}
          data-testid="glance-symptoms"
        >
          <span class="k">Recent symptoms · 14 days</span>
          <span class="chips">
            {#each symptoms as s (s.label)}
              <span class="chip">
                <span class="cdot" style:background="var(--cat-symptom)"></span>{s.label}{#if s.severity !== null}
                  <span class="sev">{s.severity}</span>{/if}
              </span>
            {/each}
          </span>
        </button>
      {/if}

      {#if meds.count > 0}
        <button class="card tappable" onclick={() => navigate('#/summary')} data-testid="glance-meds">
          <span class="k">Medications</span>
          <span class="v">{meds.count}</span>
          <span class="vsub">{meds.names.join(' · ')}</span>
        </button>
      {/if}
    </div>
  </section>
{/if}

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

  .card.wide {
    grid-column: 1 / -1;
  }

  .loglist {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
  }

  .loglist li {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    padding: var(--space-2) 0;
    border-top: 1px solid var(--border);
  }

  .loglist li:first-child {
    border-top: none;
  }

  .cdot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    flex: none;
  }

  /* flex: none + nowrap so a long sibling value (a journal entry, a document
     note) can't collapse this into letter-per-line wrapping — the label is
     always short and should size to its own content, not fight for space. */
  .llabel {
    flex: none;
    white-space: nowrap;
  }

  /* A glance row shows a preview, not the full entry — clamp long free text
     rather than pour the whole note into the dashboard card. */
  .lvalue {
    flex: 1;
    min-width: 0;
    font-size: var(--text-sm);
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }

  .lago {
    flex: none;
    font-size: var(--text-xs);
    color: var(--muted);
    white-space: nowrap;
  }

  /* Vitals: up to 3 per row, centered; wraps to new centered rows for more. */
  .vitals {
    display: flex;
    flex-wrap: wrap;
    justify-content: center;
    gap: var(--space-4);
  }

  .vit {
    display: flex;
    flex-direction: column;
    gap: 2px;
    flex: 1 1 84px;
    max-width: calc((100% - 2 * var(--space-4)) / 3);
  }

  .vk {
    font-family: var(--font-data);
    font-size: var(--text-xs);
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--muted);
  }

  .vv {
    display: flex;
    align-items: baseline;
    flex-wrap: wrap;
    gap: 4px;
    font-family: var(--font-display);
    font-size: var(--text-xl);
    line-height: 1.1;
  }

  .vu {
    font-family: var(--font-body);
    font-size: var(--text-xs);
    color: var(--muted);
  }

  .trend {
    font-family: var(--font-data);
    font-size: var(--text-sm);
  }

  .trend.down {
    color: var(--cat-exercise);
  }

  .trend.up {
    color: var(--flare);
  }

  .trend.flat {
    color: var(--muted);
  }

  .vsub {
    font-size: var(--text-xs);
    color: var(--muted);
  }

  .chips {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
  }

  .chip {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
    padding: 4px var(--space-3);
    border: 1px solid var(--border);
    border-radius: var(--radius-full);
    font-size: var(--text-sm);
  }

  .sev {
    font-family: var(--font-data);
    font-size: var(--text-xs);
    color: var(--muted);
  }

  .links {
    display: flex;
    gap: var(--space-2);
    margin-top: var(--space-3);
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
