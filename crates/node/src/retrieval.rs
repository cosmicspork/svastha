//! Retrieval for cited Q&A (design §7). Given a question and **one owner's**
//! [`VaultIndex`], rank that vault's events and render the top matches into the
//! context text the model sees — each carrying the event content id that becomes
//! its citation.
//!
//! ## Tenancy isolation is structural, not disciplinary
//!
//! [`retrieve`] takes a single `&VaultIndex`. There is no code path by which a
//! question routed to owner A's index can read owner B's events — not because the
//! caller is careful, but because B's events live in a different `VaultIndex` this
//! function is never handed. A citation can only ever be an id that appears in the
//! ranked context built from the one index passed in.
//!
//! ## Honest, personal-scale retrieval
//!
//! No embeddings, no vector store — the vaults are personal-scale, so keyword
//! overlap plus light recency and kind/intent signals is enough and keeps the
//! whole thing auditable. What matters for the trust story is not retrieval
//! sophistication but the **citation contract**: every rendered item carries the
//! exact event id it was drawn from, so the answer can be grounded back to real
//! records (see [`crate::chat`]).
//!
//! ## Curation-aware
//!
//! Rendering applies the owner's overlay: the `name:` display override becomes the
//! item's name, and the `status:` current-vs-past distinction is both shown to the
//! model (`[current]`/`[past]`) and used to re-rank — a "what am I *currently*
//! taking" question demotes resolved/inactive concepts, a "what did I *used to*..."
//! question demotes active ones. A resolved condition is history, not present
//! tense, and the ranking reflects that.

use crate::index::{ConceptStatus, VaultIndex};
use svastha_core::event::{Event, EventKind, EventValue, SignedEvent};

/// One retrieved, rendered context item. `event_id` is the citation the answer
/// carries; `text` is what the model reads.
#[derive(Clone, Debug, PartialEq)]
pub struct ContextItem {
    /// The event content id (hex) — the citation.
    pub event_id: String,
    /// The curation-aware rendering the model sees as context.
    pub text: String,
    /// The relevance score (higher is better); exposed for tests/logging.
    pub score: f32,
}

/// What the question implies about time — used to re-rank current vs past.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Intent {
    /// "currently", "now", "taking", "on" — prefer active/current concepts.
    Current,
    /// "past", "previous", "used to", "history of" — prefer inactive/resolved.
    Past,
    /// No temporal cue — status does not re-rank.
    Neutral,
}

/// Rank an owner's vault against `question` and return up to `max_items` rendered
/// context items, highest score first. Only events with at least one keyword
/// overlap are returned, so an unanswerable question yields an **empty** result —
/// which [`crate::chat`] turns into an honest "couldn't answer", never uncited
/// prose over an irrelevant dump of the record.
pub fn retrieve(index: &VaultIndex, question: &str, max_items: usize) -> Vec<ContextItem> {
    let query = tokenize(question);
    if query.is_empty() {
        return Vec::new();
    }
    let intent = intent_of(question);

    let mut scored: Vec<ContextItem> = index
        .events()
        .filter_map(|signed| score_event(index, signed, &query, intent))
        .collect();

    // Highest score first; ties break toward the more recent event, then by id
    // for a stable, deterministic order regardless of index iteration.
    scored.sort_by(|a, b| {
        b.score
            .partial_cmp(&a.score)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| a.event_id.cmp(&b.event_id))
    });
    scored.truncate(max_items);
    scored
}

/// Score and render one event, or `None` if it shares no keyword with the query
/// (not relevant — never a citation).
fn score_event(
    index: &VaultIndex,
    signed: &SignedEvent,
    query: &[String],
    intent: Intent,
) -> Option<ContextItem> {
    let event = &signed.event;
    let concept = VaultIndex::concept_key(event);
    let status = concept
        .as_ref()
        .map(|c| index.concept_status(c))
        .unwrap_or(ConceptStatus::Active);
    let name = render_name(index, event, concept.as_deref());
    let text = render_text(event, &name, status);

    // Keyword overlap: how many distinct query tokens appear in the item's tokens.
    let item_tokens = tokenize(&text);
    let overlap = query
        .iter()
        .filter(|q| item_tokens.iter().any(|t| t == *q))
        .count();
    if overlap == 0 {
        return None;
    }

    let mut score = overlap as f32 * 10.0;
    score += recency01(event.effective_at.as_deref()); // light recency signal
    score += kind_hint(query, &event.kind) * 3.0; // light kind/intent match

    // Curation-aware re-rank: honor the current-vs-past cue against the concept's
    // status. Demotion, not exclusion — a resolved item can still answer a
    // "current" question if nothing active matches, but it ranks below active ones.
    score *= status_multiplier(intent, status);

    Some(ContextItem {
        event_id: event.id.to_hex(),
        text,
        score,
    })
}

/// The name a concept renders under: the owner's `name:` override first, then the
/// event's own `code.display`, then `system code`, then — for an uncoded event —
/// its text value or bare kind. Mirrors the render-time name chain the web uses,
/// minus the offline dictionary (not present on the node).
fn render_name(index: &VaultIndex, event: &Event, concept: Option<&str>) -> String {
    if let Some(display) = concept.and_then(|c| index.concept_display(c)) {
        return display;
    }
    if let Some(code) = &event.code {
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

/// Render one event into the single context line the model sees: an optional
/// current/past tag (only where clinically meaningful), the kind, the date, the
/// name, and the value.
fn render_text(event: &Event, name: &str, status: ConceptStatus) -> String {
    let mut parts = Vec::new();
    if let Some(tag) = status_tag(&event.kind, status) {
        parts.push(format!("[{tag}]"));
    }
    parts.push(kind_wire(&event.kind));
    if let Some(date) = event.effective_at.as_deref() {
        parts.push(date_only(date));
    }
    parts.push(name.trim().to_string());
    if let Some(value) = render_value(event) {
        // Skip a value identical to the name (an uncoded note renders as its name).
        if value != name.trim() {
            parts.push(value);
        }
    }
    parts.retain(|p| !p.is_empty());
    parts.join(" ")
}

/// The value's short rendering, or `None` for a value that adds nothing textual
/// (an attachment's bytes are out of band).
fn render_value(event: &Event) -> Option<String> {
    match event.value.as_ref()? {
        EventValue::Quantity { value, unit } => Some(match unit {
            Some(u) => format!("{value} {}", u.code),
            None => value.clone(),
        }),
        EventValue::Coded(c) => Some(match &c.display {
            Some(d) if !d.trim().is_empty() => d.clone(),
            _ => format!("{} {}", c.system, c.code),
        }),
        EventValue::Text(t) => Some(t.clone()),
        // The captured document itself is not text; its caption rides as a sibling
        // text event, which is indexed and retrieved on its own.
        EventValue::Attachment { .. } => None,
    }
}

/// The current/past tag to show, only for the kinds where status is clinically
/// meaningful (a medication's current/past, a problem's active/resolved). Other
/// kinds (an observation, an immunization) carry no status tag.
fn status_tag(kind: &EventKind, status: ConceptStatus) -> Option<&'static str> {
    match (kind, status) {
        (EventKind::MedicationStatement, ConceptStatus::Active) => Some("current"),
        (EventKind::MedicationStatement, ConceptStatus::Inactive) => Some("past"),
        (EventKind::Condition, ConceptStatus::Active) => Some("active"),
        (EventKind::Condition, ConceptStatus::Inactive) => Some("resolved"),
        _ => None,
    }
}

/// The re-rank multiplier for a concept's status against the query intent. Boosts
/// a match, demotes a mismatch, leaves neutral queries untouched.
fn status_multiplier(intent: Intent, status: ConceptStatus) -> f32 {
    match (intent, status) {
        (Intent::Current, ConceptStatus::Active) => 1.3,
        (Intent::Current, ConceptStatus::Inactive) => 0.3,
        (Intent::Past, ConceptStatus::Inactive) => 1.3,
        (Intent::Past, ConceptStatus::Active) => 0.3,
        _ => 1.0,
    }
}

/// A light additive recency signal in `[0, 1]` from the event's year, so that
/// among similar keyword matches a newer record ranks higher. Crude by design —
/// it is a tiebreaker, not the primary signal.
fn recency01(effective_at: Option<&str>) -> f32 {
    let Some(year) = effective_at.and_then(parse_year) else {
        return 0.0;
    };
    (((year - 1990) as f32) / 60.0).clamp(0.0, 1.0)
}

/// `+1` when a query word names the event's kind (e.g. "medication" → a
/// `medication_statement`), else `0`. A cheap intent-to-kind nudge.
fn kind_hint(query: &[String], kind: &EventKind) -> f32 {
    let hits = |words: &[&str]| query.iter().any(|q| words.contains(&q.as_str()));
    let matched = match kind {
        EventKind::MedicationStatement => hits(&[
            "medication",
            "medications",
            "med",
            "meds",
            "drug",
            "drugs",
            "taking",
            "prescription",
        ]),
        EventKind::Condition => hits(&[
            "condition",
            "conditions",
            "problem",
            "problems",
            "diagnosis",
            "diagnoses",
        ]),
        EventKind::AllergyIntolerance => hits(&["allergy", "allergies", "allergic"]),
        EventKind::Immunization => hits(&[
            "immunization",
            "immunizations",
            "vaccine",
            "vaccines",
            "vaccination",
            "shot",
            "shots",
        ]),
        EventKind::Observation => hits(&[
            "observation",
            "observations",
            "vital",
            "vitals",
            "lab",
            "labs",
            "result",
            "results",
            "measurement",
        ]),
        EventKind::Procedure => hits(&["procedure", "procedures", "surgery", "operation"]),
        EventKind::Encounter => {
            hits(&["visit", "visits", "encounter", "encounters", "appointment"])
        }
        EventKind::NutritionIntake => hits(&["food", "meal", "meals", "ate", "diet", "nutrition"]),
        EventKind::Document => hits(&["note", "notes", "document", "report"]),
    };
    if matched {
        1.0
    } else {
        0.0
    }
}

/// The question's temporal intent from a few unambiguous cues.
fn intent_of(question: &str) -> Intent {
    let q = question.to_ascii_lowercase();
    let past = [
        "used to",
        "previous",
        "previously",
        "former",
        "history of",
        "no longer",
        "past",
        "stopped",
        "discontinued",
    ];
    let current = [
        "currently",
        "current",
        " now",
        "right now",
        "taking",
        "still",
        "these days",
        "am i on",
        "present",
    ];
    if past.iter().any(|p| q.contains(p)) {
        Intent::Past
    } else if current.iter().any(|c| q.contains(c)) {
        Intent::Current
    } else {
        Intent::Neutral
    }
}

/// Split text into lowercased alphanumeric tokens of length ≥ 3, dropping a small
/// stopword set. Deliberately simple and shared by the query and every item, so
/// overlap is apples-to-apples.
fn tokenize(text: &str) -> Vec<String> {
    text.split(|c: char| !c.is_ascii_alphanumeric())
        .filter(|w| w.len() >= 3)
        .map(|w| w.to_ascii_lowercase())
        .filter(|w| !is_stopword(w))
        .collect()
}

fn is_stopword(w: &str) -> bool {
    matches!(
        w,
        "the"
            | "and"
            | "for"
            | "are"
            | "was"
            | "were"
            | "what"
            | "which"
            | "who"
            | "how"
            | "does"
            | "did"
            | "have"
            | "has"
            | "had"
            | "you"
            | "your"
            | "any"
            | "all"
            | "with"
            | "from"
            | "this"
            | "that"
            | "there"
            | "here"
            | "when"
            | "get"
            | "got"
    )
}

/// The date portion of an ISO-8601 instant (before any `T`).
fn date_only(s: &str) -> String {
    s.split('T').next().unwrap_or(s).to_string()
}

/// Parse the leading 4-digit year of an ISO-8601 date, if present.
fn parse_year(s: &str) -> Option<i32> {
    let head: String = s.chars().take_while(|c| c.is_ascii_digit()).collect();
    if head.len() >= 4 {
        head[..4].parse().ok()
    } else {
        None
    }
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
    use svastha_core::event::{Code, Event, EventKind, EventValue, Provenance};
    use svastha_core::keys::Identity;

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
        let hits = retrieve(&idx, "am I on lisinopril?", 10);
        assert_eq!(hits.len(), 1, "only the lisinopril med matches");
        assert_eq!(hits[0].event_id, m.event.id.to_hex());
    }

    #[test]
    fn unrelated_question_returns_nothing() {
        let o = owner();
        let idx = idx(&o, &[med(&o, "197361", "Lisinopril", "2025-01-01")]);
        assert!(
            retrieve(&idx, "what vaccines have I had?", 10).is_empty(),
            "no keyword overlap → empty, so chat answers honestly"
        );
    }

    #[test]
    fn empty_or_stopword_only_question_returns_nothing() {
        let o = owner();
        let idx = idx(&o, &[med(&o, "197361", "Lisinopril", "2025-01-01")]);
        assert!(retrieve(&idx, "what is that?", 10).is_empty());
        assert!(retrieve(&idx, "", 10).is_empty());
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
        let stopped_concept = VaultIndex::concept_key(&stopped.event).unwrap();
        idx.ingest_curation(o.sign_curation(
            format!("status:{stopped_concept}"),
            json!({ "status": "inactive" }),
            1000,
        ));

        let hits = retrieve(&idx, "what metformin am I currently taking?", 10);
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
        let concept = VaultIndex::concept_key(&e.event).unwrap();
        idx.ingest_curation(o.sign_curation(
            format!("name:{concept}"),
            json!({ "display": "Lisinopril" }),
            1,
        ));
        let hits = retrieve(&idx, "lisinopril dose?", 10);
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
        let hits = retrieve(&idx, "headache", 10);
        assert_eq!(hits.len(), 2);
        assert_eq!(hits[0].event_id, new.event.id.to_hex(), "newer first");
    }

    #[test]
    fn respects_the_item_cap() {
        let o = owner();
        let events: Vec<_> = (0..20)
            .map(|i| note(&o, &format!("headache episode {i}"), "2024-01-01"))
            .collect();
        let idx = idx(&o, &events);
        assert_eq!(retrieve(&idx, "headache", 5).len(), 5, "capped");
    }
}
