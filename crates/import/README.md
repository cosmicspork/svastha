# svastha-import

Client-side C-CDA and FHIR R4 mapping for [Svastha](https://github.com/cosmicspork/svastha):
turns a US EHR export (an Epic Continuity of Care Document, a per-encounter
Summary of Care, or a FollowMyHealth FHIR R4 `Bundle`) into a list of draft
`svastha-core` events, entirely in-browser via `crates/wasm`.

Deliberately **not** part of `svastha-core`: import mapping is churny domain
logic (new EHR quirks, new sections, evolving code-system tables) that will
keep changing long after the trust contract is frozen. Keeping it in its own
crate means `core`'s canonical encoding and content-id rules — the actual audit
surface — never have to move to accommodate a parser fix.

Nothing here decrypts or signs anything; it only produces `EventDraft`s. The
caller (the web app) computes content ids, checks them against the local
event log for dedup, and signs the ones it wants to keep.

> Pre-1.0 and unstable.

Licensed under AGPL-3.0-only.
