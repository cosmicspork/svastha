//! End-to-end plumbing for the `accuracy` subcommand, against a mock endpoint.
//!
//! The unit tests in `accuracy::score` prove the scoring maths over canned
//! answers. What they cannot show is that a transcript actually reaches a model
//! in the shape the node sends, that the reply is parsed back out, and that the
//! score at the far end is computed over *that* — the seam where a harness
//! quietly measuring nothing would hide.
//!
//! So this stands up a real HTTP server on loopback, serves canned
//! chat-completions replies, and drives the whole path. No network, nothing
//! outside this process, and no model: the endpoint is a socket that returns a
//! fixed string, which is all that is needed to prove the wiring.

use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::mpsc;
use std::thread;

use svastha_devtool::accuracy::reader::Endpoint;
use svastha_devtool::accuracy::score::{score, Expected, Truth};

/// A one-shot chat-completions server. Returns its base URL and a channel
/// carrying the request body it received, so a test can assert on what was
/// actually sent rather than only on what came back.
fn mock_endpoint(reply_content: &str) -> (String, mpsc::Receiver<String>) {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind loopback");
    let port = listener.local_addr().expect("addr").port();
    let (tx, rx) = mpsc::channel();

    // The assistant message is itself JSON, so it has to be embedded as a JSON
    // *string* — the same double-encoding a real endpoint performs.
    let body = serde_json::json!({
        "choices": [ { "message": { "role": "assistant", "content": reply_content } } ]
    })
    .to_string();

    thread::spawn(move || {
        for stream in listener.incoming().take(1) {
            let Ok(mut stream) = stream else { continue };
            let request = read_request(&mut stream);
            let _ = tx.send(request);
            let response = format!(
                "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{}",
                body.len(),
                body
            );
            let _ = stream.write_all(response.as_bytes());
            let _ = stream.flush();
        }
    });

    (format!("http://127.0.0.1:{port}/v1"), rx)
}

/// Read one HTTP request and return its body. Reads exactly `content-length`
/// bytes so the client is never left waiting on a half-consumed request.
fn read_request(stream: &mut TcpStream) -> String {
    let mut reader = BufReader::new(stream.try_clone().expect("clone stream"));
    let mut length = 0usize;
    loop {
        let mut line = String::new();
        if reader.read_line(&mut line).unwrap_or(0) == 0 {
            break;
        }
        if line == "\r\n" {
            break;
        }
        if let Some(value) = line.to_ascii_lowercase().strip_prefix("content-length:") {
            length = value.trim().parse().unwrap_or(0);
        }
    }
    let mut body = vec![0u8; length];
    reader.read_exact(&mut body).expect("read body");
    String::from_utf8(body).expect("utf-8 body")
}

fn endpoint(url: String) -> Endpoint {
    Endpoint {
        url,
        api_key: None,
        model: "mock-model".into(),
        vision_model: None,
    }
}

fn lines() -> Vec<String> {
    [
        "Springfield Community Laboratory",
        "Patient: Synthetic Test",
        "Analyte Result Unit Reference",
        "Sodium 139 mmol/L 135-145",
        "Potassium 4.1 mmol/L 3.5-5.1",
    ]
    .into_iter()
    .map(str::to_string)
    .collect()
}

fn truth() -> Truth {
    Truth {
        page: "cmp-panel.png".into(),
        note: String::new(),
        hazard: String::new(),
        expected: vec![
            Expected {
                analyte: "Sodium".into(),
                value: "139".into(),
                unit: "mmol/L".into(),
            },
            Expected {
                analyte: "Potassium".into(),
                value: "4.1".into(),
                unit: "mmol/L".into(),
            },
        ],
    }
}

#[test]
fn a_transcript_reaches_the_endpoint_and_its_answer_is_scored() {
    let reply = r#"{"findings":[
        {"kind":"observation","source_line":4,"system":"http://loinc.org","code":"2951-2",
         "display":"Sodium","value_quantity":"139","unit":"mmol/L","confidence":0.9},
        {"kind":"observation","source_line":5,"system":"http://loinc.org","code":"2823-3",
         "display":"Potassium","value_quantity":"4.1","unit":"mmol/L","confidence":0.9}
    ]}"#;
    let (url, requests) = mock_endpoint(reply);

    let answer = endpoint(url).code(&lines()).expect("coding round-trip");
    let sent = requests.recv().expect("the endpoint saw a request");

    // The transcript went out numbered, which is what a finding cites back to.
    assert!(
        sent.contains("[4] Sodium 139 mmol/L 135-145"),
        "sent: {sent}"
    );
    // ...under the shipping prompt, not one this harness invented.
    assert!(sent.contains("code already-transcribed medical text"));
    assert!(sent.contains("\"model\":\"mock-model\""));

    let extraction = svastha_import::extract::parse_lines(&answer, &lines());
    let scored = score(&truth(), &extraction);
    assert_eq!(scored.correct, 2);
    assert_eq!(scored.cross_row, 0);
    assert_eq!(scored.recall(), Some(1.0));
    assert_eq!(scored.precision(), Some(1.0));
}

/// The same plumbing carrying a mis-associated answer. Both halves matter: the
/// verified path must drop it, and the *unverified* path — which is what the
/// recovered vision reader is scored through — must show it as cross-row.
/// A harness that could not tell those apart could not serve the gate.
#[test]
fn a_cross_row_answer_is_dropped_when_verified_and_counted_when_not() {
    let reply = r#"{"findings":[
        {"kind":"observation","source_line":5,"system":"http://loinc.org","code":"2823-3",
         "display":"Potassium","value_quantity":"139","unit":"mmol/L","confidence":0.9}
    ]}"#;
    let (url, _requests) = mock_endpoint(reply);
    let answer = endpoint(url).code(&lines()).expect("coding round-trip");

    let verified = score(
        &truth(),
        &svastha_import::extract::parse_lines(&answer, &lines()),
    );
    assert_eq!(verified.proposed, 0, "the source-line guard should drop it");
    assert_eq!(verified.cross_row, 0);

    let unverified = score(&truth(), &svastha_import::extract::parse(&answer));
    assert_eq!(unverified.cross_row, 1);
}

/// An endpoint that answers with prose rather than the schema must surface as
/// unparseable, not as a page with nothing on it — the distinction the node's
/// journal treats as terminal-vs-retryable.
#[test]
fn a_non_schema_reply_is_unparseable_rather_than_an_empty_page() {
    let (url, _requests) = mock_endpoint("I'm sorry, I can't help with medical documents.");
    let answer = endpoint(url).code(&lines()).expect("coding round-trip");

    let extraction = svastha_import::extract::parse_lines(&answer, &lines());
    assert_eq!(
        extraction.outcome(),
        svastha_import::extract::Outcome::Unparseable
    );
    let scored = score(&truth(), &extraction);
    assert_eq!(scored.correct, 0);
    assert_eq!(scored.recall(), Some(0.0));
}

/// A dead endpoint is a run that did not measure anything, and has to read that
/// way rather than as a reader that scored zero.
#[test]
fn an_unreachable_endpoint_is_an_error_not_a_zero_score() {
    // Port 1 on loopback: nothing listens, and connecting fails immediately.
    let result = endpoint("http://127.0.0.1:1/v1".into()).code(&lines());
    assert!(
        result.is_err(),
        "a refused connection must not read as an answer"
    );
}
