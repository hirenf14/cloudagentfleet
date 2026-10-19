# Codeman UI integration

Cloud Agent Fleet uses Codeman's own web UI and terminal transport rather than
maintaining a second terminal implementation.

## Browser flow

1. Open the Hub through Tailscale Serve; the dashboard lives at `/_fleet/`.
2. Authenticate with the Hub UI password.
3. Choose **Open Codeman UI** on a Tailscale Codeman host. A new tab opens
   `/_fleet/api/fleet/select/:id`, which stores the selected instance in an
   HttpOnly cookie.
4. Every path outside `/_fleet/` on the Hub origin now belongs to that host:
   the Hub proxies its HTML, REST, SSE, and WebSocket traffic.
5. The upstream Codeman page loads its own xterm.js, local-echo overlay,
   terminal protocol, and feature panels. The Hub injects a fleet bar
   (`/_fleet/fleet-host-switcher.js`) to switch hosts or return to the
   dashboard.

Codeman's native WebSockets, such as `/ws/sessions/:sessionId/terminal`, are
forwarded generically to the selected host. The dashboard's own terminal route
is host-explicit and Hub-owned:

```text
/_fleet/ws/instances/:instanceId/sessions/:sessionId/terminal
```

Terminal frames are not parsed, batched, normalized, or rewritten by Cloud
Agent Fleet. This preserves Codeman's local echo, input acknowledgements,
resize messages, synchronized TUI updates, and reconnect behavior.

## Routing contract

- `/_fleet/...` is always the Hub.
- With a selected-host cookie, every other path is the host's native UI.
  Backends may use any path, including `/api/auth`.
- Without that cookie (Workers, the CLI), unprefixed `/api/...`, `/ws/...`,
  and `/healthz` remain the Hub's routes, so installed Workers keep working.
- Every mutating request, Hub or proxied, must come from the Hub origin, and
  every proxied request requires a Hub session.

## Host connectivity

The preferred path is direct Controller-to-Codeman connectivity over the
tailnet:

```text
Browser → Tailscale Serve → Controller → Tailscale → Codeman
```

Codeman remains bound to its machine and is not published as a separate public
site. Tailscale ACLs should allow only the Controller to reach each Codeman
port. The Worker connector remains a fallback for machines where the
Controller cannot initiate a tailnet connection.

## Updating Codeman

The Hub depends on Codeman's documented `/api/v1` surface and its native
terminal WebSocket. Codeman should be updated independently:

1. Update Codeman using its official installer or release process.
2. Verify `/api/v1/status` and the terminal WebSocket on the host.
3. Run the Cloud Agent Fleet adapter and two-host browser tests.
4. Roll back the Codeman host if compatibility checks fail.

Cloud Agent Fleet must not modify Codeman's PTY, tmux, provider, or terminal
modules. A Codeman fork should only be introduced when an upstream-supported
hook is proven insufficient.
