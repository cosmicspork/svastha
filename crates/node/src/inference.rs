//! A generic, blocking **OpenAI-compatible chat-completions** client for
//! extraction (design §8). The endpoint, key, and model are user-supplied
//! ([`crate::config::InferenceConfig`]); the node ships no models and speaks only
//! the one wire shape every such server (Ollama, LM Studio, vLLM, or a cloud
//! endpoint the operator explicitly chose) understands.
//!
//! Two deliberate posture choices:
//!
//! - **Synchronous only.** The node posts one request and blocks for one answer.
//!   A batch-style API is rejected at config time ([`crate::config`]) — batch
//!   outputs are retained server-side, which would leak plaintext beyond the
//!   user's trust boundary.
//! - **Content-free logs.** The request necessarily carries the decrypted page
//!   text to the configured endpoint — that is the design's trust decision — but
//!   *this* crate's logs never carry the prompt or the extracted text: only the
//!   model id and byte/finding counts.
//!
//! This client is transport only: it returns the model's raw assistant-message
//! text. Turning that text into draft events lives in `svastha_import::extract`, so the
//! two concerns test independently.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use ureq::http::StatusCode;
use ureq::Agent;

use crate::config::{validate_inference_endpoint, InferenceConfig};

/// The maximum time to wait on one inference round-trip. Deliberately generous:
/// a self-hosted endpoint on modest hardware can take minutes over a long page,
/// and the reading loop is serial, so this only ever bounds one wedged request
/// rather than the whole node.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(120);

/// A failure talking to the inference endpoint. Every variant is transient from
/// the pipeline's point of view — the source page is marked failed and retried
/// with backoff, never dropped (see [`crate::ocr`]).
#[derive(Debug, thiserror::Error)]
pub enum InferenceError {
    #[error("inference request failed: {0}")]
    Transport(String),
    #[error("inference endpoint returned status {0}")]
    Status(u16),
    #[error("inference response was not the expected chat-completions shape")]
    BadResponse,
}

/// A blocking OpenAI-compatible chat-completions client.
pub struct InferenceClient {
    /// The fully-resolved `.../chat/completions` URL.
    url: String,
    api_key: Option<String>,
    model: String,
    agent: Agent,
}

impl InferenceClient {
    /// Build a client from the validated inference config.
    pub fn new(config: &InferenceConfig) -> Self {
        let agent = Agent::config_builder()
            .http_status_as_error(false)
            .timeout_global(Some(REQUEST_TIMEOUT))
            .build()
            .into();
        Self {
            url: chat_completions_url(&config.endpoint),
            api_key: config.api_key.clone(),
            model: config.model.clone(),
            agent,
        }
    }

    /// The configured model id (also stamped into each draft's provenance).
    pub fn model(&self) -> &str {
        &self.model
    }

    /// Run one **text** chat completion (no image): send `system` + `user` and
    /// return the model's raw assistant-message text. This is the RAG turn (D3) —
    /// the caller supplies the retrieved context inside `user` and parses the
    /// answer defensively (this method makes no claim the text is well-formed).
    /// Shares the coding path's transport, timeout, and deterministic
    /// `temperature: 0`; like it, it logs nothing — the prompt carries the
    /// decrypted context to the endpoint the operator chose, and never to a log.
    pub fn answer(&self, system: &str, user: &str) -> Result<String, InferenceError> {
        let request = serde_json::json!({
            "model": self.model,
            "temperature": 0,
            "messages": [
                { "role": "system", "content": system },
                { "role": "user", "content": user }
            ]
        });
        self.chat(&request)
    }

    /// Post a chat-completions request and return the first choice's text. Shared
    /// by [`code_page`](Self::code_page) and [`answer`](Self::answer).
    fn chat(&self, request: &serde_json::Value) -> Result<String, InferenceError> {
        let body =
            serde_json::to_vec(request).map_err(|e| InferenceError::Transport(e.to_string()))?;
        let mut builder = self
            .agent
            .post(&self.url)
            .header("content-type", "application/json");
        if let Some(key) = &self.api_key {
            builder = builder.header("authorization", format!("Bearer {key}"));
        }
        let mut resp = builder
            .send(&body)
            .map_err(|e| InferenceError::Transport(e.to_string()))?;
        if resp.status() != StatusCode::OK {
            return Err(InferenceError::Status(resp.status().as_u16()));
        }
        let bytes = resp
            .body_mut()
            .read_to_vec()
            .map_err(|e| InferenceError::Transport(e.to_string()))?;
        let parsed: ChatCompletion =
            serde_json::from_slice(&bytes).map_err(|_| InferenceError::BadResponse)?;
        parsed
            .choices
            .into_iter()
            .next()
            .map(|c| c.message.content)
            .ok_or(InferenceError::BadResponse)
    }

    /// Code one already-transcribed page: send the extraction prompt plus the
    /// numbered transcript and return the model's raw assistant-message text.
    /// The caller validates it against that same transcript
    /// ([`svastha_import::extract::parse_lines`]) — this method makes no claim
    /// the text is well-formed JSON, nor that its findings belong to the lines
    /// they cite.
    pub fn code_page(&self, numbered_lines: &str) -> Result<String, InferenceError> {
        let user = format!(
            "{}\n\nThe page, one numbered line per row:\n{}",
            svastha_import::extract::USER_PROMPT,
            numbered_lines
        );
        self.answer(svastha_import::extract::SYSTEM_PROMPT, &user)
    }
}

/// The runtime inference target for both roles, **per owner**, settable with the
/// `set_inference_endpoint` admin command (design §9). It owns the live
/// [`InferenceClient`]s the OCR (coding) and chat (RAG) passes use and resolves
/// them for the owner whose work is being done.
///
/// # Your endpoint, your vault
///
/// The third of the per-owner controls, for the reason the first two are (see
/// [`crate::ocr_control`] and [`crate::answer_scope`]): the command is scoped to
/// its sender, so a node serving two households sends each household's pages and
/// questions where *that* household said to. It used to be node-wide, which meant
/// any one enrolled owner could silently repoint everyone else's plaintext at a
/// host of their choosing — the one shared control with real teeth, and the
/// reason enrolling a second owner needed a caveat.
///
/// **Precedence, per owner and per role: that owner's persisted endpoint, else
/// the operator's env boot default for the role, else nothing** — and "nothing"
/// means that owner's inference simply does not run, reported honestly by
/// `job_status` rather than papered over with someone else's endpoint.
///
/// # An owner's endpoint uses an owner's key
///
/// An owner override carries its own optional API key and **never borrows one**:
/// not the operator's env key, and certainly not another owner's. Borrowing the
/// env key would hand any enrolled owner a way to spend — and to exfiltrate — the
/// operator's credential by pointing their endpoint at a host they control. So an
/// override sends the owner's key or no key at all.
///
/// The *model* is borrowed from the role's boot config, because the command
/// carries no model id and a model id is not a secret. An override therefore
/// still needs one boot role config to name a model; setting an endpoint on a
/// node with no inference model configured at all is rejected.
pub struct InferenceRuntime {
    /// OCR-role boot config (text model + key + endpoint), or `None`.
    ocr_boot: Option<InferenceConfig>,
    /// Chat-role boot config (text model + key + endpoint), or `None`.
    chat_boot: Option<InferenceConfig>,
    /// Where the per-owner endpoints persist (data dir).
    state_path: PathBuf,
    /// Each owner's persisted choice, by Ed25519 hex.
    owners: BTreeMap<String, OwnerEndpoint>,
    /// The operator default's live clients, used for owners with no choice.
    default_clients: RoleClients,
    /// Live clients for owners who have chosen, by Ed25519 hex.
    owner_clients: BTreeMap<String, RoleClients>,
    /// False when a present endpoint state file could not be read or parsed.
    /// Falling back to the operator endpoint in that condition could disclose an
    /// owner's record to a recipient they had explicitly replaced, so all
    /// inference remains stopped until the state is repaired.
    state_readable: bool,
}

/// One owner's endpoint choice.
#[derive(Clone, Serialize, Deserialize)]
struct OwnerEndpoint {
    endpoint: String,
    /// The credential for *that* endpoint, if it needs one. Persisted beside the
    /// node identity seed, which is the same trust position the operator's env
    /// key already has: a host that can read this dir can already read the node's
    /// identity and its decrypted cache.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    api_key: Option<String>,
}

/// The persisted half: every owner's endpoint choice. Config, not record content,
/// so it is safe in the durable data dir (unlike plaintext, which stays ephemeral)
/// — with the caveat above about the key it may carry.
#[derive(Default, Serialize, Deserialize)]
struct PersistedState {
    #[serde(default)]
    owners: BTreeMap<String, OwnerEndpoint>,
}

/// The live clients for one resolution target, one per role. A role is `None`
/// when it has no boot config to name a model with.
#[derive(Default)]
struct RoleClients {
    ocr: Option<InferenceClient>,
    chat: Option<InferenceClient>,
}

const STATE_FILE: &str = "inference-endpoints.json";

impl InferenceRuntime {
    /// Build the runtime from the two role boot configs and the data dir, reading
    /// every owner's persisted endpoint.
    pub fn load(
        ocr_boot: Option<InferenceConfig>,
        chat_boot: Option<InferenceConfig>,
        data_dir: &Path,
    ) -> Self {
        let state_path = data_dir.join(STATE_FILE);
        let (persisted, state_readable) = match fs::read(&state_path) {
            Ok(bytes) => match serde_json::from_slice::<PersistedState>(&bytes) {
                Ok(state) => (state, true),
                Err(e) => {
                    tracing::error!(error = %e, "inference endpoint state could not be parsed; inference is disabled");
                    (PersistedState::default(), false)
                }
            },
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => (PersistedState::default(), true),
            Err(e) => {
                tracing::error!(error = %e, "inference endpoint state could not be read; inference is disabled");
                (PersistedState::default(), false)
            }
        };
        let mut rt = Self {
            ocr_boot,
            chat_boot,
            state_path,
            owners: persisted.owners,
            default_clients: RoleClients::default(),
            owner_clients: BTreeMap::new(),
            state_readable,
        };
        rt.default_clients = rt.build_default();
        let owners: Vec<String> = rt.owners.keys().cloned().collect();
        for owner in owners {
            rt.rebuild_owner(&owner);
        }
        rt
    }

    /// The OCR (coding) client for `owner_hex`, if that owner's pages can be
    /// coded at all. `None` means the pass does not run for them (a page waits
    /// rather than getting a fake extraction).
    pub fn ocr_client(&self, owner_hex: &str) -> Option<&InferenceClient> {
        self.clients_for(owner_hex)
            .and_then(|clients| clients.ocr.as_ref())
    }

    /// The chat (RAG) client for `owner_hex`, if their questions can be answered
    /// at all. `None` means the question waits in the mailbox rather than getting
    /// a fake answer, mirroring the web's honest waiting state.
    pub fn chat_client(&self, owner_hex: &str) -> Option<&InferenceClient> {
        self.clients_for(owner_hex)
            .and_then(|clients| clients.chat.as_ref())
    }

    /// Whether any role has an operator default. Only for the boot log — an owner
    /// with their own endpoint runs regardless of what this says.
    pub fn has_operator_default(&self) -> bool {
        self.ocr_boot.is_some() || self.chat_boot.is_some()
    }

    /// The `job_status` line about **this owner's** inference: their effective
    /// model and endpoint **host** per role, and where that endpoint came from.
    ///
    /// The host, never the URL's path or query, and never the API key — a
    /// `job_status` reply is the one place a credential could ride back out to
    /// anything that reads the admin log. And only ever the asker's own: another
    /// owner's endpoint is not the asker's business.
    pub fn describe_for(&self, owner_hex: &str) -> String {
        if !self.state_readable {
            return "not configured — this node's endpoint state could not be read, \
                    so nothing of yours is sent anywhere"
                .to_string();
        }
        let clients = self
            .clients_for(owner_hex)
            .expect("readable endpoint state always resolves clients");
        let source = if self.owners.contains_key(owner_hex) {
            "your endpoint"
        } else if self.has_operator_default() {
            "this node's default"
        } else {
            return "not configured — this node has no default endpoint and you have not set one, \
                    so nothing of yours is sent anywhere"
                .to_string();
        };
        format!(
            "ocr={} chat={} ({source})",
            describe_role(clients.ocr.as_ref()),
            describe_role(clients.chat.as_ref()),
        )
    }

    /// Apply a `set_inference_endpoint` command for `owner_hex`: validate the
    /// endpoint against the same design-§8 hard constraints boot uses
    /// (synchronous, non-batch), persist it with its optional key, and swap that
    /// owner's live clients. Nobody else's resolution changes.
    ///
    /// Returns the owner-facing detail for the `admin_reply`, or the
    /// validation/precondition message to send back as `ok: false` — never a
    /// panic, so a bad value just fails the command.
    pub fn set_endpoint(
        &mut self,
        owner_hex: &str,
        endpoint: &str,
        api_key: Option<&str>,
    ) -> Result<String, String> {
        if !self.state_readable {
            return Err(
                "the saved endpoint state could not be read; repair it before changing an endpoint"
                    .to_string(),
            );
        }
        let endpoint = endpoint.trim().to_string();
        validate_inference_endpoint(&endpoint)?;
        // The command carries no model; each role borrows one from its boot
        // config, so without any role there is nothing to run.
        if !self.has_operator_default() {
            return Err(
                "no inference model configured at boot (SVASTHA_NODE_INFERENCE_MODEL); \
                 an endpoint alone cannot run"
                    .to_string(),
            );
        }
        let choice = OwnerEndpoint {
            endpoint: endpoint.clone(),
            api_key: api_key
                .map(str::trim)
                .filter(|k| !k.is_empty())
                .map(String::from),
        };
        let previous = self.owners.insert(owner_hex.to_string(), choice);
        if let Err(e) = self.persist() {
            match previous {
                Some(p) => self.owners.insert(owner_hex.to_string(), p),
                None => self.owners.remove(owner_hex),
            };
            return Err(format!("could not save the endpoint: {e}"));
        }
        self.rebuild_owner(owner_hex);
        Ok(format!(
            "your inference endpoint is now {host}; anyone else this node serves is unaffected {marker}",
            host = host_of(&endpoint),
            marker = endpoint_marker(Some(&endpoint)),
        ))
    }

    /// The `[endpoint: …]` marker for `owner_hex`'s effective endpoint — what a
    /// client compares against to confirm what is actually in force, rather than
    /// taking `ok` at its word (the same rule `set_answer_scope` follows).
    pub fn marker_for(&self, owner_hex: &str) -> String {
        endpoint_marker(self.effective_endpoint(owner_hex))
    }

    /// This owner's endpoint if they set one, else the role-independent operator
    /// default when both roles share one. `None` when nothing is configured.
    fn effective_endpoint(&self, owner_hex: &str) -> Option<&str> {
        if !self.state_readable {
            return None;
        }
        if let Some(own) = self.owners.get(owner_hex) {
            return Some(&own.endpoint);
        }
        // The env can point the two roles at different hosts, in which case there
        // is no single "the endpoint" to state; the marker then says so rather
        // than picking one of them.
        match (&self.ocr_boot, &self.chat_boot) {
            (Some(o), Some(c)) if o.endpoint != c.endpoint => None,
            (Some(o), _) => Some(&o.endpoint),
            (None, Some(c)) => Some(&c.endpoint),
            (None, None) => None,
        }
    }

    fn clients_for(&self, owner_hex: &str) -> Option<&RoleClients> {
        if !self.state_readable {
            return None;
        }
        Some(
            self.owner_clients
                .get(owner_hex)
                .unwrap_or(&self.default_clients),
        )
    }

    /// The operator default's clients: each role entirely from its own boot
    /// config (endpoint, model, and key together).
    fn build_default(&self) -> RoleClients {
        RoleClients {
            ocr: self.ocr_boot.as_ref().map(InferenceClient::new),
            chat: self.chat_boot.as_ref().map(InferenceClient::new),
        }
    }

    /// Rebuild one owner's clients from their persisted choice: their endpoint and
    /// their key (or none), with each role's model borrowed from its boot config.
    fn rebuild_owner(&mut self, owner_hex: &str) {
        let Some(choice) = self.owners.get(owner_hex).cloned() else {
            self.owner_clients.remove(owner_hex);
            return;
        };
        let for_role = |boot: &Option<InferenceConfig>| {
            boot.as_ref().map(|boot| {
                InferenceClient::new(&InferenceConfig {
                    endpoint: choice.endpoint.clone(),
                    // The owner's key or none — never the boot key, which belongs
                    // to the operator's endpoint and not to this one.
                    api_key: choice.api_key.clone(),
                    model: boot.model.clone(),
                })
            })
        };
        let clients = RoleClients {
            ocr: for_role(&self.ocr_boot),
            chat: for_role(&self.chat_boot),
        };
        self.owner_clients.insert(owner_hex.to_string(), clients);
    }

    fn persist(&self) -> std::io::Result<()> {
        if let Some(parent) = self.state_path.parent() {
            fs::create_dir_all(parent)?;
        }
        let bytes = serde_json::to_vec_pretty(&PersistedState {
            owners: self.owners.clone(),
        })
        .map_err(std::io::Error::other)?;
        // Atomic write-temp-then-rename, like the journal, so a crash never leaves
        // a half-written state file that would fail to parse.
        let tmp = self.state_path.with_extension("json.tmp");
        fs::write(&tmp, &bytes)?;
        fs::rename(&tmp, &self.state_path)
    }
}

/// `model@host`, or `none` for a role that cannot run.
fn describe_role(client: Option<&InferenceClient>) -> String {
    match client {
        Some(c) => format!("{}@{}", c.model(), host_of(&c.url)),
        None => "none".to_string(),
    }
}

/// The confirmable statement of what is in force, mirroring
/// [`svastha_retrieval::AnswerScope::marker`]: a client checks this rather than
/// trusting `ok`, because a command can be understood, answered, and still not be
/// the one the node settled on.
fn endpoint_marker(endpoint: Option<&str>) -> String {
    match endpoint {
        Some(e) => format!("[endpoint: {}]", host_of(e)),
        None => "[endpoint: none]".to_string(),
    }
}

/// The host (with port) of a URL, for status lines.
///
/// Path and query are dropped because they are where a credential hides — an
/// endpoint of the `https://host/v1?api-key=…` shape is common enough that
/// echoing whole URLs into a reply is a real leak, not a hypothetical one. Any
/// `user:pass@` userinfo is dropped for the same reason.
fn host_of(url: &str) -> &str {
    let after_scheme = url.split_once("://").map(|(_, rest)| rest).unwrap_or(url);
    let authority = after_scheme
        .split(['/', '?', '#'])
        .next()
        .unwrap_or(after_scheme);
    match authority.rsplit_once('@') {
        Some((_, host)) => host,
        None => authority,
    }
}

/// Resolve the configured base (e.g. `https://host/v1`) to the chat-completions
/// URL. If the operator already pointed at the full path, use it verbatim.
fn chat_completions_url(endpoint: &str) -> String {
    let trimmed = endpoint.trim_end_matches('/');
    if trimmed.ends_with("/chat/completions") {
        trimmed.to_string()
    } else {
        format!("{trimmed}/chat/completions")
    }
}

/// The subset of the chat-completions response the node reads: the first
/// choice's assistant message text. Unknown fields (`usage`, `id`, …) are
/// ignored, so any compliant server's extra keys are harmless.
#[derive(Deserialize)]
struct ChatCompletion {
    choices: Vec<Choice>,
}

#[derive(Deserialize)]
struct Choice {
    message: Message,
}

#[derive(Deserialize)]
struct Message {
    /// Assistant content. Required as a string here; a server that returns a
    /// structured content array instead fails parsing and is treated as a
    /// transient bad response (retried), never a malformed proposal.
    #[serde(default)]
    content: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_base_to_chat_completions() {
        assert_eq!(
            chat_completions_url("https://host/v1"),
            "https://host/v1/chat/completions"
        );
        assert_eq!(
            chat_completions_url("https://host/v1/"),
            "https://host/v1/chat/completions"
        );
        // An operator who pointed at the full path is honoured verbatim.
        assert_eq!(
            chat_completions_url("https://host/v1/chat/completions"),
            "https://host/v1/chat/completions"
        );
    }

    #[test]
    fn parses_a_minimal_completion() {
        let json = r#"{"id":"x","choices":[{"message":{"role":"assistant","content":"hello"}}],"usage":{}}"#;
        let parsed: ChatCompletion = serde_json::from_str(json).unwrap();
        assert_eq!(parsed.choices[0].message.content, "hello");
    }

    #[test]
    fn empty_choices_has_no_content() {
        let json = r#"{"choices":[]}"#;
        let parsed: ChatCompletion = serde_json::from_str(json).unwrap();
        assert!(parsed.choices.is_empty());
    }

    const A: &str = "aaaa";
    const B: &str = "bbbb";

    fn boot(endpoint: &str) -> InferenceConfig {
        InferenceConfig {
            endpoint: endpoint.to_string(),
            api_key: None,
            model: "m".to_string(),
        }
    }

    /// A boot config with an explicit model, to prove per-role model routing.
    fn boot_model(endpoint: &str, model: &str) -> InferenceConfig {
        InferenceConfig {
            endpoint: endpoint.to_string(),
            api_key: None,
            model: model.to_string(),
        }
    }

    /// A boot config with the operator's own credential on it.
    fn boot_keyed(endpoint: &str, key: &str) -> InferenceConfig {
        InferenceConfig {
            endpoint: endpoint.to_string(),
            api_key: Some(key.to_string()),
            model: "m".to_string(),
        }
    }

    #[test]
    fn host_of_keeps_the_host_and_drops_everything_that_could_carry_a_secret() {
        assert_eq!(host_of("https://host/v1"), "host");
        assert_eq!(host_of("http://127.0.0.1:11434/v1"), "127.0.0.1:11434");
        assert_eq!(host_of("https://host/v1?api-key=sk-secret"), "host");
        assert_eq!(host_of("https://user:pw@host/v1"), "host");
        assert_eq!(host_of("host"), "host");
    }

    #[test]
    fn an_owner_with_no_choice_uses_the_operators_default() {
        let dir = tempfile::tempdir().unwrap();
        let rt = InferenceRuntime::load(
            Some(boot_model("https://coding/v1", "coding-model")),
            Some(boot_model("https://chat/v1", "chat-model")),
            dir.path(),
        );
        assert_eq!(rt.ocr_client(A).map(|c| c.model()), Some("coding-model"));
        assert_eq!(rt.chat_client(A).map(|c| c.model()), Some("chat-model"));
        assert!(rt.describe_for(A).contains("this node's default"));
    }

    #[test]
    fn a_role_with_no_boot_config_is_disabled_while_the_other_runs() {
        let dir = tempfile::tempdir().unwrap();
        // Chat-only: OCR has no boot config, so its pass never runs.
        let rt = InferenceRuntime::load(None, Some(boot("https://chat/v1")), dir.path());
        assert!(rt.ocr_client(A).is_none());
        assert!(rt.chat_client(A).is_some());
    }

    #[test]
    fn an_owners_endpoint_is_theirs_alone() {
        let dir = tempfile::tempdir().unwrap();
        let mut rt = InferenceRuntime::load(
            Some(boot("https://default/v1")),
            Some(boot("https://default/v1")),
            dir.path(),
        );
        rt.set_endpoint(A, "https://a-host/v1", None).unwrap();

        assert_eq!(
            rt.chat_client(A).map(|c| c.url.as_str()),
            Some("https://a-host/v1/chat/completions")
        );
        assert_eq!(
            rt.ocr_client(A).map(|c| c.url.as_str()),
            Some("https://a-host/v1/chat/completions")
        );
        // B never chose, so B's work still goes to the operator's endpoint. This
        // is the whole point of the change: one owner cannot repoint another's
        // plaintext.
        assert_eq!(
            rt.chat_client(B).map(|c| c.url.as_str()),
            Some("https://default/v1/chat/completions")
        );
    }

    #[test]
    fn an_owner_endpoint_never_borrows_another_key() {
        let dir = tempfile::tempdir().unwrap();
        let mut rt = InferenceRuntime::load(
            Some(boot_keyed("https://default/v1", "operator-key")),
            Some(boot_keyed("https://default/v1", "operator-key")),
            dir.path(),
        );
        // B sets an endpoint *with* a key, so there is a second owner's
        // credential in the runtime for A's resolution to go wrong towards.
        rt.set_endpoint(B, "https://b-host/v1", Some("b-key"))
            .unwrap();
        rt.set_endpoint(A, "https://a-host/v1", None).unwrap();

        // A supplied no key, so A's endpoint gets none. Not the operator's —
        // which an owner-chosen host would otherwise be handed, spending and
        // exposing a credential that is not theirs — and not B's.
        for client in [rt.ocr_client(A).unwrap(), rt.chat_client(A).unwrap()] {
            assert_eq!(client.api_key, None, "A's endpoint gets A's key or none");
        }
        // B's own key does reach B's own endpoint.
        assert_eq!(rt.chat_client(B).unwrap().api_key.as_deref(), Some("b-key"));
        // And an owner with no choice still gets the operator's key on the
        // operator's endpoint, which is where it belongs.
        assert_eq!(
            rt.chat_client("cccc").unwrap().api_key.as_deref(),
            Some("operator-key")
        );
    }

    #[test]
    fn an_owner_endpoint_borrows_the_role_model_and_survives_a_restart() {
        let dir = tempfile::tempdir().unwrap();
        let mut rt = InferenceRuntime::load(
            Some(boot_model("https://default/v1", "coding-model")),
            Some(boot_model("https://default/v1", "chat-model")),
            dir.path(),
        );
        rt.set_endpoint(A, "https://a-host/v1", Some("a-key"))
            .unwrap();
        assert_eq!(rt.ocr_client(A).map(|c| c.model()), Some("coding-model"));
        assert_eq!(rt.chat_client(A).map(|c| c.model()), Some("chat-model"));

        let reloaded = InferenceRuntime::load(
            Some(boot_model("https://default/v1", "coding-model")),
            Some(boot_model("https://default/v1", "chat-model")),
            dir.path(),
        );
        let client = reloaded.chat_client(A).unwrap();
        assert_eq!(client.url, "https://a-host/v1/chat/completions");
        assert_eq!(
            client.api_key.as_deref(),
            Some("a-key"),
            "the key persists too"
        );
        assert_eq!(
            reloaded.chat_client(B).unwrap().url,
            "https://default/v1/chat/completions",
            "and nobody else was moved"
        );
    }

    #[test]
    fn a_later_endpoint_replaces_the_key_rather_than_keeping_the_old_one() {
        // "No key" has to be expressible. A node that kept the previous key when
        // a command omitted one would go on sending an old credential to a host
        // the owner has since repointed away from.
        let dir = tempfile::tempdir().unwrap();
        let mut rt = InferenceRuntime::load(
            Some(boot("https://default/v1")),
            Some(boot("https://default/v1")),
            dir.path(),
        );
        rt.set_endpoint(A, "https://a-host/v1", Some("a-key"))
            .unwrap();
        rt.set_endpoint(A, "https://elsewhere/v1", None).unwrap();
        assert_eq!(rt.chat_client(A).unwrap().api_key, None);
        // An all-whitespace key is "none" too, not a credential of spaces.
        rt.set_endpoint(A, "https://elsewhere/v1", Some("   "))
            .unwrap();
        assert_eq!(rt.chat_client(A).unwrap().api_key, None);
    }

    #[test]
    fn set_endpoint_rejects_a_batch_path_without_swapping() {
        let dir = tempfile::tempdir().unwrap();
        let mut rt = InferenceRuntime::load(
            Some(boot("https://boot/v1")),
            Some(boot("https://boot/v1")),
            dir.path(),
        );
        let err = rt
            .set_endpoint(A, "https://api/v1/batch", None)
            .unwrap_err();
        assert!(err.contains("Batch"), "batch rejection message surfaced");
        // Rejected value never becomes live.
        assert_eq!(
            rt.chat_client(A).unwrap().url,
            "https://boot/v1/chat/completions"
        );
    }

    #[test]
    fn set_endpoint_without_any_boot_model_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        let mut rt = InferenceRuntime::load(None, None, dir.path());
        assert!(rt.ocr_client(A).is_none() && rt.chat_client(A).is_none());
        let err = rt.set_endpoint(A, "https://override/v1", None).unwrap_err();
        assert!(err.contains("model"), "explains the missing boot model");
        assert!(
            rt.ocr_client(A).is_none() && rt.chat_client(A).is_none(),
            "still unusable"
        );
    }

    #[test]
    fn an_owner_with_nothing_configured_is_told_so_rather_than_sent_elsewhere() {
        let dir = tempfile::tempdir().unwrap();
        let rt = InferenceRuntime::load(None, None, dir.path());
        let detail = rt.describe_for(A);
        assert!(detail.contains("not configured"));
        assert!(detail.contains("nothing of yours is sent anywhere"));
        assert_eq!(rt.marker_for(A), "[endpoint: none]");
    }

    #[test]
    fn the_status_line_names_the_askers_host_and_never_a_key_or_anyone_elses() {
        let dir = tempfile::tempdir().unwrap();
        let mut rt = InferenceRuntime::load(
            Some(boot_keyed("https://default/v1", "operator-key")),
            Some(boot_keyed("https://default/v1", "operator-key")),
            dir.path(),
        );
        rt.set_endpoint(A, "https://a-host/v1?api-key=a-secret", Some("a-key"))
            .unwrap();
        rt.set_endpoint(B, "https://b-host/v1", Some("b-key"))
            .unwrap();

        let detail = rt.describe_for(A);
        assert!(detail.contains("a-host"), "the asker's own host");
        assert!(detail.contains("your endpoint"), "and where it came from");
        assert!(!detail.contains("b-host"), "never another owner's endpoint");
        for secret in ["a-key", "b-key", "operator-key", "a-secret"] {
            assert!(!detail.contains(secret), "never a credential: {secret}");
        }
        assert_eq!(rt.marker_for(A), "[endpoint: a-host]");
    }

    #[test]
    fn a_node_wide_override_from_before_per_owner_endpoints_is_ignored() {
        // The old file held one URL with nobody's name on it. An unattributable
        // value is not any owner's choice, so it is not applied as one — the
        // operator's env default is the remedy, exactly as for the reading gate.
        let dir = tempfile::tempdir().unwrap();
        fs::write(
            dir.path().join("inference-endpoint.json"),
            br#"{"endpoint":"https://legacy/v1"}"#,
        )
        .unwrap();
        let rt = InferenceRuntime::load(
            Some(boot("https://default/v1")),
            Some(boot("https://default/v1")),
            dir.path(),
        );
        assert_eq!(
            rt.chat_client(A).unwrap().url,
            "https://default/v1/chat/completions"
        );
    }

    #[test]
    fn an_unreadable_state_file_fails_closed_instead_of_falling_back_to_the_operator() {
        // A readable state file can contain an owner's endpoint that deliberately
        // keeps their record away from the operator default. If it cannot be
        // parsed, treating it as no choice silently changes that disclosure
        // decision. Keep every owner's inference stopped until the state is
        // repaired; do not overwrite the unreadable file from another command.
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join(STATE_FILE), b"not json").unwrap();
        let mut rt = InferenceRuntime::load(
            Some(boot("https://default/v1")),
            Some(boot("https://default/v1")),
            dir.path(),
        );
        assert!(rt.ocr_client(A).is_none());
        assert!(rt.chat_client(A).is_none());
        assert!(rt.describe_for(A).contains("could not be read"));
        assert_eq!(rt.marker_for(A), "[endpoint: none]");
        assert!(rt
            .set_endpoint(A, "https://replacement/v1", None)
            .unwrap_err()
            .contains("could not be read"));
    }
}
