//! Integration tests for the relay's unauthenticated landing page (`GET /`) —
//! the "relay → device" half of QR linking (see `docs/ARCHITECTURE.md`'s Relay
//! section and `web/src/routes/Onboard.svelte` for the other half).

use std::sync::Arc;

use axum::body::Body;
use axum::http::{Request, StatusCode};
use svastha_relay::app;
use svastha_relay::grants::MemoryGrantStore;
use svastha_relay::mailbox::MemoryMailboxStore;
use svastha_relay::store::MemoryStore;
use tower::ServiceExt;

mod common;
use common::{body_bytes, SKEW};

fn router(app_url: Option<String>) -> axum::Router {
    app(
        Arc::new(MemoryStore::new()),
        Arc::new(MemoryGrantStore::new()),
        Arc::new(MemoryMailboxStore::new()),
        SKEW,
        app_url,
    )
}

#[tokio::test]
async fn landing_page_needs_no_auth_and_renders_html() {
    let response = router(None)
        .oneshot(
            Request::builder()
                .uri("/")
                .header("host", "relay.example.com")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    let content_type = response
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or_default()
        .to_string();
    assert!(content_type.starts_with("text/html"));

    let body = String::from_utf8(body_bytes(response).await).unwrap();
    assert!(body.contains("Svastha relay"));
    assert!(body.contains("<svg"));
}

#[tokio::test]
async fn landing_page_qr_encodes_device_link_when_app_url_is_set() {
    let response = router(Some("https://app.example.com".to_string()))
        .oneshot(
            Request::builder()
                .uri("/")
                .header("host", "relay.example.com")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    let body = String::from_utf8(body_bytes(response).await).unwrap();
    assert!(body.contains("<svg"));
    // The onboard URL is echoed as plain text below the QR (so it can be
    // "pasted by hand" too) — confirm it's the app URL plus the relay's own
    // address derived from this request's headers, not just the bare relay
    // address `landing_page_needs_no_auth_and_renders_html` would also match.
    assert!(body.contains("https://app.example.com/#/onboard?relay=http://relay.example.com"));
}

#[tokio::test]
async fn landing_page_falls_back_without_a_host_header() {
    let response = router(None)
        .oneshot(Request::builder().uri("/").body(Body::empty()).unwrap())
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    let body = String::from_utf8(body_bytes(response).await).unwrap();
    // No address to encode: the QR is skipped rather than shown broken or empty.
    assert!(!body.contains("<svg"));
    assert!(body.contains("this relay"));
}
