# Threat Model

## Assets

- Source code and uncommitted workspace changes
- Provider credentials and machine-local secrets
- Authenticated browser profiles and preview applications
- Agent transcripts, terminal output, and audit records
- Control-plane signing keys and node identities

## Threats

### Compromised or stolen node identity

An attacker could reconnect as an enrolled machine or receive jobs.

Controls: per-node keypairs, short-lived enrollment tokens, signed messages,
key rotation, revocation, replay protection, and heartbeat expiry.

### Model-directed destructive commands

An agent can execute arbitrary commands permitted by the machine account.

Controls: workspace allowlists, least-privilege service accounts, optional
containers, resource/time limits, visible approval for destructive actions, and
an emergency stop.

### Accidental preview publication

A private dev server could become reachable by an unintended user.

Controls: authenticated leases, explicit user/session binding, short expiry,
route revocation, no public bind by default, and audit events for every route.

### Browser data exposure

A remote browser profile could contain tokens or private application data.

Controls: disposable profiles by default, no raw CDP endpoint, navigation
allowlists, explicit browser-session grants, isolated browser processes, and
redacted stream/error logs.

### Credential leakage

Provider keys or authorization headers could enter job payloads, output, or
audit records.

Controls: machine-local secret references, payload validation, output redaction,
no secret echoing, and secret scanning in CI.

## Release gates

- Revoke and reconnect tests pass.
- Unauthorized preview and browser requests are rejected.
- WebSocket/SSE relay disconnects cleanly and cannot outlive its lease.
- Duplicate job delivery is idempotent.
- Logs contain no provider keys, cookies, or authorization headers.
- Stop-all and revoke-all operations work while nodes are online.
