//! A small in-memory ring buffer of the node's own recent log lines, so the
//! `log_tail` admin command (design §9) can answer without any inbound port or a
//! log file on disk.
//!
//! ## Why a log tail is content-free
//!
//! The node holds plaintext, but its logs never do — **by construction**: every
//! `tracing` call in this crate carries only counts, ids, and short owner-key
//! prefixes, never a question, an answer, an extracted finding, or record content
//! (see the crate README and the per-module notes). So capturing the exact bytes
//! `tracing` emits and handing a tail of them back over the mailbox reveals
//! nothing the node would not already print to its own stderr — and nothing the
//! relay does not already route. That invariant is what makes this buffer safe;
//! it is not a place to log anything richer.
//!
//! The buffer tees `tracing`'s formatted output: the same lines still go to
//! stderr, and complete lines are also pushed here, bounded to the most recent
//! [`CAPACITY`].

use std::collections::VecDeque;
use std::io::{self, Write};
use std::sync::{Arc, Mutex};

use tracing_subscriber::fmt::MakeWriter;

/// How many recent log lines to retain. Bounded so the buffer is a fixed, tiny
/// cost regardless of uptime; a `log_tail` asks for at most this many.
pub const CAPACITY: usize = 500;

/// A cloneable handle to the shared ring buffer. Cheap to clone (an `Arc`); the
/// tracing writer and the admin handler each hold one.
#[derive(Clone, Default)]
pub struct LogBuffer {
    lines: Arc<Mutex<VecDeque<String>>>,
}

impl LogBuffer {
    pub fn new() -> Self {
        Self::default()
    }

    /// Append one complete log line, evicting the oldest past [`CAPACITY`].
    pub fn push(&self, line: String) {
        let mut guard = self.lines.lock().expect("log buffer mutex");
        if guard.len() == CAPACITY {
            guard.pop_front();
        }
        guard.push_back(line);
    }

    /// The most recent `n` lines, oldest-first. Clamped to what is retained.
    pub fn tail(&self, n: usize) -> Vec<String> {
        let guard = self.lines.lock().expect("log buffer mutex");
        let start = guard.len().saturating_sub(n);
        guard.iter().skip(start).cloned().collect()
    }
}

/// A [`MakeWriter`] that tees `tracing`'s formatted output to stderr and into a
/// [`LogBuffer`]. Install it with `tracing_subscriber::fmt().with_writer(...)`.
#[derive(Clone)]
pub struct LogTee {
    buffer: LogBuffer,
}

impl LogTee {
    pub fn new(buffer: LogBuffer) -> Self {
        Self { buffer }
    }
}

impl<'a> MakeWriter<'a> for LogTee {
    type Writer = LineCapture;
    fn make_writer(&'a self) -> Self::Writer {
        // `fmt` makes one writer per event and writes the whole formatted line
        // through it, so a per-writer accumulator captures exactly one event's
        // line(s), flushed on drop.
        LineCapture {
            buffer: self.buffer.clone(),
            pending: Vec::new(),
        }
    }
}

/// Accumulates one event's bytes, tees them to stderr immediately, and pushes the
/// complete line(s) into the buffer when dropped (end of the event's write).
pub struct LineCapture {
    buffer: LogBuffer,
    pending: Vec<u8>,
}

impl Write for LineCapture {
    fn write(&mut self, data: &[u8]) -> io::Result<usize> {
        // Real-time passthrough so stderr behaves exactly as before.
        let _ = io::stderr().write_all(data);
        self.pending.extend_from_slice(data);
        Ok(data.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        io::stderr().flush()
    }
}

impl Drop for LineCapture {
    fn drop(&mut self) {
        if self.pending.is_empty() {
            return;
        }
        let text = String::from_utf8_lossy(&self.pending);
        for line in text.split('\n') {
            let trimmed = line.trim_end_matches('\r').trim_end();
            if !trimmed.is_empty() {
                self.buffer.push(trimmed.to_string());
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tail_returns_the_most_recent_lines_oldest_first() {
        let buf = LogBuffer::new();
        for i in 0..5 {
            buf.push(format!("line {i}"));
        }
        assert_eq!(buf.tail(3), vec!["line 2", "line 3", "line 4"]);
        // Asking for more than exists clamps.
        assert_eq!(buf.tail(100).len(), 5);
    }

    #[test]
    fn buffer_is_bounded_to_capacity() {
        let buf = LogBuffer::new();
        for i in 0..(CAPACITY + 50) {
            buf.push(format!("l{i}"));
        }
        let all = buf.tail(CAPACITY + 100);
        assert_eq!(all.len(), CAPACITY, "oldest evicted past capacity");
        assert_eq!(all.first().unwrap(), "l50", "kept only the newest window");
    }

    #[test]
    fn line_capture_pushes_complete_lines_on_drop() {
        let buf = LogBuffer::new();
        let tee = LogTee::new(buf.clone());
        {
            let mut w = tee.make_writer();
            w.write_all(b"first event line\n").unwrap();
        }
        {
            let mut w = tee.make_writer();
            w.write_all(b"second event line\n").unwrap();
        }
        assert_eq!(buf.tail(10), vec!["first event line", "second event line"]);
    }
}
