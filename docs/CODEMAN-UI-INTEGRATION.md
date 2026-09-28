# Codeman UI integration

Hosted Agents uses Codeman's own web UI and terminal transport rather than
maintaining a second terminal implementation.

## Browser flow

1. Open the Hub through Tailscale Serve.
2. Authenticate with the Hub UI password.
3. Select a registered Tailscale Codeman host.
4. Hosted Agents stores the selected instance in a short-lived, HttpOnly
   cookie.
5. The Hub proxies that host's Codeman HTML, REST, SSE, and WebSocket traffic.
6. The upstream Codeman page loads its own xterm.js, local-echo overlay,
   terminal protocol, and feature panels.

The native Codeman terminal WebSocket is exposed through the Hub as:

```text
/ws/sessions/:sessionId/terminal
```

The Hub resolves the selected host from the server-side cookie and forwards
the WebSocket handshake and frames to that host's native Codeman endpoint. A
host-explicit route is also available for integrations:

```text
/ws/instances/:instanceId/sessions/:sessionId/terminal
```

Terminal frames are not parsed, batched, normalized, or rewritten by Hosted
Agents. This preserves Codeman's local echo, input acknowledgements, resize
messages, synchronized TUI updates, and reconnect behavior.

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
3. Run the Hosted Agents adapter and two-host browser tests.
4. Roll back the Codeman host if compatibility checks fail.

Hosted Agents must not modify Codeman's PTY, tmux, provider, or terminal
modules. A Codeman fork should only be introduced when an upstream-supported
hook is proven insufficient.
