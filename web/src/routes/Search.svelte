<script lang="ts">
  import { onMount } from 'svelte'
  import { navigate } from '../lib/router.svelte'
  import { getAll } from '../lib/db'
  import type { StoredEvent } from '../lib/events'
  import { getShare, sharedEventsFor } from '../lib/shared'
  import { searchEvents, type SearchHit } from '../lib/search'
  import { CATEGORY_META } from '../lib/category'
  import { categorize } from '../lib/category'
  import { focusedEventId } from '../lib/spine-focus'
  import { pullMailbox, sendChatMessage } from '../lib/mailbox'
  import { chatTurns, refreshChat, conversationState } from '../lib/chat'
  import { enrolledNode, getNodeLastSeen } from '../lib/nodeadmin'
  import { loadDictionaryIndex, dictionaryStatus } from '../lib/dictionary'
  import type { ProposerRecord } from '../lib/proposals'
  import CitationList from '../components/CitationList.svelte'
  import EventDetail from '../components/EventDetail.svelte'
  import { describeEvent } from '../lib/timeline'

  // Optional `?person=<ed>`: search a shared record instead of your own. The
  // header's search icon passes it when you're already viewing that person.
  // Read once from the hash query (the router strips the query from its params).
  const params = new URLSearchParams(window.location.hash.split('?')[1] ?? '')
  const person = params.get('person') ?? undefined
  // A query carried in the URL so returning here (Back from a hit's timeline
  // jump) restores the search rather than a blank box.
  const initialQuery = params.get('q') ?? ''

  // A node counts as reachable for AI answers only if it has been heard from
  // recently — enrolled-but-silent shows the toggle disabled rather than sending
  // into the void.
  const NODE_FRESH_MS = 10 * 60 * 1000

  let events = $state<StoredEvent[]>([])
  let scopeLabel = $state<string | null>(null)
  let query = $state(initialQuery)
  // The hit whose detail is expanded in place (null = all collapsed).
  let expandedId = $state<string | null>(null)
  let node = $state<ProposerRecord | null>(null)
  let nodeSeenAt = $state<string | null>(null)
  let aiOn = $state(false)
  let sending = $state(false)
  let ready = $state(false)

  // A node is "asleep" only once it has been heard from and then gone quiet — a
  // freshly enrolled node (never seen) is still askable, so it gets the benefit
  // of the doubt.
  const nodeStale = $derived(!!nodeSeenAt && Date.now() - Date.parse(nodeSeenAt) >= NODE_FRESH_MS)
  const nodeAvailable = $derived(!!node && !nodeStale)
  // The offline code dictionary, hydrated the same way Spine/ClinicianSummary do
  // it — a code with no display of its own is searchable only through this.
  let dictionary = $state<Map<string, string>>(new Map())
  $effect(() => {
    void $dictionaryStatus.version
    void $dictionaryStatus.enabled
    void loadDictionaryIndex().then((d) => (dictionary = d))
  })

  const result = $derived(
    aiOn ? { hits: [] as SearchHit[], truncated: false } : searchEvents(events, query, dictionary),
  )
  const convoState = $derived(conversationState($chatTurns))
  const modeLabel = $derived(aiOn ? `${node?.label || 'Node'} Node` : 'On-device')

  onMount(async () => {
    if (person) {
      const share = await getShare(person)
      scopeLabel = share ? share.label : null
      events = share ? await sharedEventsFor(person) : []
    } else {
      events = await getAll<StoredEvent>('events')
    }
    // AI answers only ever run against your own record (the node is granted your
    // vault, not someone else's), so the toggle is offered only there.
    if (!person) {
      await pullMailbox().catch(() => {})
      await refreshChat()
      node = await enrolledNode()
      nodeSeenAt = (await getNodeLastSeen()) ?? null
    }
    ready = true
  })

  function toggleAi(): void {
    if (!nodeAvailable) return
    aiOn = !aiOn
  }

  async function ask(): Promise<void> {
    const text = query.trim()
    if (!text || !node || sending) return
    sending = true
    try {
      await sendChatMessage({ ed: node.ed, x25519: node.x25519 }, text)
      query = ''
    } finally {
      sending = false
    }
  }

  function onKeydown(e: KeyboardEvent): void {
    if (aiOn && e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      void ask()
    }
  }

  function toggle(hit: SearchHit): void {
    // Expand the hit's detail in place rather than leaving the search — the
    // reported "jumps to the top of the timeline" was a hit flinging you away.
    expandedId = expandedId === hit.event.event.id ? null : hit.event.event.id
  }

  function openHit(hit: SearchHit): void {
    // The optional secondary action: land on the record's timeline and focus
    // the entry via the shared one-shot signal (see spine-focus.ts). Back
    // returns here because the query is kept in the URL (effect below).
    focusedEventId.set(hit.event.event.id)
    navigate(person ? `#/person/${person}/timeline` : '#/timeline')
  }

  // Mirror the query into the URL so a timeline jump (and Back) restores the
  // search. replaceState avoids a history entry per keystroke and doesn't
  // re-trigger the router (matchRoute ignores the query string).
  $effect(() => {
    const next = new URLSearchParams()
    if (person) next.set('person', person)
    if (query.trim()) next.set('q', query)
    const qs = next.toString()
    window.history.replaceState(null, '', qs ? `#/search?${qs}` : '#/search')
  })

  function hueClass(hit: SearchHit): string {
    return CATEGORY_META[categorize(hit.event.event)].hueClass
  }
</script>

<h1>Search</h1>
{#if scopeLabel}
  <p class="scope muted" data-testid="search-scope">Searching {scopeLabel}'s record</p>
{/if}

<div class="results" data-testid="search-results">
  {#if aiOn}
    {#if $chatTurns.length === 0}
      <p class="muted" data-testid="search-ai-empty">
        Ask a question about your record — a medication history, when a symptom last showed up. The
        answer cites the entries it used, and is not medical advice.
      </p>
    {:else}
      <ol class="transcript" data-testid="search-transcript">
        {#each $chatTurns as turn (turn.id)}
          <li class="turn {turn.role}" data-testid="search-turn" data-role={turn.role}>
            <span class="who muted">{turn.role === 'user' ? 'You' : node?.label || 'Node'}</span>
            <p class="text">{turn.text}</p>
            {#if turn.role === 'node'}
              <CitationList citations={turn.citations} />
            {/if}
          </li>
        {/each}
      </ol>
    {/if}
    {#if convoState === 'waiting'}
      <p class="muted waiting" data-testid="search-waiting">Waiting for your node to answer…</p>
    {/if}
  {:else if query.trim() === ''}
    <p class="muted" data-testid="search-prompt">Type to search titles, codes and notes across your record.</p>
  {:else if result.hits.length === 0}
    <p class="muted" data-testid="search-empty">No matches for “{query}”.</p>
  {:else}
    <ul class="hits">
      {#each result.hits as hit (hit.event.event.id)}
        {@const open = expandedId === hit.event.event.id}
        <li>
          <button
            class="hit"
            onclick={() => toggle(hit)}
            aria-expanded={open}
            data-testid="search-hit"
          >
            <span class="dot {hueClass(hit)}" aria-hidden="true">●</span>
            <span class="hit-body">
              <span class="hit-label">{hit.label}</span>
              <span class="hit-sub muted">
                {#if hit.coding}<span class="data">{hit.coding}</span> · {/if}{hit.category}
              </span>
            </span>
            <span class="caret" class:open aria-hidden="true">›</span>
          </button>
          {#if open}
            <div class="hit-detail" data-testid="search-hit-detail">
              <EventDetail
                effectiveAt={hit.event.event.effective_at}
                kind={hit.event.event.kind}
                code={hit.event.event.code ?? null}
                value={describeEvent(hit.event.event).value}
                source={hit.event.event.provenance.source}
                sourceDoc={hit.event.event.provenance.source_doc}
                category={categorize(hit.event.event)}
                testid="search-event-detail"
              />
              <button
                type="button"
                class="open-timeline"
                onclick={() => openHit(hit)}
                data-testid="search-open-timeline"
              >
                Open in timeline →
              </button>
            </div>
          {/if}
        </li>
      {/each}
    </ul>
    {#if result.truncated}
      <p class="muted more" data-testid="search-truncated">Showing the first {result.hits.length} matches — refine your search to narrow them.</p>
    {/if}
  {/if}
</div>

<div class="composer" class:ai={aiOn}>
  <div class="bar">
    {#if aiOn}
      <textarea
        bind:value={query}
        onkeydown={onKeydown}
        rows="1"
        placeholder="Ask a question…"
        disabled={sending}
        data-testid="search-input"
      ></textarea>
      <button
        type="button"
        class="send"
        aria-label="Ask"
        onclick={() => void ask()}
        disabled={sending || query.trim() === ''}
        data-testid="search-send"
      >
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M5 12h14M13 6l6 6-6 6" />
        </svg>
      </button>
    {:else}
      <svg class="mag" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true">
        <circle cx="11" cy="11" r="7" /><path d="M21 21l-4-4" />
      </svg>
      <!-- svelte-ignore a11y_autofocus -->
      <input
        bind:value={query}
        placeholder="Search your record…"
        autocomplete="off"
        data-testid="search-input"
      />
    {/if}
  </div>

  <div class="modebar">
    {#if ready && node}
      <button
        type="button"
        class="aiswitch"
        class:disabled={!nodeAvailable}
        aria-pressed={aiOn}
        disabled={!nodeAvailable}
        onclick={toggleAi}
        data-testid="search-ai-toggle"
      >
        <span class="track" class:on={aiOn}><span class="knob"></span></span>
        <span class="ai-label">
          Ask AI
          {#if nodeStale}<small>{node.label || 'Your node'} is asleep</small>{/if}
        </span>
      </button>
    {:else}
      <span></span>
    {/if}
    <span class="mode-pill" class:remote={aiOn} data-testid="search-mode">{modeLabel}</span>
  </div>
</div>

<style>
  .scope {
    margin: calc(-1 * var(--space-2)) 0 var(--space-4);
    font-size: var(--text-sm);
  }

  .results {
    /* Clear the fixed composer at the bottom. */
    padding-bottom: 8rem;
  }

  .hits {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
  }

  .hit {
    display: flex;
    gap: var(--space-3);
    align-items: flex-start;
    width: 100%;
    text-align: left;
    padding: var(--space-3) var(--space-1);
    border: none;
    border-bottom: 1px solid var(--border);
    border-radius: 0;
    background: transparent;
  }

  .hit:hover {
    background: var(--action-muted);
    border-color: var(--border);
  }

  .dot {
    font-size: 10px;
    line-height: 1.6;
    color: var(--cat-other);
  }

  .hit-body {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  }

  .hit-label {
    line-height: 1.3;
  }

  .hit-sub {
    font-size: var(--text-xs);
  }

  .more {
    font-size: var(--text-xs);
    margin-top: var(--space-3);
  }

  .hit-body {
    flex: 1;
  }

  .caret {
    flex: none;
    align-self: center;
    color: var(--muted);
    transition: transform var(--duration-base) ease;
  }

  .caret.open {
    transform: rotate(90deg);
  }

  .hit-detail {
    padding: 0 var(--space-1) var(--space-3);
  }

  .open-timeline {
    min-height: auto;
    min-width: auto;
    margin-top: var(--space-1);
    padding: var(--space-1) 0;
    border: none;
    background: none;
    color: var(--action);
    font-size: var(--text-sm);
  }

  /* --- AI transcript (mirrors the old Ask screen) --- */
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
  }

  .composer {
    position: fixed;
    left: 0;
    right: 0;
    bottom: 0;
    z-index: 40;
    max-width: 40rem;
    margin: 0 auto;
    background: var(--surface);
    border-top: 1px solid var(--border);
    padding: var(--space-3) max(var(--space-4), env(safe-area-inset-left))
      calc(var(--space-3) + env(safe-area-inset-bottom));
  }

  .bar {
    display: flex;
    gap: var(--space-2);
    align-items: center;
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    background: var(--bg);
    padding: var(--space-1) var(--space-2);
  }

  .bar .mag {
    color: var(--muted);
    flex: none;
    margin-left: var(--space-2);
  }

  .bar input,
  .bar textarea {
    flex: 1;
    min-width: 0;
    min-height: 36px;
    border: none;
    background: transparent;
    padding: var(--space-2);
    font: inherit;
    color: var(--text);
    resize: none;
  }

  .bar input:focus,
  .bar textarea:focus {
    outline: none;
  }

  .send {
    flex: none;
    width: 40px;
    min-width: 40px;
    height: 40px;
    padding: 0;
    border-radius: var(--radius-full);
    border: none;
    background: var(--action);
    color: var(--bg);
    display: grid;
    place-items: center;
  }

  .modebar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-2);
    margin-top: var(--space-2);
    min-height: 28px;
  }

  .aiswitch {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
    min-height: 28px;
    padding: 0;
    border: none;
    background: transparent;
    color: var(--text);
    font-size: var(--text-sm);
  }

  .aiswitch.disabled {
    color: var(--muted);
    cursor: not-allowed;
  }

  .track {
    width: 38px;
    height: 22px;
    border-radius: var(--radius-full);
    background: var(--border);
    flex: none;
    display: flex;
    align-items: center;
    padding: 2px;
  }

  .track.on {
    background: var(--action);
  }

  .knob {
    width: 18px;
    height: 18px;
    border-radius: var(--radius-full);
    background: var(--surface);
    transition: transform var(--duration-fast) ease;
  }

  .track.on .knob {
    transform: translateX(16px);
  }

  .ai-label {
    display: flex;
    flex-direction: column;
    line-height: 1.2;
  }

  .ai-label small {
    font-size: var(--text-xs);
    color: var(--muted);
  }

  .mode-pill {
    display: inline-flex;
    align-items: center;
    gap: var(--space-1);
    font-family: var(--font-data);
    font-size: var(--text-xs);
    letter-spacing: 0.04em;
    color: var(--muted);
    border: 1px solid var(--border);
    border-radius: var(--radius-full);
    padding: var(--space-1) var(--space-3);
    white-space: nowrap;
  }

  .mode-pill.remote {
    color: var(--action);
    border-color: var(--action);
  }
</style>
