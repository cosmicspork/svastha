<script lang="ts">
  import type { SummaryRow } from '../lib/summary'
  import {
    startSwipe,
    trackSwipe,
    resolveSwipe,
    isSwiping,
    SWIPE_THRESHOLD_PX,
    type Swipe,
  } from '../lib/swipe'

  let {
    title,
    rows,
    hueClass,
    alwaysShow = false,
    emptyText = '',
    dictionaryEnabled = false,
    readonly = false,
    heading = 'h2',
    curateLabel = 'Edit',
    detailLabel = 'Value',
    onrowtap,
    onviewtimeline,
  }: {
    title: string
    rows: SummaryRow[]
    /** A `cat-*` class from base.css tinting the section's leading dot. */
    hueClass: string
    /** Render even when empty (Allergies — clinical absence can't be proven
     * from imported data, so the section must not just vanish). */
    alwaysShow?: boolean
    emptyText?: string
    /** Whether the offline code dictionary (see lib/dictionary.ts) is enabled —
     * changes the hint shown under an unresolved row's code. */
    dictionaryEnabled?: boolean
    /** True for a recipient's read-only render (doctor-share preview / Person
     * view), which has no Settings screen to point the "download it" hint at. */
    readonly?: boolean
    /** The section heading level. A sub-group (Current/Past, Active/Resolved)
     * renders `h3` under the parent's `h2`; standalone sections keep `h2`. */
    heading?: 'h2' | 'h3'
    /** What the curate action is called on this section's rows ("Mark past or
     * rename"), used on the swipe-right label and the panel button. */
    curateLabel?: string
    /** What `row.detail` is called in the expanded panel — "Dose" for meds,
     * "Doses" for immunizations, a measured "Value" elsewhere. */
    detailLabel?: string
    /** Owner-only: opens the status/name action sheet. Reached by the panel's
     * curate button or a swipe right — never a plain tap, which expands the
     * row. Absent (or `readonly`) drops both affordances. */
    onrowtap?: (row: SummaryRow) => void
    /** Jump to this concept on the timeline. Reached by the panel's button or a
     * swipe left. Absent drops both. */
    onviewtimeline?: (row: SummaryRow) => void
  } = $props()

  // Curation is owner-only in v1 (see ClinicianSummary), so a recipient's rows
  // expand and link to the timeline but never offer the action sheet.
  const canCurate = $derived(!readonly && onrowtap !== undefined)
  const canViewTimeline = $derived(onviewtimeline !== undefined)

  // Which rows are expanded. A Set, not a single key: comparing two labs means
  // reading both panels at once.
  let expanded = $state<Set<string>>(new Set())
  function toggle(key: string): void {
    const next = new Set(expanded)
    if (next.has(key)) next.delete(key)
    else next.add(key)
    expanded = next
  }

  // --- swipe: right = curate, left = see on timeline ---
  // One finger at a time, so a single active-row cursor is enough; the gesture
  // rules live in lib/swipe.ts.
  let activeKey = $state<string | null>(null)
  let swipe = $state<Swipe>(startSwipe(0, 0))
  // A committed horizontal drag ends with a click on the same button; that one
  // must not also expand the row.
  let swallowClick = false

  const offset = (row: SummaryRow): number =>
    activeKey === row.key && isSwiping(swipe) ? swipe.dx : 0

  function onDown(e: PointerEvent, row: SummaryRow): void {
    if (!canCurate && !canViewTimeline) return
    activeKey = row.key
    swipe = startSwipe(e.clientX, e.clientY)
    swallowClick = false
  }

  function onMove(e: PointerEvent): void {
    if (activeKey === null) return
    const before = swipe.axis
    swipe = trackSwipe(swipe, e.clientX, e.clientY)
    if (swipe.axis === 'y') {
      activeKey = null // vertical — let the page scroll
      return
    }
    if (isSwiping(swipe)) {
      swallowClick = true
      // Capture on the lock, once: the finger may leave the row's box mid-drag.
      if (before === null) (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    }
  }

  function onUp(row: SummaryRow): void {
    if (activeKey === null) return
    const action = resolveSwipe(swipe)
    // Guard each direction on its own affordance: a swipe toward an action the
    // row doesn't have does nothing rather than falling through to the other.
    if (action === 'right' && canCurate) onrowtap?.(row)
    else if (action === 'left' && canViewTimeline) onviewtimeline?.(row)
    activeKey = null
    swipe = startSwipe(0, 0)
  }

  function onClick(key: string): void {
    if (swallowClick) {
      swallowClick = false
      return
    }
    toggle(key)
  }

  /** date-part only, parsed as local midnight to avoid a timezone shift on a
   * date-only clinical fact; year included because onset/result years matter. */
  function fmtDate(iso: string | null): string {
    if (!iso) return 'date unknown'
    const d = new Date(`${iso.slice(0, 10)}T00:00:00`)
    return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
  }

  /** The hint under an unresolved row's code. Empty when read-only and the
   * dictionary is off — there's no Settings screen to send a recipient to, so
   * the code alone has to speak for itself. */
  const unresolvedHint = $derived(
    dictionaryEnabled
      ? 'no name found — the dictionary may name it after an update'
      : readonly
        ? ''
        : 'download the code dictionary in Settings to name coded entries',
  )

  const panelId = (key: string): string => `sum-panel-${key.replace(/[^a-zA-Z0-9]+/g, '-')}`
</script>

{#if rows.length > 0 || alwaysShow}
  <section class="section" data-testid="summary-section-{title.toLowerCase().replace(/\s+/g, '-')}">
    <svelte:element this={heading} class="section-head" class:sub={heading === 'h3'}>
      <span class="dot {hueClass}" aria-hidden="true"></span>
      {title}
    </svelte:element>
    {#if rows.length === 0}
      <p class="empty muted" data-testid="summary-empty">{emptyText}</p>
    {:else}
      <ul class="rows">
        {#each rows as row (row.key)}
          {@const open = expanded.has(row.key)}
          {@const dx = offset(row)}
          <li class="row-item" data-testid="summary-row" data-status={row.status}>
            <div class="swipe-frame">
              <!-- Swipe affordances, revealed as the face slides off them. -->
              {#if canCurate}
                <span class="action curate" aria-hidden="true" style:opacity={dx > 8 ? 1 : 0}>
                  {curateLabel}
                </span>
              {/if}
              {#if canViewTimeline}
                <span class="action timeline" aria-hidden="true" style:opacity={dx < -8 ? 1 : 0}>
                  Timeline
                </span>
              {/if}
              <button
                type="button"
                class="row"
                class:sliding={activeKey === row.key && isSwiping(swipe)}
                class:armed={Math.abs(dx) >= SWIPE_THRESHOLD_PX}
                style:transform={dx === 0 ? undefined : `translateX(${dx}px)`}
                aria-expanded={open}
                aria-controls={panelId(row.key)}
                onpointerdown={(e) => onDown(e, row)}
                onpointermove={onMove}
                onpointerup={() => onUp(row)}
                onpointercancel={() => onUp(row)}
                onclick={() => onClick(row.key)}
                data-testid="summary-row-trigger"
              >
                <span class="row-main">
                  <span class="label-stack">
                    {#if row.nameResolved}
                      <span class="label" data-testid="summary-label">{row.label}</span>
                    {:else}
                      <!-- Nothing named this concept, so the coding IS the row's
                           identity — without it every unnamed entry would read
                           "Unnamed entry" and be indistinguishable. Named rows
                           keep their code in the panel, out of the way. -->
                      <span class="label" data-testid="summary-label"
                        >{row.label} ·
                        <span class="code data">{row.coding?.system} {row.coding?.code}</span></span
                      >
                      {#if unresolvedHint}
                        <span class="hint" data-testid="summary-unnamed-hint">{unresolvedHint}</span
                        >
                      {/if}
                    {/if}
                  </span>
                  {#if row.detail}
                    <span class="detail data">{row.detail}</span>
                  {/if}
                  {#if row.count > 1}
                    <span class="count muted" title="{row.count} records">×{row.count}</span>
                  {/if}
                </span>
                <span class="trail">
                  <span class="date data muted">{fmtDate(row.date)}</span>
                  <span class="chevron" class:open aria-hidden="true">›</span>
                </span>
              </button>
            </div>
            <!-- Always in the DOM (so aria-controls resolves and the grid-rows
                 expand animates); collapsed to 0fr until open. Same idiom as
                 the timeline's provenance panel. -->
            <div class="panel-wrap" class:open>
              <div class="panel-inner">
                <dl class="panel {hueClass}" id={panelId(row.key)} data-testid="summary-row-panel">
                  {#if row.coding}
                    <div class="prow">
                      <dt>Code</dt>
                      <dd class="data" data-testid="summary-coding">
                        {row.coding.system}
                        {row.coding.code}
                      </dd>
                    </div>
                  {/if}
                  {#if row.detail}
                    <div class="prow">
                      <dt>{detailLabel}</dt>
                      <dd class="data">{row.detail}</dd>
                    </div>
                  {/if}
                  <div class="prow">
                    <dt>Recorded</dt>
                    <dd>{fmtDate(row.date)}</dd>
                  </div>
                  <div class="prow">
                    <dt>Records</dt>
                    <dd>{row.count} {row.count === 1 ? 'entry' : 'entries'}</dd>
                  </div>
                  {#if canCurate || canViewTimeline}
                    <div class="panel-actions">
                      {#if canViewTimeline}
                        <button
                          type="button"
                          class="tonal panel-btn"
                          onclick={() => onviewtimeline?.(row)}
                          data-testid="summary-row-timeline"
                        >
                          See on timeline
                        </button>
                      {/if}
                      {#if canCurate}
                        <button
                          type="button"
                          class="tonal panel-btn"
                          onclick={() => onrowtap?.(row)}
                          data-testid="summary-row-curate"
                        >
                          {curateLabel}
                        </button>
                      {/if}
                    </div>
                  {/if}
                </dl>
              </div>
            </div>
          </li>
        {/each}
      </ul>
    {/if}
  </section>
{/if}

<style>
  .section {
    margin-bottom: var(--space-5);
  }

  .section-head {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    font-family: var(--font-display);
    font-size: var(--text-lg);
    margin-bottom: var(--space-2);
  }

  /* A Current/Past or Active/Resolved sub-group heading: smaller and quieter
     than the parent section's h2, and no leading dot (the parent carries it). */
  .section-head.sub {
    font-size: var(--text-md);
    margin-bottom: var(--space-1);
  }

  .section-head.sub .dot {
    display: none;
  }

  .dot {
    flex: none;
    width: 10px;
    height: 10px;
    border-radius: 50%;
    background: currentColor;
  }

  .empty {
    margin: 0;
    font-size: var(--text-sm);
  }

  .rows {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
  }

  /* The face's positioning context: the swipe actions sit under it, clipped so
     they can't bleed past the row's edges. The expand panel is a sibling of
     this frame, so it never slides or clips with the face. */
  .swipe-frame {
    position: relative;
    overflow: hidden;
    border-radius: var(--radius-sm);
  }

  .action {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    padding: 0 var(--space-3);
    font-size: var(--text-xs);
    font-family: var(--font-data);
    letter-spacing: 0.04em;
    pointer-events: none;
  }

  .action.curate {
    justify-content: flex-start;
    background: var(--action-muted);
    color: var(--action);
  }

  /* The two directions read as different actions at a glance: curating tints
     fern (the app's action hue), the timeline jump stays a neutral surface. */
  .action.timeline {
    justify-content: flex-end;
    background: var(--surface);
    border: 1px solid var(--border);
    color: var(--muted);
  }

  /* Baseline-aligned and wrapping: lab names are long, so the row must reflow
     rather than overflow. The date pushes to the right on one line but drops
     below on a narrow screen. Resets the global button chrome; the 44px
     min-height is the touch target. */
  .row {
    position: relative;
    display: flex;
    align-items: center;
    gap: var(--space-2);
    width: 100%;
    min-height: 44px;
    padding: var(--space-2) var(--space-1);
    border: none;
    border-bottom: 1px solid var(--border);
    border-radius: 0;
    background: var(--bg);
    color: inherit;
    text-align: left;
    /* Vertical pans scroll the page; horizontal pans are ours to interpret. */
    touch-action: pan-y;
  }

  /* Snap-back / rest transition; suppressed while the finger is actively
     dragging so the face tracks the pointer 1:1. Reduced-motion strips it. */
  .row:not(.sliding) {
    transition: transform var(--duration-base) cubic-bezier(0.2, 0.9, 0.3, 1);
  }

  .row:hover,
  .row:focus-visible {
    background: var(--surface);
    outline-offset: -2px;
  }

  /* Past the threshold: the action under the finger will fire on release. */
  .row.armed {
    box-shadow: 0 0 0 1px var(--action);
  }

  /* Content that wraps lives here; .trail (date + chevron) is a non-wrapping
     cluster centered on the row, so the date never strands the chevron on a
     line of its own — the same split SpineEntry uses. */
  .row-main {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: baseline;
    flex-wrap: wrap;
    gap: var(--space-2);
  }

  .trail {
    flex: none;
    display: flex;
    align-items: center;
    gap: var(--space-2);
  }

  .label-stack {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  }

  .label {
    font-family: var(--font-body);
    min-width: 0;
    overflow-wrap: anywhere;
  }

  /* Promoted inline next to "Unnamed entry" — the only rows that still show a
     code on the face. */
  .code {
    font-size: var(--text-xs);
  }

  .hint {
    font-size: var(--text-xs);
    color: var(--flare);
  }

  .detail {
    min-width: 0;
    word-break: normal;
    overflow-wrap: anywhere;
  }

  .count {
    font-size: var(--text-xs);
  }

  .date {
    flex: none;
    font-size: var(--text-xs);
    white-space: nowrap;
  }

  .chevron {
    flex: none;
    color: var(--muted);
    font-size: var(--text-sm);
    line-height: 1;
    transition: transform var(--duration-base) ease;
  }

  .chevron.open {
    transform: rotate(90deg);
  }

  /* Height-only expand: animating grid-template-rows 0fr->1fr needs no fixed
     height. The base.css reduced-motion kill-switch drops the transition. */
  .panel-wrap {
    display: grid;
    grid-template-rows: 0fr;
    transition: grid-template-rows var(--duration-base) ease;
  }

  .panel-wrap.open {
    grid-template-rows: 1fr;
  }

  .panel-inner {
    min-height: 0;
    overflow: hidden;
  }

  /* Mirrors the timeline's EventDetail panel so a code reads the same in both
     places: quiet background, category-tinted left rule, dt/dd metadata rows. */
  .panel {
    margin: var(--space-1) 0 var(--space-2);
    padding: var(--space-3);
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    background: color-mix(in srgb, var(--surface) 55%, var(--bg));
    border: 1px solid var(--border);
    border-left-width: 2px;
    border-left-color: currentColor;
    border-radius: 0 var(--radius-lg) var(--radius-lg) 0;
  }

  .prow {
    display: flex;
    gap: var(--space-3);
    color: var(--text);
  }

  .panel dt {
    flex: none;
    width: 6rem;
    font-size: var(--text-xs);
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--muted);
  }

  .panel dd {
    margin: 0;
    min-width: 0;
    font-size: var(--text-sm);
    overflow-wrap: anywhere;
  }

  .panel-actions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
    padding-top: var(--space-1);
  }

  .panel-btn {
    min-height: 36px;
    padding: var(--space-1) var(--space-3);
    font-size: var(--text-sm);
    color: var(--action);
  }
</style>
