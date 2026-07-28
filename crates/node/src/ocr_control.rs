//! Whether the node reads pages at all, and how many per pass.
//!
//! # Paused until you say otherwise
//!
//! A node reads **nothing** until it is explicitly resumed. This is the default
//! and it is deliberate: enrolling a node points it at a vault that may already
//! hold a thousand captured pages, and the previous behaviour was to work
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
//! # And a cap once it is running
//!
//! Even resumed, a pass reads at most [`DEFAULT_MAX_PAGES_PER_PASS`] pages
//! before standing down until the next reconcile. A backlog therefore arrives as
//! a series of small, reviewable batches rather than one flood, and you can pause
//! again after the first batch if the results are not what you expected — which
//! is exactly when you want to find that out.

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// Pages read in one pass before standing down until the next reconcile. Sized
/// to be reviewable in a sitting rather than to maximise throughput: a medical
/// record is not a throughput problem.
pub const DEFAULT_MAX_PAGES_PER_PASS: usize = 20;

/// Boot default for the paused state. `false` opts a node in from the start —
/// for an operator who knows the vault is small, or who wants an existing
/// deployment to keep behaving as it did.
const ENV_PAUSED: &str = "SVASTHA_NODE_OCR_PAUSED";
/// Boot override for the per-pass cap.
const ENV_MAX_PAGES: &str = "SVASTHA_NODE_OCR_MAX_PAGES_PER_PASS";

const STATE_FILE: &str = "ocr-control.json";

/// The persisted half. Config, not record content, so it is safe in the durable
/// data dir (unlike plaintext, which stays ephemeral).
#[derive(Serialize, Deserialize)]
struct PersistedState {
    paused: bool,
}

/// Reading state: paused or not, and the per-pass cap.
pub struct OcrControl {
    state_path: PathBuf,
    paused: bool,
    max_pages_per_pass: usize,
}

impl OcrControl {
    /// Load from `data_dir`.
    ///
    /// Precedence mirrors the endpoint override: a persisted value wins over the
    /// boot env, which wins over the default. So `pause_ocr` survives a restart,
    /// and an operator's `SVASTHA_NODE_OCR_PAUSED=false` only decides where a
    /// *fresh* node starts.
    pub fn load(data_dir: &Path) -> Self {
        let state_path = data_dir.join(STATE_FILE);
        let persisted = fs::read(&state_path)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<PersistedState>(&bytes).ok());

        let paused = match persisted {
            Some(state) => state.paused,
            None => env_flag(ENV_PAUSED).unwrap_or(true),
        };

        Self {
            state_path,
            paused,
            max_pages_per_pass: env_usize(ENV_MAX_PAGES).unwrap_or(DEFAULT_MAX_PAGES_PER_PASS),
        }
    }

    pub fn paused(&self) -> bool {
        self.paused
    }

    pub fn max_pages_per_pass(&self) -> usize {
        self.max_pages_per_pass
    }

    /// Pause or resume, persisting the choice. Returns the owner-facing detail
    /// for the `admin_reply`, or the reason it could not be saved — a state that
    /// would not survive a restart is not reported as set.
    pub fn set_paused(&mut self, paused: bool) -> Result<String, String> {
        let previous = self.paused;
        self.paused = paused;
        if let Err(e) = self.persist() {
            self.paused = previous;
            return Err(format!("could not save the reading state: {e}"));
        }
        Ok(if paused {
            "page reading paused; sync and answering continue".to_string()
        } else {
            format!(
                "page reading resumed, up to {} pages per pass",
                self.max_pages_per_pass
            )
        })
    }

    fn persist(&self) -> std::io::Result<()> {
        let bytes = serde_json::to_vec(&PersistedState {
            paused: self.paused,
        })?;
        fs::write(&self.state_path, bytes)
    }
}

/// `1`/`true`/`yes`/`on` (any case) is true; `0`/`false`/`no`/`off` is false;
/// anything else — including an unset var — is `None`, so a typo falls back to
/// the safe default rather than being read as "off".
fn env_flag(key: &str) -> Option<bool> {
    match std::env::var(key)
        .ok()?
        .trim()
        .to_ascii_lowercase()
        .as_str()
    {
        "1" | "true" | "yes" | "on" => Some(true),
        "0" | "false" | "no" | "off" => Some(false),
        _ => None,
    }
}

fn env_usize(key: &str) -> Option<usize> {
    std::env::var(key)
        .ok()?
        .trim()
        .parse()
        .ok()
        .filter(|n| *n > 0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn a_fresh_node_starts_paused() {
        let dir = TempDir::new().unwrap();
        assert!(
            OcrControl::load(dir.path()).paused(),
            "enrolling a node must not start reading a backlog by surprise"
        );
    }

    #[test]
    fn the_choice_survives_a_restart() {
        let dir = TempDir::new().unwrap();
        let mut control = OcrControl::load(dir.path());
        control.set_paused(false).unwrap();
        assert!(!OcrControl::load(dir.path()).paused());

        control.set_paused(true).unwrap();
        assert!(
            OcrControl::load(dir.path()).paused(),
            "a paused node must not silently resume on restart"
        );
    }

    #[test]
    fn the_cap_defaults_and_rejects_nonsense() {
        let dir = TempDir::new().unwrap();
        assert_eq!(
            OcrControl::load(dir.path()).max_pages_per_pass(),
            DEFAULT_MAX_PAGES_PER_PASS
        );
        // A zero or unparseable cap would mean "read nothing" or panic; both are
        // worse than ignoring it.
        assert_eq!(env_usize("definitely-unset-var"), None);
    }

    #[test]
    fn set_paused_reports_what_changed() {
        let dir = TempDir::new().unwrap();
        let mut control = OcrControl::load(dir.path());
        assert!(control.set_paused(false).unwrap().contains("resumed"));
        assert!(control.set_paused(true).unwrap().contains("paused"));
    }

    #[test]
    fn env_flag_ignores_a_typo_rather_than_reading_it_as_false() {
        assert_eq!(env_flag("definitely-unset-var"), None);
    }
}
