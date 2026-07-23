//! The payload-free SSE poke channel (`GET /v0/events`). A poke names *which*
//! pull to run — never a blob id, count, owner, or content — so the channel stays
//! zero-knowledge and lossy: a missed poke costs nothing because the pull path is
//! the source of truth (see `spec/README.md`, "Push channel"). The node uses pokes
//! only to pull *sooner* than its fallback timer.

/// Which pull a poke asks the node to run. `Sync` is the catch-all the relay may
/// send to a client that fell behind: pull everything.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Poke {
    /// Something changed in a vault the node can read: re-pull blobs.
    Blobs,
    /// An item was deposited in the node's mailbox: re-check enrolment.
    Mailbox,
    /// Generic catch-up: pull mailbox and every vault.
    Sync,
}

impl Poke {
    /// Map an SSE `event:` field value to a poke. Unknown names map to the
    /// catch-all [`Poke::Sync`] (tolerated-unknown: a future event kind still
    /// triggers a reconciling pull rather than being dropped).
    pub fn from_event_name(name: &str) -> Poke {
        match name.trim() {
            "blobs" => Poke::Blobs,
            "mailbox" => Poke::Mailbox,
            _ => Poke::Sync,
        }
    }
}

/// Extract the poke from one SSE line, if it carries one. Only the `event:` field
/// matters — the single `data:` byte is deliberately non-informative, and a
/// heartbeat comment line (`:`) or blank line carries nothing. Returns `None` for
/// anything that is not an `event:` field.
pub fn poke_from_line(line: &str) -> Option<Poke> {
    let rest = line.strip_prefix("event:")?;
    Some(Poke::from_event_name(rest))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_known_event_names() {
        assert_eq!(poke_from_line("event: blobs"), Some(Poke::Blobs));
        assert_eq!(poke_from_line("event: mailbox"), Some(Poke::Mailbox));
        assert_eq!(poke_from_line("event:blobs"), Some(Poke::Blobs));
    }

    #[test]
    fn unknown_event_name_falls_back_to_sync() {
        assert_eq!(poke_from_line("event: future_kind"), Some(Poke::Sync));
        assert_eq!(poke_from_line("event: sync"), Some(Poke::Sync));
    }

    #[test]
    fn non_event_lines_carry_no_poke() {
        assert_eq!(poke_from_line("data: 1"), None);
        assert_eq!(poke_from_line(": heartbeat"), None);
        assert_eq!(poke_from_line(""), None);
    }
}
