// A one-shot "scroll to and highlight this event on the spine" signal, the
// deep-link target a citation on the ask screen jumps to. Kept as a bare
// `svelte/store` (no router import) so the spine and the ask screen can share it
// without either pulling in a rune module: the ask screen sets it and navigates
// to the record; the spine reads it, scrolls the matching entry into view, and
// clears it after a moment so the highlight reads as a momentary "here it is",
// not a sticky selection.
import { writable } from 'svelte/store'

/** The event content id to focus, or null when nothing is being focused. */
export const focusedEventId = writable<string | null>(null)
