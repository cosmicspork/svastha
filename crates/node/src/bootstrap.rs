//! The localhost bootstrap page — the node's **only** listener, and deliberately
//! tiny. It serves the node's identity code (as text and a QR) and a health
//! snapshot so an operator can grant the node during first setup. It is
//! **bootstrap-only**: operational admin (job status, inference config, log tail)
//! arrives over the mailbox as `admin_cmd` in a later PR, never here.
//!
//! It binds **loopback only** (enforced in [`crate::config`]) and answers just
//! `GET /` and `GET /health`. A hand-rolled HTTP/1.1 handler keeps the node a pure
//! outbound client with no web-server framework and no inbound attack surface
//! beyond two static, read-only routes.

use std::io::{BufRead, BufReader, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::{Arc, Mutex};

use anyhow::{Context, Result};
use svastha_core::CONTRACT_VERSION;

use crate::state::NodeState;

/// The static parts of the page (the node's own identity — public, not secret).
#[derive(Clone)]
pub struct BootstrapPage {
    pub identity_code: String,
    pub fingerprint: String,
    pub label: String,
    /// Inline SVG QR of the identity code, if rendering succeeded.
    pub qr_svg: Option<String>,
}

/// Bind `addr` and serve the bootstrap page until the process exits. Blocks — the
/// caller runs it on a dedicated thread. Per-connection handling is trivial and
/// synchronous; a slow client cannot stall anything but its own request.
pub fn serve(addr: &str, page: BootstrapPage, state: Arc<Mutex<NodeState>>) -> Result<()> {
    let listener =
        TcpListener::bind(addr).with_context(|| format!("bind bootstrap addr {addr}"))?;
    for stream in listener.incoming() {
        let Ok(stream) = stream else { continue };
        // One connection at a time is plenty for a bootstrap page; ignore a
        // per-connection error so a malformed request never takes the node down.
        let _ = handle(stream, &page, &state);
    }
    Ok(())
}

fn handle(mut stream: TcpStream, page: &BootstrapPage, state: &Mutex<NodeState>) -> Result<()> {
    let mut reader = BufReader::new(stream.try_clone().context("clone stream")?);
    let mut request_line = String::new();
    reader
        .read_line(&mut request_line)
        .context("read request line")?;
    let mut parts = request_line.split_whitespace();
    let method = parts.next().unwrap_or("");
    let path = parts.next().unwrap_or("");

    let response = match (method, path) {
        ("GET", "/") => html_response(&index_html(page)),
        ("GET", "/health") => json_response(&health_json(page, state)),
        ("GET", _) => not_found(),
        _ => method_not_allowed(),
    };
    stream
        .write_all(response.as_bytes())
        .context("write response")?;
    stream.flush().context("flush response")?;
    Ok(())
}

fn health_json(page: &BootstrapPage, state: &Mutex<NodeState>) -> String {
    // Count only — never an owner id or any vault content.
    let enrolled = state.lock().map(|s| s.enrolled_count()).unwrap_or(0);
    format!(
        r#"{{"status":"ok","contract_version":{CONTRACT_VERSION},"fingerprint":"{}","enrolled_owners":{enrolled}}}"#,
        page.fingerprint,
    )
}

fn index_html(page: &BootstrapPage) -> String {
    let code = html_escape(&page.identity_code);
    let label = html_escape(&page.label);
    let fingerprint = html_escape(&page.fingerprint);
    let qr = page.qr_svg.clone().unwrap_or_default();
    format!(
        "<!doctype html><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">\
<title>svastha node — bootstrap</title>\
<style>body{{font-family:system-ui,sans-serif;max-width:40rem;margin:3rem auto;padding:0 1rem;line-height:1.5}}\
code{{word-break:break-all;background:#f4f4f4;padding:.15rem .35rem;border-radius:4px}}\
.qr{{max-width:240px}}.muted{{color:#666;font-size:.9rem}}</style>\
<h1>svastha node</h1>\
<p class=\"muted\">Bootstrap page — identity and health only. Operational admin arrives over the mailbox, not here.</p>\
<h2>Grant this node</h2>\
<p>Scan or paste this identity code into your Svastha app, confirm the fingerprint, then grant and hand off your keys.</p>\
<div class=\"qr\">{qr}</div>\
<p><strong>Label:</strong> {label}</p>\
<p><strong>Fingerprint:</strong> <code>{fingerprint}</code></p>\
<p><strong>Identity code:</strong><br><code>{code}</code></p>\
<hr><p class=\"muted\">Health: <a href=\"/health\">/health</a></p>"
    )
}

fn html_response(body: &str) -> String {
    format!(
        "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    )
}

fn json_response(body: &str) -> String {
    format!(
        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    )
}

fn not_found() -> String {
    let body = "not found";
    format!(
        "HTTP/1.1 404 Not Found\r\nContent-Type: text/plain\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    )
}

fn method_not_allowed() -> String {
    let body = "method not allowed";
    format!(
        "HTTP/1.1 405 Method Not Allowed\r\nContent-Type: text/plain\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    )
}

fn html_escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn page() -> BootstrapPage {
        BootstrapPage {
            identity_code: "svastha1:aa:bb:<script>".to_string(),
            fingerprint: "aabbccdd".to_string(),
            label: "svastha-node".to_string(),
            qr_svg: None,
        }
    }

    #[test]
    fn index_escapes_the_code() {
        let html = index_html(&page());
        assert!(
            html.contains("&lt;script&gt;"),
            "must escape angle brackets"
        );
        assert!(!html.contains("<script>"));
    }

    #[test]
    fn health_reports_a_count_not_owners() {
        let state = Mutex::new(NodeState::new());
        let json = health_json(&page(), &state);
        assert!(json.contains("\"enrolled_owners\":0"));
        assert!(json.contains("\"status\":\"ok\""));
    }
}
