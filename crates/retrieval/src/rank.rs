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
        .filter(|q| item_tokens.iter().any(|t| tokens_match(t, q)))
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

/// The question's temporal intent from a few unambiguous cues, matched as whole
/// words (a multi-word cue as a contiguous run of them).
///
/// Substring matching fired inside unrelated words — "pasta" read as "past",
/// "presented" as "present", "distilled" as "still" — and the mistake was
/// expensive rather than cosmetic: a misread cue multiplies every mismatched
/// candidate by 0.3 against every matched one, so "how much pasta did i eat"
/// demoted the active concepts 3.3x.
fn intent_of(question: &str) -> Intent {
    let words = words(question);
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
        "now",
        "right now",
        "taking",
        "still",
        "these days",
        "am i on",
        "present",
    ];
    if past.iter().any(|p| contains_phrase(&words, p)) {
        Intent::Past
    } else if current.iter().any(|c| contains_phrase(&words, c)) {
        Intent::Current
    } else {
        Intent::Neutral
    }
}

/// Whether the space-separated `phrase` appears in `words` as a contiguous run.
fn contains_phrase(words: &[String], phrase: &str) -> bool {
    let needle: Vec<&str> = phrase.split(' ').collect();
    words
        .windows(needle.len())
        .any(|w| w.iter().zip(&needle).all(|(word, want)| word == want))
}

/// The keyword tokens of `text`: [`words`] minus a small stopword set and
/// anything too short to carry meaning. Length is counted in **characters**, not
/// bytes, so a multi-byte word is not silently thrown away; a token carrying CJK
/// is kept at any length, since a single character is a whole term there (and a
/// segmented bigram is two).
///
/// Shared by the query and every item, so overlap is apples-to-apples.
fn tokenize(text: &str) -> Vec<String> {
    words(text)
        .into_iter()
        .filter(|w| w.chars().count() >= 3 || w.chars().any(is_cjk))
        .filter(|w| !is_stopword(w))
        .collect()
}

/// Split text into lowercased words on any non-alphanumeric character.
///
/// Unicode-aware, not ASCII: splitting on `is_ascii_alphanumeric` treated every
/// CJK character as a separator, so a CJK question tokenized to *nothing* and a
/// CJK-named vault answered "I couldn't find anything" to every question — a
/// silent can't-answer, the one failure this crate is built to avoid.
///
/// CJK runs are then segmented into character bigrams, because those scripts do
/// not space their words: without segmentation a whole Japanese sentence is one
/// token and can never overlap an item's name. The segmentation is script-based,
/// not dictionary-based, so it over-generates — a bigram can straddle a word
/// boundary and match loosely. That is the honest trade for a keyword ranker: it
/// is applied identically to the query and every item, so scoring stays
/// comparable, and loose recall beats no recall at all.
///
/// No diacritic folding: "Ibuprofène" matches "ibuprofène", not "Ibuprofene".
fn words(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    for run in text.split(|c: char| !c.is_alphanumeric()) {
        if !run.is_empty() {
            push_segments(&run.to_lowercase(), &mut out);
        }
    }
    out
}

/// Whether a query token and an item token count as the same term. Equality,
/// except that a **single-character CJK term** also matches a bigram containing
/// it.
///
/// That exception is what keeps bigram segmentation from hiding one-character
/// terms in both directions: a name of `癌` never appears in a longer question's
/// bigrams, and a question of `癌` never appears in a longer name's. The term is
/// genuinely present in both — only the window differs. Restricting the rule to
/// tokens that are a single character on their own (a whole CJK run of length
/// one, never a segmented bigram) keeps multi-character scoring exactly as it
/// was: two three-character names sharing one middle character still do not
/// match.
fn tokens_match(a: &str, b: &str) -> bool {
    a == b || (is_cjk_singleton(a) && b.contains(a)) || (is_cjk_singleton(b) && a.contains(b))
}

fn is_cjk_singleton(token: &str) -> bool {
    let mut chars = token.chars();
    matches!((chars.next(), chars.next()), (Some(c), None) if is_cjk(c))
}

/// Push one run's tokens: non-CJK stretches whole, CJK stretches as bigrams.
fn push_segments(run: &str, out: &mut Vec<String>) {
    let mut buf: Vec<char> = Vec::new();
    let mut cjk = false;
    for c in run.chars() {
        if is_cjk(c) != cjk {
            flush_segment(&buf, cjk, out);
            buf.clear();
            cjk = !cjk;
        }
        buf.push(c);
    }
    flush_segment(&buf, cjk, out);
}

fn flush_segment(buf: &[char], cjk: bool, out: &mut Vec<String>) {
    if buf.is_empty() {
        return;
    }
    if !cjk || buf.len() == 1 {
        out.push(buf.iter().collect());
        return;
    }
    for pair in buf.windows(2) {
        out.push(pair.iter().collect());
    }
}

/// The scripts that do not space their words (Han, kana, Hangul), where one
/// character can be a whole term and a run needs segmenting to be searchable.
fn is_cjk(c: char) -> bool {
    matches!(u32::from(c),
        0x1100..=0x11FF        // hangul jamo
        | 0x3040..=0x30FF      // hiragana, katakana
        | 0x3400..=0x4DBF      // CJK unified ideographs extension A
        | 0x4E00..=0x9FFF      // CJK unified ideographs
        | 0xAC00..=0xD7AF      // hangul syllables
        | 0xF900..=0xFAFF      // CJK compatibility ideographs
        | 0x20000..=0x2FA1F    // CJK unified ideographs extensions B onward
    )
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

    /// Two candidates that render to the same line score identically, so the only
    /// thing deciding their order is the tie-break. Pinned because "simplify the
    /// sort" is a tempting and silently non-deterministic refactor.
    #[test]
    fn an_exact_score_tie_orders_by_event_id() {
        let a = med("111", "2024-01-01T00:00:00Z");
        let b = med("222", "2024-01-01T00:00:00Z");
        let (first, second) = if a.id.to_hex() < b.id.to_hex() {
            (a.id.to_hex(), b.id.to_hex())
        } else {
            (b.id.to_hex(), a.id.to_hex())
        };

        let forward = vec![
            candidate(&a, "metformin", ConceptStatus::Active),
            candidate(&b, "metformin", ConceptStatus::Active),
        ];
        let out = rank(&forward, "metformin", 10);
        assert_eq!(out.len(), 2);
        assert_eq!(out[0].score, out[1].score, "the tie this rule exists for");
        assert_eq!(out[0].event_id, first);
        assert_eq!(out[1].event_id, second);

        // Same result whichever order the candidates arrived in.
        let reversed = vec![
            candidate(&b, "metformin", ConceptStatus::Active),
            candidate(&a, "metformin", ConceptStatus::Active),
        ];
        assert_eq!(rank(&reversed, "metformin", 10), out);
    }

    #[test]
    fn intent_cues_match_whole_words_only() {
        assert_eq!(intent_of("how much pasta did i eat"), Intent::Neutral);
        assert_eq!(
            intent_of("what was presented at the visit"),
            Intent::Neutral
        );
        assert_eq!(intent_of("distilled water"), Intent::Neutral);
        assert_eq!(intent_of("undercurrent symptoms"), Intent::Neutral);

        assert_eq!(intent_of("what did i take in the past"), Intent::Past);
        assert_eq!(intent_of("meds i used to take"), Intent::Past);
        assert_eq!(intent_of("history of asthma"), Intent::Past);
        assert_eq!(intent_of("what am i currently taking"), Intent::Current);
        assert_eq!(intent_of("am i on lisinopril"), Intent::Current);
        assert_eq!(intent_of("what do i take right now"), Intent::Current);
    }

    /// The cost of the substring match: "pasta" read as "past" and demoted every
    /// active concept by 3.3x against every inactive one.
    #[test]
    fn a_cue_inside_an_unrelated_word_does_not_re_rank() {
        let recent = event(
            EventKind::NutritionIntake,
            None,
            "2024-01-01T00:00:00Z",
            Some(EventValue::Text("pasta".into())),
        );
        let older = event(
            EventKind::NutritionIntake,
            None,
            "2023-01-01T00:00:00Z",
            Some(EventValue::Text("pasta".into())),
        );
        let candidates = vec![
            candidate(&recent, "pasta dinner", ConceptStatus::Active),
            candidate(&older, "pasta lunch", ConceptStatus::Inactive),
        ];

        let out = rank(&candidates, "how much pasta did i eat", 10);
        assert_eq!(
            out[0].event_id,
            recent.id.to_hex(),
            "no temporal cue, so nothing is demoted and recency decides"
        );

        let past = rank(&candidates, "how much pasta did i eat in the past", 10);
        assert_eq!(
            past[0].event_id,
            older.id.to_hex(),
            "the real cue still promotes the inactive concept"
        );
    }

    /// Splitting on `is_ascii_alphanumeric` dropped every CJK character as a
    /// separator, so a CJK query tokenized to nothing and the vault answered
    /// "I couldn't find anything" to every question.
    #[test]
    fn a_cjk_question_retrieves_a_cjk_named_event() {
        let a = med("111", "2024-01-01T00:00:00Z");
        let candidates = vec![candidate(&a, "高血圧", ConceptStatus::Active)];
        assert_eq!(rank(&candidates, "高血圧", 10).len(), 1, "the bare term");
        assert_eq!(
            rank(&candidates, "私の高血圧の薬は何ですか", 10).len(),
            1,
            "and embedded in an unspaced sentence"
        );
        assert!(
            rank(&candidates, "糖尿病について教えて", 10).is_empty(),
            "an unrelated CJK question still retrieves nothing"
        );
    }

    /// Bigram segmentation windows a CJK run two characters at a time, which on
    /// its own makes a one-character term unreachable in both directions: a name
    /// of `癌` never appears in a longer question's bigrams, and a question of
    /// `癌` never appears in a longer name's. The term is present either way —
    /// only the window differs — so a single-character CJK term matches a bigram
    /// containing it.
    #[test]
    fn a_single_character_cjk_term_matches_across_the_bigram_window() {
        let a = med("111", "2024-01-01T00:00:00Z");

        let one_char_name = vec![candidate(&a, "癌", ConceptStatus::Active)];
        assert_eq!(
            rank(&one_char_name, "我有癌吗", 10).len(),
            1,
            "a one-character name, asked for inside a longer question"
        );

        let longer_name = vec![candidate(&a, "肺癌", ConceptStatus::Active)];
        assert_eq!(
            rank(&longer_name, "癌", 10).len(),
            1,
            "a one-character question, against a longer name"
        );

        assert!(
            rank(&one_char_name, "我有糖尿病吗", 10).is_empty(),
            "still no match where the term is absent"
        );
    }

    /// The singleton rule is an addition, not a loosening: multi-character terms
    /// keep matching on whole bigrams only, so an unrelated CJK name does not
    /// start scoring off a shared character.
    #[test]
    fn multi_character_cjk_scoring_is_unchanged() {
        let a = med("111", "2024-01-01T00:00:00Z");
        let candidates = vec![candidate(&a, "低血糖", ConceptStatus::Active)];
        assert!(
            rank(&candidates, "高血圧の薬", 10).is_empty(),
            "sharing only the character 血 is not a match"
        );

        let same = vec![candidate(&a, "高血圧", ConceptStatus::Active)];
        assert_eq!(rank(&same, "私の高血圧の薬は何ですか", 10).len(), 1);
    }

    /// A name whose accents split it into fragments shorter than the minimum
    /// token length used to tokenize to nothing at all.
    #[test]
    fn an_accented_question_matches_an_accented_name() {
        let a = med("111", "2024-01-01T00:00:00Z");
        let candidates = vec![candidate(&a, "Maladie de Ménière", ConceptStatus::Active)];
        assert_eq!(rank(&candidates, "Ménière", 10).len(), 1);
        assert_eq!(rank(&candidates, "ménière vertigo", 10).len(), 1);
    }
}
