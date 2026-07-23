//! The relay's push channel: a payload-free "go pull" hint bus.
//!
//! Clients poll the pull path (blobs, mailbox) for correctness; this channel is
//! a pure optimization on top of it. A poke carries **no payload** — never a
//! blob id, count, owner, or any content — only which pull an interested client
//! might run. That keeps the push channel as zero-knowledge as the rest of the
//! relay: it reveals nothing the relay doesn't already route.
//!
//! It is also **lossy by design**. The pull path is the single source of truth,
//! so a dropped poke costs nothing — the client finds out on its next pull
//! regardless (on unlock, on a timer, on tab focus). There are no delivery
//! guarantees and no buffering of pokes for a disconnected client: a poke is
//! only ever delivered to a stream that is connected at the instant it fires.
//!
//! This is runtime state, not stored state: there is no filesystem variant,
//! because a poke is meaningless to a connection that no longer exists.

use std::collections::HashMap;
use std::sync::Mutex;

use tokio::sync::broadcast;

/// A single payload-free poke. The variant only selects which pull the client
/// runs; it names no content. The push channel may be lossy with zero
/// correctness impact, so this is advisory.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Poke {
    /// New or changed blobs in a vault the recipient can read — its own, or one
    /// it holds a grant on. "Check your blobs."
    Blobs,
    /// A new item was deposited in the recipient's mailbox. "Check your mailbox."
    Mailbox,
}

impl Poke {
    /// The SSE `event:` field name for this poke. A routing hint the client uses
    /// to pick which pull to run — deliberately not content.
    pub fn event_name(self) -> &'static str {
        match self {
            Poke::Blobs => "blobs",
            Poke::Mailbox => "mailbox",
        }
    }
}

/// How many pokes a slow SSE stream may fall behind before the broadcast channel
/// starts dropping the oldest for it. A lagging receiver surfaces the lag (the
/// stream emits a generic "pull everything" hint, see `routes::events`) rather
/// than blocking a write path — exactly the lossy-by-design contract above.
const POKE_BUFFER: usize = 16;

/// Fan-out of pokes to an identity's currently-open SSE streams. One broadcast
/// channel per identity that has (or recently had) a live stream; an absent key
/// means nobody is listening and poking it is a no-op.
#[derive(Default)]
pub struct PokeHub {
    channels: Mutex<HashMap<[u8; 32], broadcast::Sender<Poke>>>,
}

impl PokeHub {
    pub fn new() -> Self {
        Self::default()
    }

    /// Subscribe an identity's SSE stream to its pokes, registering a channel if
    /// this is the identity's first live stream. The returned receiver only sees
    /// pokes fired *after* this call — consistent with the no-buffered-history
    /// contract, and why the SSE handler subscribes before returning its
    /// response (so a poke racing the handshake is not lost between them).
    pub fn subscribe(&self, identity: &[u8; 32]) -> broadcast::Receiver<Poke> {
        let mut channels = self.channels.lock().unwrap();
        channels
            .entry(*identity)
            .or_insert_with(|| broadcast::channel(POKE_BUFFER).0)
            .subscribe()
    }

    /// Whether the identity currently holds at least one live SSE stream. Used by
    /// the Web Push transport to suppress a redundant push to a foregrounded
    /// client that already got the real-time poke here (see
    /// [`push::PushService::notify`](crate::push::PushService::notify)). A channel
    /// with zero receivers (every stream dropped, not yet reclaimed) counts as no
    /// live stream. Best-effort, like everything on this bus.
    pub fn has_live_stream(&self, identity: &[u8; 32]) -> bool {
        self.channels
            .lock()
            .unwrap()
            .get(identity)
            .is_some_and(|tx| tx.receiver_count() > 0)
    }

    /// Poke an identity's open streams, best-effort. A no-op if nobody is
    /// listening. Never blocks and never fails the caller: a write path pokes
    /// and moves on, because delivery is not required for correctness. When the
    /// last stream for an identity has disconnected, the now-idle channel is
    /// reclaimed here so the map cannot grow without bound.
    pub fn poke(&self, identity: &[u8; 32], poke: Poke) {
        let mut channels = self.channels.lock().unwrap();
        if let Some(tx) = channels.get(identity) {
            // `send` errors only when there are zero receivers (all streams
            // gone); lagging receivers still return Ok (they drop oldest).
            if tx.send(poke).is_err() {
                channels.remove(identity);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn id(b: u8) -> [u8; 32] {
        [b; 32]
    }

    #[tokio::test]
    async fn poke_reaches_a_live_subscriber() {
        let hub = PokeHub::new();
        let mut rx = hub.subscribe(&id(1));
        hub.poke(&id(1), Poke::Mailbox);
        assert_eq!(rx.recv().await.unwrap(), Poke::Mailbox);
    }

    #[test]
    fn poke_with_no_subscriber_is_a_noop() {
        let hub = PokeHub::new();
        // Nobody is listening: this must not panic or block.
        hub.poke(&id(1), Poke::Blobs);
    }

    #[tokio::test]
    async fn identities_are_isolated() {
        let hub = PokeHub::new();
        let mut rx1 = hub.subscribe(&id(1));
        let _rx2 = hub.subscribe(&id(2));
        hub.poke(&id(2), Poke::Blobs);
        // id(1)'s stream sees nothing from id(2)'s poke.
        assert!(rx1.try_recv().is_err());
    }

    #[tokio::test]
    async fn idle_channel_is_reclaimed_after_last_stream_drops() {
        let hub = PokeHub::new();
        let rx = hub.subscribe(&id(1));
        assert_eq!(hub.channels.lock().unwrap().len(), 1);
        drop(rx);
        // The next poke finds no receivers and reclaims the slot.
        hub.poke(&id(1), Poke::Blobs);
        assert!(hub.channels.lock().unwrap().is_empty());
    }
}
