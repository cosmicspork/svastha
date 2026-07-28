# svastha-retrieval

Lexical ranking, context rendering, and citation grounding for cited Q&A over a
Svastha vault. Compiles to native and WASM, so the processing node and the PWA
run the same ranker and — more importantly — the same **citation contract**.

No embeddings and no vector store: personal-scale vaults make keyword overlap
plus light recency and kind/intent signals enough, and it keeps the whole thing
auditable. What the trust story rests on is not retrieval sophistication but the
guarantee that every rendered item carries the exact event id it was drawn from,
so an answer can only ever cite a record that was actually supplied as context.

Matching is over unicode alphanumeric words, lowercased, with CJK runs segmented
into character bigrams because those scripts do not space their words. Two limits
worth stating plainly: that segmentation is script-based rather than
dictionary-based, so a CJK bigram can straddle a word boundary and match loosely;
and there is no diacritic folding, so "Ibuprofène" matches "ibuprofène" but not
"Ibuprofene".

This crate holds no vault state and performs no I/O. Callers assemble
[`Candidate`]s — an event plus its resolved display name and curated status —
and get back ranked [`ContextItem`]s. Name and status resolution belong to the
caller because they differ by client: the browser has an offline terminology
dictionary the node does not.

See `docs/ARCHITECTURE.md` in the repository root for how this fits the wider
trust contract.
