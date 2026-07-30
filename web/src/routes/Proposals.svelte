<script lang="ts">
  import { onMount } from 'svelte'
  import { fingerprint } from '../lib/exchange'
  import { approveProposedEvent, type ApprovableContent } from '../lib/events'
  import {
    pendingProposals,
    refreshPendingProposals,
    setDraftStatus,
    groupByProposer,
    getProposer,
    visibleDrafts,
    approveAllSheetCopy,
    PROPOSALS_PAGE_SIZE,
    type ProposalRecord,
    type ProposalDraft,
  } from '../lib/proposals'
  import { pullMailbox, resolveProposalIfDone } from '../lib/mailbox'
  import ProposalDraftRow from '../components/ProposalDraftRow.svelte'
  import Sheet from '../components/Sheet.svelte'

  let busy = $state(false)
  // Proposer Ed25519 -> display label, resolved from the enrollment directory
  // (falls back to the fingerprint the invite flow also shows).
  let labels = $state<Record<string, string>>({})

  const groups = $derived([...groupByProposer($pendingProposals).entries()])

  // How many drafts each proposer group has paginated into view. Keyed by
  // fromEd (not group index) so a group's page position survives the list
  // re-deriving when `pendingProposals` changes.
  let shown = $state<Record<string, number>>({})
  function shownFor(fromEd: string): number {
    return shown[fromEd] ?? PROPOSALS_PAGE_SIZE
  }
  function showMore(fromEd: string): void {
    shown = { ...shown, [fromEd]: shownFor(fromEd) + PROPOSALS_PAGE_SIZE }
  }

  // A proposer that no longer has pending drafts has finished this inbox
  // session. Drop its expanded window so a later, independent batch from the
  // same identity begins at the first page.
  $effect(() => {
    const active = new Set(groups.map(([fromEd]) => fromEd))
    if (Object.keys(shown).some((fromEd) => !active.has(fromEd))) {
      shown = Object.fromEntries(
        Object.entries(shown).filter(([fromEd]) => active.has(fromEd)),
      )
    }
  })

  // Approve-all confirmation sheet: holds the proposer whose sheet is open, or
  // null when closed. The records/count are re-derived from `groups` at
  // render time (not snapshotted here) so the sheet stays correct if the
  // underlying store changes while it's open.
  let confirmFromEd = $state<string | null>(null)
  const confirmRecords = $derived(
    groups.find(([fromEd]) => fromEd === confirmFromEd)?.[1] ?? [],
  )
  const confirmCount = $derived(pendingCount(confirmRecords))

  // If a concurrent update resolves this group, discard its confirmation. A
  // later batch from the same identity must require a new explicit approval.
  $effect(() => {
    if (confirmFromEd && !groups.some(([fromEd]) => fromEd === confirmFromEd)) {
      confirmFromEd = null
    }
  })

  function closeConfirm(): void {
    confirmFromEd = null
  }

  async function confirmApproveAll(): Promise<void> {
    const records = confirmRecords
    confirmFromEd = null
    await approveAll(records)
  }

  onMount(async () => {
    // A fresh pull in case the deep-link arrived before the sync cycle ran; then
    // hydrate from IndexedDB regardless (proposals persist across reloads).
    await pullMailbox().catch(() => {})
    await refreshPendingProposals()
  })

  // A page read on this device is proposed under the owner's own identity, which
  // is deliberately not in the proposer directory (that holds nodes and
  // caregivers). Label it for what it is rather than leaving it as a bare
  // fingerprint of yourself.
  const localEds = $derived(
    new Set($pendingProposals.filter((r) => r.local).map((r) => r.fromEd)),
  )

  $effect(() => {
    for (const [fromEd] of groupByProposer($pendingProposals)) {
      if (labels[fromEd] !== undefined) continue
      labels[fromEd] = fingerprint(fromEd) // provisional until the directory answers
      void getProposer(fromEd).then((p) => {
        if (p?.label) labels = { ...labels, [fromEd]: p.label }
      })
    }
  })

  function proposedFor(record: ProposalRecord, draft: ProposalDraft) {
    return {
      by: record.fromEd,
      source_blob: draft.source_blob,
      method: draft.method,
      model: draft.model,
    }
  }

  async function approve(
    record: ProposalRecord,
    draft: ProposalDraft,
    content: ApprovableContent,
  ): Promise<void> {
    busy = true
    try {
      await approveProposedEvent(content, proposedFor(record, draft))
      await setDraftStatus(record.id, draft.event.id, 'approved')
      await resolveProposalIfDone(record.id)
    } finally {
      busy = false
    }
  }

  async function reject(record: ProposalRecord, draft: ProposalDraft): Promise<void> {
    busy = true
    try {
      await setDraftStatus(record.id, draft.event.id, 'rejected')
      await resolveProposalIfDone(record.id)
    } finally {
      busy = false
    }
  }

  /** Batch approval per proposer: sign every still-pending draft across all of
   * that proposer's messages as-is, then resolve each message (which echoes one
   * proposal_result per message). */
  async function approveAll(records: ProposalRecord[]): Promise<void> {
    busy = true
    try {
      for (const record of records) {
        for (const draft of record.drafts) {
          if (draft.status !== 'pending') continue
          await approveProposedEvent(
            {
              kind: draft.event.kind,
              code: draft.event.code,
              effective_at: draft.event.effective_at,
              value: draft.event.value,
              provenance: draft.event.provenance,
            },
            proposedFor(record, draft),
          )
          await setDraftStatus(record.id, draft.event.id, 'approved')
        }
        await resolveProposalIfDone(record.id)
      }
    } finally {
      busy = false
    }
  }

  function pendingCount(records: ProposalRecord[]): number {
    return records.reduce((n, r) => n + r.drafts.filter((d) => d.status === 'pending').length, 0)
  }
</script>

<h1>Proposals</h1>

{#if groups.length === 0}
  <p class="muted" data-testid="proposals-empty">
    No proposals waiting. When a device or caregiver you've granted access suggests entries drawn
    from your records, they'll appear here for you to review and sign.
  </p>
{:else}
  <p class="intro muted">
    Draft entries suggested by a device or person you've granted access. Nothing is added to your
    record until you approve it — approving signs the entry with your own key.
  </p>

  {#each groups as [fromEd, records] (fromEd)}
    {@const { visible, remaining } = visibleDrafts(records, shownFor(fromEd))}
    <section class="proposer" data-testid="proposer-group">
      <header class="phead">
        <div class="who">
          <span class="plabel"
            >{localEds.has(fromEd) ? 'This device' : (labels[fromEd] ?? fingerprint(fromEd))}</span
          >
          <span class="fp data muted" data-testid="proposer-fingerprint">{fingerprint(fromEd)}</span>
        </div>
        {#if pendingCount(records) > 1}
          <button
            class="approve-all"
            disabled={busy}
            onclick={() => (confirmFromEd = fromEd)}
            data-testid="proposer-approve-all"
          >
            Approve all ({pendingCount(records)})
          </button>
        {/if}
      </header>

      {#each visible as { record, draft } (`${record.id}:${draft.event.id}`)}
        <ProposalDraftRow
          {draft}
          {busy}
          onApprove={(content) => approve(record, draft, content)}
          onReject={() => reject(record, draft)}
        />
      {/each}

      {#if remaining > 0}
        <button
          type="button"
          class="ghost show-more"
          onclick={() => showMore(fromEd)}
          data-testid="proposer-show-more"
        >
          Show {PROPOSALS_PAGE_SIZE} more ({remaining} left)
        </button>
      {/if}
    </section>
  {/each}
{/if}

{#if confirmFromEd && confirmRecords.length > 0}
  {@const copy = approveAllSheetCopy(confirmCount)}
  <Sheet onclose={closeConfirm}>
    <h2 data-testid="approve-all-heading">{copy.heading}</h2>
    <p>{copy.body}</p>
    <div class="row">
      <button
        type="button"
        class="primary"
        disabled={busy}
        onclick={confirmApproveAll}
        data-testid="approve-all-confirm"
      >
        {copy.confirmLabel}
      </button>
      <button
        type="button"
        class="ghost"
        disabled={busy}
        onclick={closeConfirm}
        data-testid="approve-all-review"
      >
        Review one by one
      </button>
      <button
        type="button"
        class="ghost"
        disabled={busy}
        onclick={closeConfirm}
        data-testid="approve-all-cancel"
      >
        Cancel
      </button>
    </div>
  </Sheet>
{/if}

<style>
  .intro {
    font-size: var(--text-sm);
    margin: var(--space-2) 0 var(--space-5);
  }

  .proposer {
    margin-bottom: var(--space-6);
  }

  .phead {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-3);
    margin-bottom: var(--space-1);
  }

  .who {
    display: flex;
    flex-direction: column;
    min-width: 0;
  }

  .plabel {
    font-size: var(--text-base);
  }

  .fp {
    font-size: var(--text-xs);
  }

  .approve-all {
    flex: none;
    padding: var(--space-2) var(--space-3);
    border: 1px solid var(--action);
    border-radius: var(--radius-sm);
    background: var(--action-muted);
    color: var(--action);
    font-size: var(--text-sm);
  }

  .show-more {
    width: 100%;
    margin-top: var(--space-1);
    font-size: var(--text-sm);
  }

  .row {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
    margin-top: var(--space-4);
  }
</style>
