//! Which of an owner's entries an answer is allowed to draw from.
//!
//! Retrieval ranks over a whole vault, so without a gate here a question about
//! sleep can pull a period log or a mood note into the prompt and hand it to an
//! inference endpoint — with no separate consent, and no way for the owner to
//! know it happened. The categories the owner already treats as opt-in for a
//! doctor share (`CATEGORY_META`'s `sensitive` flag in `web/src/lib/category.ts`
//! — cycle and mind) are therefore **excluded from retrieval by default**, on the
//! device and on the node alike, and included only where the owner has said so.
//!
//! ## Why the classification lives here
//!
//! The web has been the single classification authority (`category.ts`), which is
//! fine while only the browser filters. The node filters too now, so the rule has
//! to exist in Rust as well — and it lives in this crate rather than in the node
//! so the browser can reach the same code through WASM and a parity test can
//! assert the two exclude the identical set (see `answer_scope_exclusions` in
//! `crates/wasm`). Only the **sensitive** half of the taxonomy is mirrored: the
//! rest of `categorize` decides colours and chips, which no Rust caller needs.
//!
//! ## Additive, and conservative when it cannot tell
//!
//! A category name this build does not know is not silently dropped from an
//! opt-in — the caller ([`crate::scope::SensitiveCategory::parse`] returning
//! `None`) reports it rather than acting on a guess, so an owner never believes
//! they opted in to something that was quietly ignored.

use std::collections::BTreeSet;

use serde::{Deserialize, Serialize};
use svastha_core::event::{Event, EventKind};

/// The app-local code system for concepts with no LOINC/SNOMED equivalent worth
/// forcing. Mirrors `SVASTHA` in `web/src/lib/codes.ts`; cycle and mind share it,
/// which is why [`CYCLE_CODES`] is needed to split them.
const SVASTHA_SYSTEM: &str = "urn:svastha:codes";

/// The `urn:svastha:codes` codes that belong to cycle tracking rather than
/// mindfulness. Mirrors `CYCLE_CODES` in `web/src/lib/codes.ts`; every other code
/// in that system is a mind entry, which is what makes a new mood-ish code
/// sensitive the moment it exists rather than the moment someone remembers to
/// list it here.
const CYCLE_CODES: [&str; 4] = [
    "cycle-start",
    "cycle-end",
    "menstrual-flow",
    "menstrual-clots",
];

/// A category the owner opts into per-category before an answer may read it.
/// The serde `snake_case` form is the wire name an `admin_cmd`'s
/// `set_answer_scope { include }` carries and the same string the web's
/// `Category` union uses.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SensitiveCategory {
    Cycle,
    Mind,
}

impl SensitiveCategory {
    /// Every sensitive category, in the web's `CATEGORIES` display order.
    pub const ALL: [SensitiveCategory; 2] = [SensitiveCategory::Cycle, SensitiveCategory::Mind];

    /// The stable wire name (matches the serde form and the web's `Category`).
    pub fn wire_name(self) -> &'static str {
        match self {
            SensitiveCategory::Cycle => "cycle",
            SensitiveCategory::Mind => "mind",
        }
    }

    /// The owner-facing label (matches `CATEGORY_META`'s `label`).
    pub fn label(self) -> &'static str {
        match self {
            SensitiveCategory::Cycle => "Cycle",
            SensitiveCategory::Mind => "Mind",
        }
    }

    /// Parse a wire name. `None` for anything this build does not know — the
    /// caller answers honestly rather than dropping it silently.
    pub fn parse(name: &str) -> Option<Self> {
        SensitiveCategory::ALL
            .into_iter()
            .find(|c| c.wire_name() == name)
    }
}

/// The sensitive category `event` falls in, or `None` when it is an ordinary
/// entry retrieval may always read.
///
/// Mirrors the sensitive branch of the web's `categorize`: only a coded
/// `observation` in the app-local system is cycle or mind, split by
/// [`CYCLE_CODES`]. Everything else — vitals, symptoms, meds, food, exercise,
/// notes, clinical — is ordinary. The event's own `code` is what classifies it
/// (never `value.coded`), exactly as in `category.ts`.
pub fn sensitive_category(event: &Event) -> Option<SensitiveCategory> {
    if event.kind != EventKind::Observation {
        return None;
    }
    let code = event.code.as_ref()?;
    if code.system != SVASTHA_SYSTEM {
        return None;
    }
    Some(if CYCLE_CODES.contains(&code.code.as_str()) {
        SensitiveCategory::Cycle
    } else {
        SensitiveCategory::Mind
    })
}

/// The sensitive categories an answer may draw from. Default is **none** — a
/// question is answered from the ordinary record until the owner turns a
/// category on, and a node that has never heard from an owner is in exactly that
/// state.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct AnswerScope {
    include: BTreeSet<SensitiveCategory>,
}

impl AnswerScope {
    /// A scope including exactly `include`.
    pub fn new(include: impl IntoIterator<Item = SensitiveCategory>) -> Self {
        Self {
            include: include.into_iter().collect(),
        }
    }

    /// Whether retrieval may consider `event`. Ordinary entries always pass; a
    /// sensitive one passes only when its category was opted in.
    pub fn allows(&self, event: &Event) -> bool {
        match sensitive_category(event) {
            None => true,
            Some(category) => self.include.contains(&category),
        }
    }

    /// The opted-in categories, ascending.
    pub fn included(&self) -> impl Iterator<Item = SensitiveCategory> + '_ {
        self.include.iter().copied()
    }

    pub fn is_empty(&self) -> bool {
        self.include.is_empty()
    }

    /// An owner-facing description of what an answer may read — the text an
    /// `admin_reply` carries back so the owner can check the node agrees with
    /// the switches in the app.
    pub fn describe(&self) -> String {
        if self.include.is_empty() {
            return "no opt-in entries; answers read your ordinary record only".to_string();
        }
        let names: Vec<&str> = self.included().map(|c| c.label()).collect();
        format!(
            "answers may also read {} entries; every other opt-in category stays out",
            names.join(" and ")
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use svastha_core::event::{Code, EventValue, Provenance};

    fn observation(system: &str, code: &str) -> Event {
        Event::new(
            EventKind::Observation,
            Some(Code {
                system: system.into(),
                code: code.into(),
                display: None,
            }),
            Some("2026-01-02".into()),
            Some(EventValue::Text("x".into())),
            Provenance {
                source: "self".into(),
                source_doc: None,
            },
        )
    }

    #[test]
    fn cycle_codes_are_cycle_and_every_other_app_local_code_is_mind() {
        for code in CYCLE_CODES {
            assert_eq!(
                sensitive_category(&observation(SVASTHA_SYSTEM, code)),
                Some(SensitiveCategory::Cycle),
                "{code}"
            );
        }
        for code in ["mood", "mood-note", "gratitude", "some-future-mood-code"] {
            assert_eq!(
                sensitive_category(&observation(SVASTHA_SYSTEM, code)),
                Some(SensitiveCategory::Mind),
                "{code}"
            );
        }
    }

    #[test]
    fn ordinary_entries_are_not_sensitive() {
        assert_eq!(
            sensitive_category(&observation("http://loinc.org", "8867-4")),
            None,
            "a vital is ordinary"
        );
        assert_eq!(
            sensitive_category(&observation("http://snomed.info/sct", "25064002")),
            None,
            "a coded symptom is ordinary"
        );
        let note = Event::new(
            EventKind::Document,
            None,
            None,
            Some(EventValue::Text("a note".into())),
            Provenance {
                source: "self".into(),
                source_doc: None,
            },
        );
        assert_eq!(sensitive_category(&note), None);
    }

    #[test]
    fn a_non_observation_in_the_app_local_system_is_not_sensitive() {
        // `categorize` reaches the cycle/mind split only through `observation`;
        // a medication statement is a med whatever system its code names.
        let med = Event::new(
            EventKind::MedicationStatement,
            Some(Code {
                system: SVASTHA_SYSTEM.into(),
                code: "mood".into(),
                display: None,
            }),
            None,
            None,
            Provenance {
                source: "self".into(),
                source_doc: None,
            },
        );
        assert_eq!(sensitive_category(&med), None);
    }

    #[test]
    fn the_default_scope_excludes_every_sensitive_category() {
        let scope = AnswerScope::default();
        assert!(scope.is_empty());
        assert!(!scope.allows(&observation(SVASTHA_SYSTEM, "cycle-start")));
        assert!(!scope.allows(&observation(SVASTHA_SYSTEM, "mood")));
        assert!(scope.allows(&observation("http://loinc.org", "8867-4")));
    }

    #[test]
    fn an_opt_in_admits_only_that_category() {
        let scope = AnswerScope::new([SensitiveCategory::Cycle]);
        assert!(scope.allows(&observation(SVASTHA_SYSTEM, "cycle-start")));
        assert!(
            !scope.allows(&observation(SVASTHA_SYSTEM, "mood")),
            "opting cycle in must not sweep mind in with it"
        );
    }

    #[test]
    fn parse_rejects_an_unknown_name() {
        assert_eq!(
            SensitiveCategory::parse("cycle"),
            Some(SensitiveCategory::Cycle)
        );
        assert_eq!(
            SensitiveCategory::parse("mind"),
            Some(SensitiveCategory::Mind)
        );
        assert_eq!(SensitiveCategory::parse("vital"), None);
        assert_eq!(SensitiveCategory::parse("Cycle"), None);
    }

    #[test]
    fn describe_names_what_an_answer_may_read() {
        assert!(AnswerScope::default()
            .describe()
            .contains("ordinary record only"));
        let both = AnswerScope::new(SensitiveCategory::ALL);
        let detail = both.describe();
        assert!(detail.contains("Cycle") && detail.contains("Mind"));
    }
}
