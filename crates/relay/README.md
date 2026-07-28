# svastha-relay

The [Svastha](https://github.com/cosmicspork/svastha) relay: a zero-knowledge
store-and-forward server for encrypted blobs. It holds no keys and never
decrypts — it stores opaque ciphertext scoped to an owner public key and
authenticates every request with a per-request Ed25519 signature (verified via
[`svastha-core`](https://crates.io/crates/svastha-core)). Ships as a single
static binary for trivial self-hosting.

Run with `cargo run -p svastha-relay`; configure via `SVASTHA_RELAY_ADDR`,
`SVASTHA_RELAY_MAX_SKEW_SECS`, and `SVASTHA_RELAY_DATA_DIR`.

## Push channel

`GET /v0/events` is a long-lived authenticated Server-Sent Events stream of
payload-free "go pull" pokes (the pull endpoints stay the source of truth; the
stream is a lossy optimization). It emits a heartbeat comment roughly every 30
seconds so idle connections survive intermediaries that close a quiet stream.
If you terminate TLS or reverse-proxy in front of the relay, set the proxy's
**read/idle timeout above the heartbeat interval** (a minute or more), or the
stream will be severed mid-life; disable response buffering for the endpoint so
pokes flush immediately.

### Web Push (optional)

The same poke bus can also fan out over **Web Push**, so a poke reaches a locked
phone whose PWA is closed. It is **off unless you supply a VAPID keypair**; with
none, the `/v0/push*` endpoints answer `503` and everything else works unchanged.
The push carries no content — only a constant marker encrypted to the
subscription's own keys — so the push services learn poke timing, never content.

Configure with three environment variables (all three, or none):

| Variable | Meaning |
|---|---|
| `SVASTHA_RELAY_VAPID_PRIVATE` | VAPID private key, base64url (never leaves the relay) |
| `SVASTHA_RELAY_VAPID_PUBLIC` | VAPID public key, base64url (served to clients as `applicationServerKey`) |
| `SVASTHA_RELAY_VAPID_SUBJECT` | VAPID `sub` claim — a `mailto:` or `https:` operator contact the push service can reach |

Setting only some of the three is a misconfiguration and aborts startup — push
must be fully configured or fully absent. Keys are **never generated at boot**;
you supply them. Generate a pair once with OpenSSL (the same base64url encoding
the browser and the `web-push` crate expect):

```sh
# private key (32-byte scalar, base64url, no padding)
openssl ecparam -name prime256v1 -genkey -noout -out vapid.pem
openssl ec -in vapid.pem -text -noout 2>/dev/null \
  | grep -A3 priv: | tail -n +2 | tr -d ' :\n' | xxd -r -p \
  | basenc --base64url | tr -d '='

# public key (uncompressed point, base64url, no padding)
openssl ec -in vapid.pem -pubout -outform DER 2>/dev/null | tail -c 65 \
  | basenc --base64url | tr -d '='
```

Then set `SVASTHA_RELAY_VAPID_SUBJECT` to your contact (e.g. `mailto:you@example.com`).
Keep `vapid.pem` and the private key secret; the public key is not sensitive.

## Upgrading past 0.13.0

Before the mailbox-store namespacing fix that landed after the `v0.13.0` tag,
the mailbox store and the blob store shared the same on-disk root, both keyed
by `{hex(identity)}/`, so a mailbox item and a blob for the same identity
could land in the very same directory. Because `PUT /v0/mailbox/{recipient}/{id}`
lets any authenticated caller choose both `recipient` and `id`, this also meant
any authed identity could overwrite another identity's real blob by depositing
a mailbox item at an `id` the victim already used for a blob.

If your data directory predates this fix, it may still hold residue: mailbox
items, or foreign bytes written via the overwrite above, sitting inside
identity directories under `SVASTHA_RELAY_DATA_DIR`, indistinguishable on disk
from real blobs. Both `GET /v0/blobs/{id}` and the batched `?include=body`
listing serve whatever is in an identity's directory, so this residue is now
also framed into batch listings.

Every legitimate blob id carries one of a small set of prefixes (`ev-`, `doc-`,
`att-`, `cur-`) or is the fixed name `vault.key` (see `docs/ARCHITECTURE.md`'s
"Blob namespaces"). Anything else sitting directly in an identity directory is
residue. List it with:

```sh
find "$SVASTHA_RELAY_DATA_DIR" -mindepth 2 -maxdepth 2 -type f \
  -regextype posix-extended -regex '.*/[0-9a-f]{64}/.*' \
  ! -name 'ev-*' ! -name 'doc-*' ! -name 'att-*' ! -name 'cur-*' ! -name 'vault.key'
```

Review the results — a mailbox item is a small wrapped-key envelope, so
anything sizeable is more likely a genuinely overwritten blob worth
investigating before deleting. Once you're satisfied, append `-delete` to the
same command to remove it.

> Pre-1.0 and unstable.

Licensed under AGPL-3.0-only.
