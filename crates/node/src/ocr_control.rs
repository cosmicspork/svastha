//! Whether the node reads an owner's pages at all, and how many per pass.
//!
//! # Paused until you say otherwise
//!
//! A node reads **nothing** for an owner until that owner resumes. This is the
//! default and it is deliberate: enrolling a node points it at a vault that may
//! already hold a thousand captured pages, and the previous behaviour was to work
//! through every one of them and deposit a proposal for each. That is a
//! reasonable thing to want and a terrible thing to have happen *by surprise* —
//! an approval queue with a thousand entries is not a queue anyone reviews, and
//! the whole design rests on the owner actually reviewing.
//!
//! So enrolment is quiet. The node syncs, answers questions, and serves its
//! household; reading starts when you ask for it, and stops when you ask for
//! that. The state persists in the data dir, so a restart does not silently
//! resume a node you paused.
//!
//! # Your pause, your vault
//!
//! The choice is **per owner**, because the command that sets it is (see
//! [`crate::admin`]: you administer the node's processing of *your* vault, not
//! the node itself). A node serving two households reads for each independently:
//! pausing yours stops your pages and nobody else's, and no owner can stop — or
//! restart — reading they did not ask for. A node-wide switch would hand every
//! enrolled owner a lever over every other one, and leave the household on the
//! wrong end of it with a "paused" status they cannot undo.
//!
//! An owner who has made no choice takes the boot default
//! ([`OcrSettings::default_paused`]) — paused, unless the operator opted the
//! deployment in. Precedence, in one line: **the owner's persisted choice, else
//! the boot default, else paused.** The boot default applying to any owner
//! without a choice (not merely to a node with an empty state file) is what lets
//! an existing deployment upgrade into pause-by-default and still read, with no
//! UI to resume from yet.
//!
//! # And a cap once it is running
//!
//! Even resumed, a pass reads at most [`OcrSettings::max_pages_per_pass`] pages
//! before standing down until the next reconcile. A backlog therefore arrives as
//! a series of small, reviewable batches rather than one flood, and you can pause
//! again after the first batch if the results are not what you expected — which
//! is exactly when you want to find that out.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// Pages read in one pass before standing down until the next reconcile. Sized
/// to be reviewable in a sitting rather than to maximise throughput: a medical
/// record is not a throughput problem.
pub const DEFAULT_MAX_PAGES_PER_PASS: usize = 20;

const STATE_FILE: &str = "ocr-control.json";

/// The reading gate's boot settings. Resolved once at composition from the
/// environment ([`crate::config`]) and handed in here, rather than read from the
/// process env at load time — a value the constructor takes is a value a test can
/// pass, without `set_var` or a lock to serialize it.
#[derive(Clone, Copy, Debug)]
pub struct OcrSettings {
    /// Where an owner who has never sent `pause_ocr`/`resume_ocr` starts.
    pub default_paused: bool,
    /// Pages read per pass, per [`DEFAULT_MAX_PAGES_PER_PASS`].
    pub max_pages_per_pass: usize,
}

impl Default for OcrSettings {
    fn default() -> Self {
        Self {
            default_paused: true,
            max_pages_per_pass: DEFAULT_MAX_PAGES_PER_PASS,
        }
    }
}

/// The persisted half. Config, not record content, so it is safe in the durable
/// data dir (unlike plaintext, which stays ephemeral).
#[derive(Default, Serialize, Deserialize)]
struct PersistedState {
    /// Paused choice per owner Ed25519 hex. An owner absent here has made no
    /// choice and takes the boot default — including every owner of a node whose
    /// state file predates per-owner scoping, whose node-wide flag cannot be
    /// attributed to anyone and is therefore ignored (the boot default is the
    /// operator's remedy).
    #[serde(default)]
    owners: BTreeMap<String, bool>,
}

/// Reading state: who is paused, and the per-pass cap.
pub struct OcrControl {
    state_path: PathBuf,
    settings: OcrSettings,
    paused: BTreeMap<String, bool>,
}

impl OcrControl {
    /// Load the persisted per-owner choices from `data_dir`, over `settings`.
    pub fn load(data_dir: &Path, settings: OcrSettings) -> Self {
        let state_path = data_dir.join(STATE_FILE);
        let persisted = fs::read(&state_path)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<PersistedState>(&bytes).ok())
            .unwrap_or_default();

        Self {
            state_path,
            settings,
            paused: persisted.owners,
        }
    }

    /// Whether reading is on hold for `owner_hex`: their own persisted choice if
    /// they made one, else the boot default.
    pub fn paused(&self, owner_hex: &str) -> bool {
        self.paused
            .get(owner_hex)
            .copied()
            .unwrap_or(self.settings.default_paused)
    }

    pub fn max_pages_per_pass(&self) -> usize {
        self.settings.max_pages_per_pass
    }

    /// Pause or resume `owner_hex`, persisting the choice. Returns the
    /// owner-facing detail for the `admin_reply`, or the reason it could not be
    /// saved — a state that would not survive a restart is not reported as set.
    pub fn set_paused(&mut self, owner_hex: &str, paused: bool) -> Result<String, String> {
        let previous = self.paused.insert(owner_hex.to_string(), paused);
        if let Err(e) = self.persist() {
            match previous {
                Some(p) => self.paused.insert(owner_hex.to_string(), p),
                None => self.paused.remove(owner_hex),
            };
            return Err(format!("could not save the reading state: {e}"));
        }
        Ok(if paused {
            "page reading paused for your vault; anyone else this node serves is unaffected. \
             Sync and answering continue"
                .to_string()
        } else {
            format!(
                "page reading resumed for your vault, up to {} pages per pass; \
                 anyone else this node serves is unaffected",
                self.max_pages_per_pass()
            )
        })
    }

    fn persist(&self) -> std::io::Result<()> {
        let bytes = serde_json::to_vec(&PersistedState {
            owners: self.paused.clone(),
        })?;
        fs::write(&self.state_path, bytes)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    const A: &str = "aaaa";
    const B: &str = "bbbb";

    fn opted_in() -> OcrSettings {
        OcrSettings {
            default_paused: false,
            ..Default::default()
        }
    }

    #[test]
    fn an_owner_with_no_choice_starts_paused() {
        let dir = TempDir::new().unwrap();
        assert!(
            OcrControl::load(dir.path(), OcrSettings::default()).paused(A),
            "enrolling a node must not start reading a backlog by surprise"
        );
    }

    #[test]
    fn the_boot_default_applies_to_every_owner_without_a_choice() {
        // Not merely to a node with an empty state file: an existing deployment
        // upgrading into pause-by-default has no persisted choice for anyone,
        // and this env default is the operator's only way to keep it reading.
        let dir = TempDir::new().unwrap();
        let mut control = OcrControl::load(dir.path(), opted_in());
        control.set_paused(A, true).unwrap();

        let reloaded = OcrControl::load(dir.path(), opted_in());
        assert!(reloaded.paused(A), "A's own choice wins over the default");
        assert!(!reloaded.paused(B), "B never chose, so B takes the default");
    }

    #[test]
    fn a_pause_is_scoped_to_the_owner_who_sent_it() {
        let dir = TempDir::new().unwrap();
        let mut control = OcrControl::load(dir.path(), opted_in());
        control.set_paused(A, true).unwrap();
        assert!(control.paused(A));
        assert!(
            !control.paused(B),
            "one household must not be able to stop another's reading"
        );
    }

    #[test]
    fn each_owners_choice_survives_a_restart() {
        let dir = TempDir::new().unwrap();
        let mut control = OcrControl::load(dir.path(), OcrSettings::default());
        control.set_paused(A, false).unwrap();
        control.set_paused(B, true).unwrap();

        let reloaded = OcrControl::load(dir.path(), OcrSettings::default());
        assert!(!reloaded.paused(A), "A resumed and stays resumed");
        assert!(
            reloaded.paused(B),
            "a paused owner must not silently resume on restart"
        );
    }

    #[test]
    fn the_cap_comes_from_the_settings() {
        let dir = TempDir::new().unwrap();
        assert_eq!(
            OcrControl::load(dir.path(), OcrSettings::default()).max_pages_per_pass(),
            DEFAULT_MAX_PAGES_PER_PASS
        );
        let control = OcrControl::load(
            dir.path(),
            OcrSettings {
                max_pages_per_pass: 3,
                ..Default::default()
            },
        );
        assert_eq!(control.max_pages_per_pass(), 3);
    }

    #[test]
    fn set_paused_reports_what_changed_and_who_it_touched() {
        let dir = TempDir::new().unwrap();
        let mut control = OcrControl::load(dir.path(), OcrSettings::default());
        let resumed = control.set_paused(A, false).unwrap();
        assert!(resumed.contains("resumed"));
        let paused = control.set_paused(A, true).unwrap();
        assert!(paused.contains("paused"));
        // The scope has to be in the reply the owner actually reads: the app's
        // copy promises anyone else the node serves is unaffected.
        for detail in [&resumed, &paused] {
            assert!(detail.contains("your vault"), "names whose reading changed");
            assert!(detail.contains("unaffected"), "and whose did not");
        }
    }

    #[test]
    fn a_state_file_from_before_per_owner_scoping_loads_as_no_choices() {
        let dir = TempDir::new().unwrap();
        fs::write(dir.path().join(STATE_FILE), br#"{"paused":false}"#).unwrap();
        let control = OcrControl::load(dir.path(), OcrSettings::default());
        assert!(
            control.paused(A),
            "an unattributable flag is not A's choice"
        );
    }
}
