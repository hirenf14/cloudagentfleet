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

### Workspace enumeration leakage

Path autocomplete could reveal directory names outside the operator's intended
scope or follow a symlink into a protected location.

Controls: suggestions execute on the Worker, are directory-only and bounded,
reject traversal, skip symlinks, verify real paths against the active policy,
and never expose raw filesystem results through direct Codeman HTTP mode.

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
no secret echoing, and secret scanning in CI. A generated Hub Worker token
lives only in the owner-only `hub-worker-token` file and the Worker's `0600`
`worker.json`; the Hub logs its path, never its value.

### Accidental Hub publication

The operator could expose the Hub or a Codeman endpoint to the public
internet, or grant the Hub to more tailnet users than intended.

Controls: the Hub defaults to loopback, the Hub serving command rejects
non-loopback binds and invokes Tailscale with shell execution disabled, and it
creates one Hub route rather than per-instance routes. Tailscale ACLs must
restrict the Hub to intended operators; Funnel must remain disabled. The
command checks local Hub health before configuring Serve.

### Tailnet member without application authorization

An otherwise-valid tailnet member could reach the Hub and control sessions if
network membership were treated as sufficient authorization.

Controls: require the Hub UI password on every browser session, use HttpOnly
session cookies, enforce same-origin state-changing requests, rate limit failed
logins, and keep Worker bearer credentials separate from the UI password.
Tailscale ACLs remain the network boundary; the Hub password is the application
boundary.

### Proxied and linked hosts outside Hub policy

Proxied host UIs (Codeman and Open WebUI Computer) are served on a separate
**host-UI origin** (its own port), never on the dashboard origin. That matters
most for cptr, whose in-app browser renders arbitrary third-party pages into
its own origin: those scripts cannot read Hub API responses (same-origin
policy), and the Hub rejects mutations whose Origin is not the dashboard. The
Hub session gates every request on both origins.

Only cptr's own session cookie crosses the proxy, renamed per instance
(`cf_<instance>_cptr_session`). Hub cookies and authorization never reach a
backend, upstream cookies outside that allowlist never reach the browser, and
Hub logout clears the bridged cookies. The proxy and WebSocket relay verify
upstream TLS certificates for every non-loopback host.

cptr prints a one-time setup token on each start. The Worker uses it to
create cptr's `fleet` account and keeps that password in
`~/.cloudagentfleet/cptr-credentials.json` (owner-only); without automatic
setup it writes the token to `~/.cloudagentfleet/cptr-setup-token`
(owner-only). The token is redacted from `cptr.log` and never printed to
service logs.

Hub sign-in to cptr: when a browser signed in to the Hub opens a connector
cptr without a cptr session, the Hub asks that cptr's own Worker
(`cptr.session`, accepted only for the Worker's cptr instance) for one. The
Worker signs in to its loopback cptr and returns only the session token; the
Hub places it in the browser's per-instance HttpOnly cookie. cptr's password
never leaves its machine, and anyone signed in to the Hub is signed in to
cptr, which matches the Hub already gating that host UI. cptr's
`trusted_header` mode is deliberately not used: through the tunnel every
request reaches cptr from loopback, so any local process could claim a user.

Framing: the dashboard sends `frame-ancestors 'none'` and `X-Frame-Options:
DENY`. The host-UI origin may be framed only by itself (cptr frames its own
previews) and the dashboard, which embeds host UIs; the proxy drops a
backend's own `X-Frame-Options` and `frame-ancestors`. The embedded host UI
stays on the host-UI origin, so it still cannot read or drive the Hub API.

A cptr instance enrolled through the Worker connector is reached over a
byte-stream tunnel on the Worker's outbound connection, so the cptr machine
opens no inbound port. The Hub can only name an instance id: the Worker opens
streams solely to its own configured loopback cptr URL for its own cptr
instance id and rejects anything else, so a compromised Hub cannot use the
tunnel to reach other local ports. Streams close when the Worker disconnects.

Instances enrolled with `--link-only` are health-checked only; their tailnet
URL is returned to authenticated dashboard users as `launchUrl` (Codeman
endpoints are never returned), and the browser talks to cptr directly.

- The URL is a tailnet address the operator already owns; Tailscale ACLs still
  decide who can reach it.
- Folder-root policy is **not** enforced inside cptr, and a signed-in cptr user
  has full shell access on that machine. The dashboard says so on every
  link-mode host. Run cptr in Docker with only approved folders mounted when
  that matters.
- The Hub never alters cptr's UI or branding (its license forbids it) and does
  not bundle cptr.

## Release gates

- Revoke and reconnect tests pass.
- Unauthorized preview and browser requests are rejected.
- WebSocket/SSE relay disconnects cleanly and cannot outlive its lease.
- Duplicate job delivery is idempotent.
- Logs contain no provider keys, cookies, or authorization headers.
- UI password hashes are persisted instead of plaintext passwords, and login
  failures are rate limited.
- Release archives contain checksums and no source-tree secrets, provider
  credentials, or Tailscale identity.
- Stop-all and revoke-all operations work while nodes are online.
