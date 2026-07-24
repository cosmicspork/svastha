# Security policy

Svastha handles medical records; security reports are taken seriously and
appreciated.

## Reporting a vulnerability

Please report security issues **privately** via
[GitHub security advisories](https://github.com/cosmicspork/svastha/security/advisories/new)
rather than a public issue or PR. Include what you found, where (crate/module
or endpoint), and how to reproduce it. You'll get an acknowledgment as soon as
the report is read, and credit in the fix's release notes unless you'd rather
not.

## Scope

Most valuable: anything that breaks a stated guarantee — the relay learning
plaintext or key material, signature or verification bypasses in the trust
contract (`crates/core`, `spec/`), cross-tenant leakage in the processing
node, grant-scope or share-token enforcement gaps, or the two-404 non-leak
rule failing to hold.

Out of scope: the trusted-by-design plaintext boundaries stated in
`docs/ARCHITECTURE.md` (a node's host and its configured inference endpoint
see plaintext; a revoked reader keeps what it already decrypted), and
vulnerabilities requiring a compromised device or seed phrase.

## Supported versions

Pre-1.0, only the latest release is supported; fixes ship as normal releases
from `main`.
