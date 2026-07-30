//! Retrieval for cited Q&A (design §7): the adapter from **one owner's**
//! [`VaultIndex`] to the shared ranker in [`svastha_retrieval`].
//!
//! The scoring, rendering, and citation grounding live in that crate so the node
//! and the browser run one implementation rather than two that can drift. What
//! stays here is the part that is genuinely node-specific: turning an index into
//! candidates, which means resolving each event's display name and its curated
//! status.
//!
//! ## Tenancy isolation is structural, not disciplinary
//!
//! [`retrieve`] takes a single `&VaultIndex` and builds its candidate list from
//! that index alone. There is no code path by which a question routed to owner
//! A's index can read owner B's events — not because the caller is careful, but
//! because B's events live in a different `VaultIndex` this function is never
//! handed. The shared ranker then scores exactly the candidates it is given, so a
//! citation can only ever be an id from the one index passed in.
//!
//! ## Curation-aware
//!
//! The owner's overlay is applied here, where the index can supply it: the
//! `name:` display override becomes the candidate's name, and the `status:`
//! current-vs-past distinction becomes its status — which the ranker both shows
//! the model (`[current]`/`[past]`) and uses to re-rank.
//!
//! ## Scope-aware, before anything is scored
//!
//! The owner's opt-in categories ([`crate::answer_scope`]) gate the candidate
//! list itself. An entry the owner has not opted in never becomes a
//! [`Candidate`], so it cannot be ranked, rendered, or cited — the exclusion is a
//! property of what retrieval was given, not of what it chose to return.

use svastha_core::event::{Event, EventKind, EventValue};
use svastha_retrieval::{rank, AnswerScope, Candidate};

pub use svastha_retrieval::ContextItem;

use crate::index::VaultIndex;

/// Rank an owner's vault against `question` and return up to `max_items` rendered
/// context items, highest score first. Only events with at least one keyword
/// overlap are returned, so an unanswerable question yields an **empty** result —
/// which [`crate::chat`] turns into an honest "couldn't answer", never uncited
/// prose over an irrelevant dump of the record.
///
/// `scope` is the owner's own opt-in choice; entries outside it are dropped
/// before ranking, so a question only they could answer yields that same empty
/// result rather than a guess assembled without them.
pub fn retrieve(
    index: &VaultIndex,
    scope: &AnswerScope,
    question: &str,
    max_items: usize,
) -> Vec<ContextItem> {
    let candidates: Vec<Candidate<'_>> = index
        .events()
        .filter(|signed| scope.allows(&signed.event))
        .map(|signed| {
            let event = &signed.event;
            let concept = VaultIndex::concept_key(event);
            Candidate {
                event,
                name: render_name(index, event, &concept),
                status: index.concept_status(&concept),
            }
        })
        .collect();
    rank(&candidates, question, max_items)
}

/// The name a concept renders under: the owner's `name:` override first, then the
/// concept's coding — `display`, else `system code` — then, for an uncoded event,
/// its text value or bare kind. Mirrors the render-time name chain the web uses,
/// minus the offline dictionary (not present on the node).
///
/// The coding is [`VaultIndex::coding_for`], not `event.code`, and it has to be:
/// an allergy imports with `code: null` and its substance in `value.coded`, so
/// branching on `event.code` alone put the bare kind in the name slot and fed the
/// node's model a worse line than the browser's for the same event. Reusing the
/// index's resolution is also what keeps this in step with `concept_key` and the
/// web's `codingFor`, which both already fall back this way.
fn render_name(index: &VaultIndex, event: &Event, concept: &str) -> String {
    if let Some(display) = index.concept_display(concept) {
        return display;
    }
    if let Some(code) = VaultIndex::coding_for(event) {
        if let Some(display) = &code.display {
            if !display.trim().is_empty() {
                return display.clone();
            }
        }
        return format!("{} {}", code.system, code.code);
    }
    // Uncoded: a note/narrative reads as its own text.
    if let Some(EventValue::Text(t)) = &event.value {
        return t.clone();
    }
    kind_wire(&event.kind)
}

/// An event kind's stable `snake_case` wire name via serde (the same source
/// [`crate::index`] uses).
fn kind_wire(kind: &EventKind) -> String {
    serde_json::to_value(kind)
        .ok()
        .and_then(|v| v.as_str().map(str::to_string))
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use svastha_core::event::{Code, Event, EventKind, EventValue, Provenance, SignedEvent};
    use svastha_core::keys::Identity;
    use svastha_retrieval::SensitiveCategory;

    fn owner() -> Identity {
        Identity::from_seed(b"retrieval owner")
    }

    fn med(o: &Identity, rxnorm: &str, display: &str, date: &str) -> SignedEvent {
        o.sign_event(Event::new(
            EventKind::MedicationStatement,
            Some(Code {
                system: "http://www.nlm.nih.gov/research/umls/rxnorm".into(),
                code: rxnorm.into(),
                display: Some(display.into()),
            }),
            Some(date.into()),
            None,
            Provenance {
                source: "import".into(),
                source_doc: None,
            },
        ))
    }

    fn note(o: &Identity, text: &str, date: &str) -> SignedEvent {
        o.sign_event(Event::new(
            EventKind::Document,
            None,
            Some(date.into()),
            Some(EventValue::Text(text.into())),
            Provenance {
                source: "self".into(),
                source_doc: None,
            },
        ))
    }

    fn idx(o: &Identity, events: &[SignedEvent]) -> VaultIndex {
        let mut idx = VaultIndex::new(o.verifying_key().to_bytes());
        for e in events {
            assert!(idx.ingest_event(e.clone()));
        }
        idx
    }

    #[test]
    fn matches_on_keyword_and_cites_the_event_id() {
        let o = owner();
        let m = med(&o, "197361", "Lisinopril 10mg", "2025-01-01");
        let idx = idx(&o, &[m.clone(), note(&o, "annual eye exam", "2024-02-02")]);
        let hits = retrieve(&idx, &AnswerScope::default(), "am I on lisinopril?", 10);
        assert_eq!(hits.len(), 1, "only the lisinopril med matches");
        assert_eq!(hits[0].event_id, m.event.id.to_hex());
    }

    #[test]
    fn unrelated_question_returns_nothing() {
        let o = owner();
        let idx = idx(&o, &[med(&o, "197361", "Lisinopril", "2025-01-01")]);
        assert!(
            retrieve(
                &idx,
                &AnswerScope::default(),
                "what vaccines have I had?",
                10
            )
            .is_empty(),
            "no keyword overlap → empty, so chat answers honestly"
        );
    }

    #[test]
    fn empty_or_stopword_only_question_returns_nothing() {
        let o = owner();
        let idx = idx(&o, &[med(&o, "197361", "Lisinopril", "2025-01-01")]);
        assert!(retrieve(&idx, &AnswerScope::default(), "what is that?", 10).is_empty());
        assert!(retrieve(&idx, &AnswerScope::default(), "", 10).is_empty());
    }

    #[test]
    fn current_intent_demotes_a_resolved_concept() {
        // Two metformin meds under distinct concepts, one marked past. A
        // "currently taking" question ranks the active one first — even though the
        // resolved one is newer — honoring the owner's status curation.
        let o = owner();
        let active = med(&o, "111", "metformin tablet", "2020-01-01");
        let stopped = med(&o, "222", "metformin syrup", "2021-01-01");
        let mut idx = idx(&o, &[active.clone(), stopped.clone()]);
        let stopped_concept = VaultIndex::concept_key(&stopped.event);
        idx.ingest_curation(o.sign_curation(
            format!("status:{stopped_concept}"),
            json!({ "status": "inactive" }),
            1000,
        ));

        let hits = retrieve(
            &idx,
            &AnswerScope::default(),
            "what metformin am I currently taking?",
            10,
        );
        assert_eq!(hits.len(), 2, "both mention metformin");
        assert_eq!(
            hits[0].event_id,
            active.event.id.to_hex(),
            "the active (current) med outranks the resolved one despite being older"
        );
    }

    #[test]
    fn name_override_makes_a_concept_findable_and_is_shown() {
        // The stored code has no display; the owner's name: override supplies one,
        // and retrieval both ranks and renders on it.
        let o = owner();
        let e = o.sign_event(Event::new(
            EventKind::MedicationStatement,
            Some(Code {
                system: "http://www.nlm.nih.gov/research/umls/rxnorm".into(),
                code: "197361".into(),
                display: None,
            }),
            Some("2025-01-01".into()),
            None,
            Provenance {
                source: "import".into(),
                source_doc: None,
            },
        ));
        let mut idx = idx(&o, std::slice::from_ref(&e));
        let concept = VaultIndex::concept_key(&e.event);
        idx.ingest_curation(o.sign_curation(
            format!("name:{concept}"),
            json!({ "display": "Lisinopril" }),
            1,
        ));
        let hits = retrieve(&idx, &AnswerScope::default(), "lisinopril dose?", 10);
        assert_eq!(hits.len(), 1);
        assert!(
            hits[0].text.contains("Lisinopril"),
            "override name is rendered"
        );
        assert!(hits[0].text.contains("current"), "current med tagged");
    }

    #[test]
    fn recency_breaks_ties_toward_newer() {
        let o = owner();
        let old = note(&o, "headache reported", "2010-05-05");
        let new = note(&o, "headache reported", "2024-05-05");
        let idx = idx(&o, &[old.clone(), new.clone()]);
        let hits = retrieve(&idx, &AnswerScope::default(), "headache", 10);
        assert_eq!(hits.len(), 2);
        assert_eq!(hits[0].event_id, new.event.id.to_hex(), "newer first");
    }

    /// The two clients share the ranker but resolve names themselves, so the one
    /// place they can still diverge is the name — and an allergy is where they
    /// did: it imports with `code: null` and its substance in `value.coded`, a
    /// fallback the web's `resolveName` had and the node's `render_name` did not.
    /// The node put the bare kind in the name slot ("allergy_intolerance
    /// 2024-01-01 allergy_intolerance Peanut") and the model on the node read a
    /// worse line than the model in the browser for the same event.
    ///
    /// This drives the real browser entry point — `svastha_wasm::rank_context`,
    /// with the candidate JSON shape `ask.ts` sends — and requires the rendered
    /// lines to be byte-identical.
    ///
    /// The `name` here is a fixture, not a claim: what proves the *browser*
    /// resolves this event to "Peanut" is `rank-boundary.test.ts`'s
    /// "renders an allergy exactly as the node renders it", which builds the
    /// candidate through the real `buildCandidates`/`resolveName` and asserts the
    /// same line literal. The two tests are pinned to each other by that string.
    #[test]
    fn an_allergy_renders_identically_on_the_node_and_in_the_browser() {
        let o = owner();
        let peanut = Code {
            system: "http://snomed.info/sct".into(),
            code: "256349002".into(),
            display: Some("Peanut".into()),
        };
        let e = o.sign_event(Event::new(
            EventKind::AllergyIntolerance,
            None,
            Some("2024-01-01".into()),
            Some(EventValue::Coded(peanut)),
            Provenance {
                source: "import".into(),
                source_doc: None,
            },
        ));
        let idx = idx(&o, std::slice::from_ref(&e));

        let node = retrieve(&idx, &AnswerScope::default(), "peanut allergy", 10);
        assert_eq!(node.len(), 1);

        let browser_input = serde_json::to_string(&json!([{
            "event": e.event,
            "name": "Peanut",
            "status": "active",
        }]))
        .unwrap();
        let ranked: serde_json::Value = serde_json::from_str(
            &svastha_wasm::rank_context(&browser_input, "peanut allergy", 10).unwrap(),
        )
        .unwrap();
        let browser: Vec<ContextItem> = serde_json::from_value(ranked["items"].clone()).unwrap();
        assert_eq!(browser.len(), 1);
        assert_eq!(ranked["unreadable"], 0);

        assert_eq!(node[0].text, browser[0].text, "one line for both clients");
        assert_eq!(node[0].text, "allergy_intolerance 2024-01-01 Peanut");
    }

    /// A coded app-local observation — `urn:svastha:codes` is where cycle and
    /// mind entries live (see `svastha_retrieval::sensitive_category`).
    fn app_local(o: &Identity, code: &str, display: &str, date: &str) -> SignedEvent {
        o.sign_event(Event::new(
            EventKind::Observation,
            Some(Code {
                system: "urn:svastha:codes".into(),
                code: code.into(),
                display: Some(display.into()),
            }),
            Some(date.into()),
            None,
            Provenance {
                source: "self".into(),
                source_doc: None,
            },
        ))
    }

    #[test]
    fn sensitive_entries_are_out_of_retrieval_by_default() {
        let o = owner();
        let cycle = app_local(&o, "menstrual-flow", "Menstrual flow", "2026-01-05");
        let mind = app_local(&o, "mood", "Mood", "2026-01-06");
        let vital = med(&o, "197361", "flow meter lisinopril mood", "2026-01-07");
        let idx = idx(&o, &[cycle, mind, vital.clone()]);

        let hits = retrieve(&idx, &AnswerScope::default(), "flow and mood", 10);
        assert_eq!(
            hits.iter().map(|h| &h.event_id).collect::<Vec<_>>(),
            vec![&vital.event.id.to_hex()],
            "cycle and mind never reach the ranker until the owner opts them in"
        );
    }

    #[test]
    fn a_question_only_excluded_entries_answer_retrieves_nothing() {
        // The honest empty result chat.rs turns into "your record doesn't say",
        // rather than a guess assembled without the entries that would have said.
        let o = owner();
        let idx = idx(
            &o,
            &[app_local(
                &o,
                "menstrual-flow",
                "Menstrual flow",
                "2026-01-05",
            )],
        );
        assert!(retrieve(&idx, &AnswerScope::default(), "menstrual flow", 10).is_empty());
    }

    #[test]
    fn opting_a_category_in_admits_only_that_one() {
        let o = owner();
        let cycle = app_local(&o, "menstrual-flow", "Menstrual flow", "2026-01-05");
        let mind = app_local(&o, "mood", "Mood flow", "2026-01-06");
        let idx = idx(&o, &[cycle.clone(), mind]);

        let scope = AnswerScope::new([SensitiveCategory::Cycle]);
        let hits = retrieve(&idx, &scope, "flow", 10);
        assert_eq!(
            hits.iter().map(|h| &h.event_id).collect::<Vec<_>>(),
            vec![&cycle.event.id.to_hex()],
            "cycle in, mind still out"
        );
    }

    #[test]
    fn respects_the_item_cap() {
        let o = owner();
        let events: Vec<_> = (0..20)
            .map(|i| note(&o, &format!("headache episode {i}"), "2024-01-01"))
            .collect();
        let idx = idx(&o, &events);
        assert_eq!(
            retrieve(&idx, &AnswerScope::default(), "headache", 5).len(),
            5,
            "capped"
        );
    }
}
