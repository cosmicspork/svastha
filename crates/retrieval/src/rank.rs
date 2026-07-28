//! Scoring and rendering: keyword overlap with light recency, kind, and
//! temporal-intent signals, over candidates the caller has already resolved.

use svastha_core::event::{Event, EventKind, EventValue};

use crate::{Candidate, ConceptStatus, ContextItem};

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

/// Rank `candidates` against `question` and return up to `max_items` rendered
/// context items, highest score first. Only candidates with at least one keyword
/// overlap are returned, so an unanswerable question yields an **empty** result —
/// which the caller turns into an honest "couldn't answer", never uncited prose
/// over an irrelevant dump of the record.
pub fn rank(candidates: &[Candidate<'_>], question: &str, max_items: usize) -> Vec<ContextItem> {
    let query = tokenize(question);
    if query.is_empty() {
        return Vec::new();
    }
    let intent = intent_of(question);

    let mut scored: Vec<ContextItem> = candidates
        .iter()
        .filter_map(|candidate| score(candidate, &query, intent))
        .collect();

    // Highest score first; ties break by id for a stable, deterministic order
    // regardless of the order candidates arrived in.
    scored.sort_by(|a, b| {
        b.score
            .partial_cmp(&a.score)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| a.event_id.cmp(&b.event_id))
    });
    scored.truncate(max_items);
    scored
}

/// Score and render one candidate, or `None` if it shares no keyword with the
/// query (not relevant — never a citation).
fn score(candidate: &Candidate<'_>, query: &[String], intent: Intent) -> Option<ContextItem> {
    let event = candidate.event;
    let text = render_line(event, &candidate.name, candidate.status);

    let item_tokens = tokenize(&text);
    let overlap = query
        .iter()
        .filter(|q| item_tokens.iter().any(|t| t == *q))
        .count();
    if overlap == 0 {
        return None;
    }

    let mut score = overlap as f32 * 10.0;
    score += recency01(event.effective_at.as_deref());
    score += kind_hint(query, &event.kind) * 3.0;

    // Curation-aware re-rank: honor the current-vs-past cue against the concept's
    // status. Demotion, not exclusion — a resolved item can still answer a
    // "current" question if nothing active matches, but it ranks below active ones.
    score *= status_multiplier(intent, candidate.status);

    Some(ContextItem {
        event_id: event.id.to_hex(),
        text,
        score,
    })
}

/// Render one event into the single context line the model sees: an optional
/// current/past tag (only where clinically meaningful), the kind, the date, the
/// name, and the value.
pub fn render_line(event: &Event, name: &str, status: ConceptStatus) -> String {
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

/// An event kind's stable `snake_case` wire name via serde (the same source the
/// event schema and the concept key use).
fn kind_wire(kind: &EventKind) -> String {
    serde_json::to_value(kind)
        .ok()
        .and_then(|v| v.as_str().map(str::to_string))
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use svastha_core::event::{Code, Event, Provenance};

    fn event(
        kind: EventKind,
        code: Option<Code>,
        effective: &str,
        value: Option<EventValue>,
    ) -> Event {
        Event::new(
            kind,
            code,
            Some(effective.into()),
            value,
            Provenance {
                source: "test".into(),
                source_doc: None,
            },
        )
    }

    fn med(rxnorm: &str, effective: &str) -> Event {
        event(
            EventKind::MedicationStatement,
            Some(Code {
                system: "http://www.nlm.nih.gov/research/umls/rxnorm".into(),
                code: rxnorm.into(),
                display: None,
            }),
            effective,
            None,
        )
    }

    fn candidate<'a>(event: &'a Event, name: &str, status: ConceptStatus) -> Candidate<'a> {
        Candidate {
            event,
            name: name.into(),
            status,
        }
    }

    #[test]
    fn ranks_only_candidates_sharing_a_keyword() {
        let a = med("111", "2024-01-01T00:00:00Z");
        let b = med("222", "2024-01-01T00:00:00Z");
        let candidates = vec![
            candidate(&a, "metformin", ConceptStatus::Active),
            candidate(&b, "lisinopril", ConceptStatus::Active),
        ];
        let out = rank(&candidates, "metformin", 10);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].event_id, a.id.to_hex());
    }

    #[test]
    fn a_question_with_no_overlap_retrieves_nothing() {
        let a = med("111", "2024-01-01T00:00:00Z");
        let candidates = vec![candidate(&a, "metformin", ConceptStatus::Active)];
        assert!(rank(&candidates, "warfarin", 10).is_empty());
    }

    /// The caller's status resolution is what drives the current/past re-rank, so
    /// the same two events reorder purely on the status handed in.
    #[test]
    fn current_intent_demotes_an_inactive_candidate() {
        let active = med("111", "2020-01-01T00:00:00Z");
        let stopped = med("222", "2021-01-01T00:00:00Z");
        let candidates = vec![
            candidate(&active, "metformin tablet", ConceptStatus::Active),
            candidate(&stopped, "metformin syrup", ConceptStatus::Inactive),
        ];
        let out = rank(&candidates, "what metformin am i currently taking", 10);
        assert_eq!(out[0].event_id, active.id.to_hex());
        assert!(out[0].text.contains("[current]"));
        assert!(out[1].text.contains("[past]"));
    }

    #[test]
    fn max_items_truncates_after_ranking() {
        let a = med("111", "2024-01-01T00:00:00Z");
        let b = med("222", "2023-01-01T00:00:00Z");
        let candidates = vec![
            candidate(&a, "metformin one", ConceptStatus::Active),
            candidate(&b, "metformin two", ConceptStatus::Active),
        ];
        let out = rank(&candidates, "metformin", 1);
        assert_eq!(out.len(), 1);
        // Newer wins the recency tiebreak among equal keyword overlap.
        assert_eq!(out[0].event_id, a.id.to_hex());
    }

    #[test]
    fn a_status_tag_is_only_rendered_where_it_is_clinically_meaningful() {
        let obs = event(
            EventKind::Observation,
            Some(Code {
                system: "http://loinc.org".into(),
                code: "39156-5".into(),
                display: None,
            }),
            "2024-01-01T00:00:00Z",
            Some(EventValue::Quantity {
                value: "24.1".into(),
                unit: None,
            }),
        );
        let line = render_line(&obs, "Body mass index", ConceptStatus::Inactive);
        assert!(!line.contains("[past]"), "got: {line}");
        assert!(line.contains("Body mass index"));
        assert!(line.contains("24.1"));
    }

    #[test]
    fn an_empty_question_ranks_nothing() {
        let a = med("111", "2024-01-01T00:00:00Z");
        let candidates = vec![candidate(&a, "metformin", ConceptStatus::Active)];
        assert!(rank(&candidates, "  ", 10).is_empty());
    }
}
