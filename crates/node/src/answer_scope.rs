//! Which of an owner's entries this node's answers may draw from.
//!
//! # Opt-in, not opt-out
//!
//! Cycle and mind entries are **out of every answer** until the owner turns that
//! category on. Retrieval ranks over a whole vault, so the alternative is that
//! asking "why have I been so tired?" quietly ships a period log or a mood note
//! to an inference endpoint — a disclosure the owner never made, about the part
//! of the record they are least likely to have meant to share. The rule doctor
//! shares already follow (`web/src/lib/doctorShare.ts`'s `filterEventsForScope`)
//! is the rule answering follows, so there is one thing to learn rather than two.
//!
//! The exclusion happens *before* ranking (see [`crate::retrieval`]): an entry
//! that is out of scope is never scored, never rendered into a prompt, and
//! therefore cannot shape an answer even indirectly.
//!
//! # Your choice, your vault
//!
//! Per owner, for the same reason pausing is (see [`crate::ocr_control`]): the
//! command that sets it is scoped to its sender, so a node serving two households
//! answers each within that household's own choice. There is no boot default and
//! no operator override — an opt-in to your own most private entries is not
//! something a deployment can make on your behalf, so an owner the node has never
//! heard from is simply excluded from both.
//!
//! # Honest about what it costs
//!
//! While a category is off, a question only those entries could answer gets the
//! ordinary can't-answer reply — the same one an empty retrieval always
//! produces. That is deliberate: a guess assembled without the entries that would
//! have answered it is worse than "your record doesn't say", because it reads
//! like an answer.

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use svastha_retrieval::{AnswerScope, SensitiveCategory};

const STATE_FILE: &str = "answer-scope.json";

/// The persisted half: opted-in category wire names per owner Ed25519 hex.
/// Config, not record content, so it is safe in the durable data dir. Names are
/// stored as strings so a future category round-trips through a node build that
/// predates it rather than being silently erased on rewrite.
#[derive(Default, Serialize, Deserialize)]
struct PersistedState {
    #[serde(default)]
    owners: BTreeMap<String, BTreeSet<String>>,
}

/// Per-owner answer scope, persisted so a restart cannot quietly re-include what
/// an owner opted out of.
pub struct AnswerScopeControl {
    state_path: PathBuf,
    owners: BTreeMap<String, BTreeSet<String>>,
}

impl AnswerScopeControl {
    /// Load the persisted per-owner choices from `data_dir`.
    pub fn load(data_dir: &Path) -> Self {
        let state_path = data_dir.join(STATE_FILE);
        let persisted = fs::read(&state_path)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<PersistedState>(&bytes).ok())
            .unwrap_or_default();
        Self {
            state_path,
            owners: persisted.owners,
        }
    }

    /// The scope answering runs under for `owner_hex`: their opted-in categories,
    /// or none at all when they have made no choice. A stored name this build
    /// does not know is ignored here (it cannot classify anything anyway) but is
    /// kept in the file — see [`PersistedState`].
    pub fn scope(&self, owner_hex: &str) -> AnswerScope {
        let Some(names) = self.owners.get(owner_hex) else {
            return AnswerScope::default();
        };
        AnswerScope::new(names.iter().filter_map(|n| SensitiveCategory::parse(n)))
    }

    /// Set `owner_hex`'s opt-ins to exactly `include` (the app sends switch
    /// positions, not a delta), persisting the choice. Returns the owner-facing
    /// detail for the `admin_reply`, or the reason it could not be applied.
    ///
    /// An unrecognized category name is rejected **whole**: nothing is changed
    /// and the reply names what was not understood. Quietly dropping it would
    /// leave the app showing a switch on that the node is not honoring, which is
    /// the one failure mode this feature cannot afford.
    pub fn set_scope(&mut self, owner_hex: &str, include: &[String]) -> Result<String, String> {
        let unknown: Vec<&str> = include
            .iter()
            .map(String::as_str)
            .filter(|n| SensitiveCategory::parse(n).is_none())
            .collect();
        if !unknown.is_empty() {
            return Err(format!(
                "this node does not know the opt-in categor{} {}; nothing was changed",
                if unknown.len() == 1 { "y" } else { "ies" },
                unknown.join(", ")
            ));
        }

        let next: BTreeSet<String> = include.iter().cloned().collect();
        let previous = self.owners.insert(owner_hex.to_string(), next);
        if let Err(e) = self.persist() {
            match previous {
                Some(p) => self.owners.insert(owner_hex.to_string(), p),
                None => self.owners.remove(owner_hex),
            };
            return Err(format!("could not save the answer scope: {e}"));
        }
        Ok(format!(
            "{} for your vault; anyone else this node serves is unaffected",
            self.scope(owner_hex).describe()
        ))
    }

    fn persist(&self) -> std::io::Result<()> {
        let bytes = serde_json::to_vec(&PersistedState {
            owners: self.owners.clone(),
        })?;
        fs::write(&self.state_path, bytes)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use svastha_core::event::{Code, Event, EventKind, EventValue, Provenance};
    use tempfile::TempDir;

    const A: &str = "aaaa";
    const B: &str = "bbbb";

    fn app_local(code: &str) -> Event {
        Event::new(
            EventKind::Observation,
            Some(Code {
                system: "urn:svastha:codes".into(),
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
    fn an_owner_with_no_choice_gets_no_sensitive_entries() {
        let dir = TempDir::new().unwrap();
        let control = AnswerScopeControl::load(dir.path());
        let scope = control.scope(A);
        assert!(!scope.allows(&app_local("cycle-start")));
        assert!(!scope.allows(&app_local("mood")));
    }

    #[test]
    fn an_opt_in_admits_only_the_named_category() {
        let dir = TempDir::new().unwrap();
        let mut control = AnswerScopeControl::load(dir.path());
        control.set_scope(A, &["cycle".to_string()]).unwrap();
        let scope = control.scope(A);
        assert!(scope.allows(&app_local("cycle-start")));
        assert!(!scope.allows(&app_local("mood")), "mind stays out");
    }

    #[test]
    fn a_scope_is_scoped_to_the_owner_who_sent_it() {
        let dir = TempDir::new().unwrap();
        let mut control = AnswerScopeControl::load(dir.path());
        control
            .set_scope(A, &["cycle".to_string(), "mind".to_string()])
            .unwrap();
        assert!(control.scope(A).allows(&app_local("mood")));
        assert!(
            !control.scope(B).allows(&app_local("mood")),
            "one household must not opt another's entries in"
        );
    }

    #[test]
    fn each_owners_choice_survives_a_restart() {
        let dir = TempDir::new().unwrap();
        let mut control = AnswerScopeControl::load(dir.path());
        control.set_scope(A, &["mind".to_string()]).unwrap();
        control.set_scope(B, &[]).unwrap();

        let reloaded = AnswerScopeControl::load(dir.path());
        assert!(reloaded.scope(A).allows(&app_local("mood")));
        assert!(
            !reloaded.scope(A).allows(&app_local("cycle-start")),
            "only what A opted in"
        );
        assert!(!reloaded.scope(B).allows(&app_local("mood")));
    }

    #[test]
    fn turning_a_category_back_off_takes_effect() {
        let dir = TempDir::new().unwrap();
        let mut control = AnswerScopeControl::load(dir.path());
        control.set_scope(A, &["cycle".to_string()]).unwrap();
        control.set_scope(A, &[]).unwrap();
        assert!(!control.scope(A).allows(&app_local("cycle-start")));
        // And the "off" is a real persisted choice, not an absence.
        assert!(!AnswerScopeControl::load(dir.path())
            .scope(A)
            .allows(&app_local("cycle-start")));
    }

    #[test]
    fn an_unknown_category_is_rejected_whole() {
        let dir = TempDir::new().unwrap();
        let mut control = AnswerScopeControl::load(dir.path());
        control.set_scope(A, &["cycle".to_string()]).unwrap();
        let err = control
            .set_scope(A, &["mind".to_string(), "dreams".to_string()])
            .unwrap_err();
        assert!(err.contains("dreams"), "names what it did not understand");
        assert!(
            control.scope(A).allows(&app_local("cycle-start")),
            "the previous choice is untouched"
        );
        assert!(
            !control.scope(A).allows(&app_local("mood")),
            "and the partially-understood command applied nothing"
        );
    }

    #[test]
    fn the_reply_detail_states_the_resulting_scope_and_its_reach() {
        let dir = TempDir::new().unwrap();
        let mut control = AnswerScopeControl::load(dir.path());
        let off = control.set_scope(A, &[]).unwrap();
        assert!(off.contains("ordinary record only"));
        let on = control
            .set_scope(A, &["cycle".to_string(), "mind".to_string()])
            .unwrap();
        assert!(on.contains("Cycle") && on.contains("Mind"));
        for detail in [&off, &on] {
            assert!(detail.contains("your vault"));
            assert!(detail.contains("unaffected"));
        }
    }

    #[test]
    fn an_unreadable_state_file_loads_as_no_choices() {
        let dir = TempDir::new().unwrap();
        fs::write(dir.path().join(STATE_FILE), b"not json").unwrap();
        assert!(!AnswerScopeControl::load(dir.path())
            .scope(A)
            .allows(&app_local("mood")));
    }
}
