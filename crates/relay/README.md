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

> Pre-1.0 and unstable.

Licensed under AGPL-3.0-only.
