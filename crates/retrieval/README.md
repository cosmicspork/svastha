# svastha-retrieval

Lexical ranking, context rendering, and citation grounding for cited Q&A over a
Svastha vault. Compiles to native and WASM, so the processing node and the PWA
run the same ranker and — more importantly — the same **citation contract**.

Matching is over unicode alphanumeric words, lowercased, with CJK runs segmented
into character bigrams because those scripts do not space their words. A term
that is a single CJK character on its own also matches a bigram containing it,
so a one-character name stays reachable from a longer question and vice versa.
Two limits worth stating plainly: the segmentation is script-based rather than
dictionary-based, so a CJK bigram can straddle a word boundary and match loosely;
and there is no diacritic folding, so "Ibuprofène" matches "ibuprofène" but not
"Ibuprofene".

This crate holds no vault state and performs no I/O. Callers assemble candidates
— an event plus its resolved display name and curated status — and get back
ranked context items.

Why there are no embeddings, where tenancy isolation actually lives, and why name
and status resolution are left to the caller are covered in the crate docs
(`src/lib.rs`, or `cargo doc --open -p svastha-retrieval`).

See `docs/ARCHITECTURE.md` in the repository root for how this fits the wider
trust contract.
