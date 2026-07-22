<script lang="ts">
  import type { SummaryRow } from '../lib/summary'

  let {
    title,
    rows,
    hueClass,
    alwaysShow = false,
    emptyText = '',
    dictionaryEnabled = false,
    readonly = false,
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
  } = $props()

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
</script>

{#if rows.length > 0 || alwaysShow}
  <section class="section" data-testid="summary-section-{title.toLowerCase().replace(/\s+/g, '-')}">
    <h2 class="section-head">
      <span class="dot {hueClass}" aria-hidden="true"></span>
      {title}
    </h2>
    {#if rows.length === 0}
      <p class="empty muted" data-testid="summary-empty">{emptyText}</p>
    {:else}
      <ul class="rows">
        {#each rows as row (row.key)}
          <li class="row" data-testid="summary-row">
            <span class="label-stack">
              {#if row.coding && !row.nameResolved}
                <span class="label" data-testid="summary-label"
                  >{row.label} · <span class="code data">{row.coding.system} {row.coding.code}</span></span
                >
                {#if unresolvedHint}
                  <span class="hint" data-testid="summary-unnamed-hint">{unresolvedHint}</span>
                {/if}
              {:else}
                <span class="label" data-testid="summary-label">{row.label}</span>
                {#if row.coding}
                  <span class="code data muted" data-testid="summary-coding"
                    >{row.coding.system} {row.coding.code}</span
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
            <span class="date data muted">{fmtDate(row.date)}</span>
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
    gap: var(--space-1);
  }

  /* Baseline-aligned and wrapping: code displays and lab names are long, so
     the row must reflow rather than overflow. The date pushes to the right on
     one line but drops below on a narrow screen. */
  .row {
    display: flex;
    align-items: baseline;
    flex-wrap: wrap;
    gap: var(--space-2);
    padding: var(--space-1) 0;
    border-bottom: 1px solid var(--border);
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

  /* Demoted beneath a resolved name, or promoted inline next to "Unnamed
     entry" when there's no name to lead with — either way it's provenance,
     not the fact itself, so it stays small and quiet. */
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
    margin-left: auto;
    flex: none;
    font-size: var(--text-xs);
  }
</style>
