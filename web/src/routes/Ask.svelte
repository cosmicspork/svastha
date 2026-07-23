<script lang="ts">
  import { onMount } from 'svelte'
  import { navigate } from '../lib/router.svelte'
  import { fingerprint } from '../lib/exchange'
  import { pullMailbox, sendChatMessage } from '../lib/mailbox'
  import { chatTurns, refreshChat, conversationState } from '../lib/chat'
  import { enrolledNode } from '../lib/nodeadmin'
  import type { ProposerRecord } from '../lib/proposals'
  import CitationList from '../components/CitationList.svelte'
  import NodeAdmin from '../components/NodeAdmin.svelte'

  let node = $state<ProposerRecord | null>(null)
  let resolved = $state(false)
  let question = $state('')
  let sending = $state(false)

  const convoState = $derived(conversationState($chatTurns))

  onMount(async () => {
    // A fresh pull in case an answer arrived before the sync cycle ran, then
    // hydrate from IndexedDB regardless (the conversation persists across
    // reloads, like the proposal inbox).
    await pullMailbox().catch(() => {})
    await refreshChat()
    node = await enrolledNode()
    resolved = true
  })

  async function ask(): Promise<void> {
    const text = question.trim()
    if (!text || !node || sending) return
    sending = true
    try {
      await sendChatMessage({ ed: node.ed, x25519: node.x25519 }, text)
      question = ''
    } finally {
      sending = false
    }
  }

  function onKeydown(e: KeyboardEvent): void {
    // Enter sends; Shift+Enter is a newline (a question can be a few lines).
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      void ask()
    }
  }
</script>

<h1>Ask</h1>

{#if !resolved}
  <p class="muted" data-testid="ask-loading">Loading…</p>
{:else if !node}
  <!-- No node enrolled is a first-class state, not an error: the ask screen has
       nothing to talk to until a processing node is granted access. -->
  <div class="empty" data-testid="ask-no-node">
    <p>
      No processing node is enrolled yet. A node reads your record (with access you grant, like any
      household share) and answers questions drawn only from what you've logged.
    </p>
    <p class="muted">Enroll one from Sync &amp; devices, then come back here to ask.</p>
    <button type="button" class="primary" onclick={() => navigate('#/settings/sync')} data-testid="ask-go-enroll">
      Sync &amp; devices
    </button>
  </div>
{:else}
  <p class="disclaimer" data-testid="ask-disclaimer">
    Answers are retrieved from your own record and cite the entries they draw on. This searches what
    you've logged — it is <strong>not medical advice</strong>.
  </p>

  {#if $chatTurns.length === 0}
    <p class="muted" data-testid="ask-empty">
      Ask a question about your record — a medication history, when a symptom last showed up, what a
      visit noted. The answer will cite the entries it used.
    </p>
  {:else}
    <ol class="transcript" data-testid="ask-transcript">
      {#each $chatTurns as turn (turn.id)}
        <li class="turn {turn.role}" data-testid="ask-turn" data-role={turn.role}>
          <span class="who muted">{turn.role === 'user' ? 'You' : 'Node'}</span>
          <p class="text">{turn.text}</p>
          {#if turn.role === 'node'}
            <CitationList citations={turn.citations} />
          {/if}
        </li>
      {/each}
    </ol>
  {/if}

  {#if convoState === 'waiting'}
    <!-- Honest pending state: nothing here fabricates an answer. It waits for the
         node to reply over the mailbox (poke-bounded latency). -->
    <p class="waiting muted" data-testid="ask-waiting">
      Waiting for your node to answer…
    </p>
  {/if}

  <form
    class="composer"
    onsubmit={(e) => {
      e.preventDefault()
      void ask()
    }}
  >
    <textarea
      bind:value={question}
      onkeydown={onKeydown}
      rows="2"
      placeholder="Ask about your record…"
      disabled={sending}
      data-testid="ask-input"
    ></textarea>
    <button type="submit" class="primary" disabled={sending || question.trim() === ''} data-testid="ask-send">
      Ask
    </button>
  </form>

  <p class="node-fp muted" data-testid="ask-node-fingerprint">
    {node.label || 'Node'} · {fingerprint(node.ed)}
  </p>

  <NodeAdmin {node} />
{/if}

<style>
  .empty {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    align-items: flex-start;
    margin-top: var(--space-3);
  }

  .disclaimer {
    font-size: var(--text-sm);
    color: var(--muted);
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    padding: var(--space-2) var(--space-3);
    margin: var(--space-2) 0 var(--space-4);
  }

  .transcript {
    list-style: none;
    margin: 0 0 var(--space-4);
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }

  .turn {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
  }

  .turn.user {
    align-items: flex-end;
    text-align: right;
  }

  .who {
    font-size: var(--text-xs);
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  .turn .text {
    margin: 0;
    padding: var(--space-2) var(--space-3);
    border-radius: var(--radius-lg);
    background: var(--surface);
    border: 1px solid var(--border);
    max-width: 90%;
    overflow-wrap: anywhere;
    white-space: pre-line;
  }

  .turn.user .text {
    background: var(--action-muted);
    border-color: var(--action);
  }

  .waiting {
    font-size: var(--text-sm);
    margin: 0 0 var(--space-3);
  }

  .composer {
    display: flex;
    gap: var(--space-2);
    align-items: flex-end;
  }

  .composer textarea {
    flex: 1;
    min-width: 0;
    resize: vertical;
    font: inherit;
  }

  .node-fp {
    font-size: var(--text-xs);
    margin: var(--space-3) 0 0;
  }
</style>
