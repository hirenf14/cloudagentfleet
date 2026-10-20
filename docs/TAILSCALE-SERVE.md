# Private access with Tailscale

Cloud Agent Fleet is reachable only over your tailnet. The browser reaches the
Hub through Tailscale Serve on two HTTPS ports: 443 for the dashboard and 8443
for proxied host UIs (a separate origin, so backend pages can't use your Hub
session against the Hub API). The Hub reaches hosts over the tailnet. Nothing
is published with Funnel, and Cloud Agent Fleet never binds host-local `:80`
or `:443`.

```text
Browser → Serve :443  → Controller dashboard on 127.0.0.1:8787
Browser → Serve :8443 → Controller host UIs  on 127.0.0.1:8788 → tailnet → hosts
```

## Hub UI via Tailscale Serve

### Prerequisites

- Tailscale installed and connected on the Hub node (`tailscale status`).
- Controller bound to loopback (`CLOUDAGENTFLEET_HOST=127.0.0.1`, the default).
- Funnel disabled.
- Operators reach only the Hub tag; the Hub reaches Codeman hosts. Operators
  get no direct Codeman grant.

Serve publishes MagicDNS HTTPS on the node's Tailscale endpoint (typically 443
on the **tailnet** name). That is separate from the machine's ordinary 80/443
services, but it shares the node's Serve configuration with any other Serve
routes.

### Start Serve

```bash
cloudagentfleet-hub          # or, from a clone: pnpm --filter @cloudagentfleet/hub dev
cloudagentfleet hub serve
```

`hub serve` checks the Tailscale CLI and local Hub health, then serves only the
loopback Hub. Equivalent Serve command:

```text
tailscale serve --bg http://127.0.0.1:8787
```

Custom Controller port:

```bash
CLOUDAGENTFLEET_HOST=127.0.0.1 CLOUDAGENTFLEET_PORT=9000 cloudagentfleet-hub
cloudagentfleet hub serve --port 9000
```

The command rejects non-loopback Controller binds.

### Hub password

On first start with a durable data directory and no password env vars, the
Controller generates a random UI password, stores it in `data/hub-ui-auth.json`,
and prints the plaintext on **every** start until you replace it.

```bash
# Optional override — stops printing the bootstrap password
export CLOUDAGENTFLEET_UI_PASSWORD='use-a-long-random-password'
# or
export CLOUDAGENTFLEET_UI_PASSWORD_HASH='scrypt$N$r$p$salt$hash'
```

### Worker token

Workers authenticate with a bearer token, separate from the UI password. When
`CLOUDAGENTFLEET_AUTH_TOKEN` is unset and the Hub has a durable data
directory, the Hub generates one in `<data dir>/hub-worker-token` (owner-only)
and logs only that path. Give its contents to `cloudagentfleet setup` (it asks
for the Hub Worker token) or set `CLOUDAGENTFLEET_AUTH_TOKEN` on both sides.
Delete the file and restart the Hub to rotate it, then rerun setup on each
Worker.

Codeman Basic credentials stay server-side (`CLOUDAGENTFLEET_CODEMAN_CREDENTIALS`
or enroll-time `--username` / `--password`). They are never returned to the
browser.

### Grants

Tailscale ACLs apply only to **tailnet** traffic; they do not close LAN or
loopback ports. Once you replace the default allow-all policy, unlisted tailnet
ports are deny-by-default, so list only what you intend.

```json
{
  "tagOwners": {
    "tag:cloudagentfleet-hub": ["autogroup:admin"],
    "tag:codeman-host": ["autogroup:admin"]
  },
  "grants": [
    {
      "src": ["group:cloudagentfleet-operators"],
      "dst": ["tag:cloudagentfleet-hub"],
      "ip": ["tcp:443", "tcp:8443"]
    },
    {
      "src": ["tag:cloudagentfleet-hub"],
      "dst": ["tag:codeman-host"],
      "ip": ["tcp:3000"]
    }
  ]
}
```

Change `3000` if Codeman listens elsewhere.

### Inspect or stop Serve

```bash
cloudagentfleet hub status
cloudagentfleet hub stop
```

`hub stop` runs `tailscale serve reset` on this node. Use it only when this
node's Serve routes are dedicated to Cloud Agent Fleet. It does not stop SSH,
the Controller process, or Codeman.

## Optional: operator SSH on a dedicated port

For shell access to fleet machines, run `sshd` on a dedicated port (example
`2222`) and grant only that port. Add this grant next to the Hub grants above.

```json
{
  "tagOwners": {
    "tag:cloudagentfleet-host": ["autogroup:admin"]
  },
  "grants": [
    {
      "src": ["group:cloudagentfleet-operators"],
      "dst": ["tag:cloudagentfleet-host"],
      "ip": ["tcp:2222", "icmp:*"]
    }
  ]
}
```

Equivalent ACL shape:

```json
{
  "tagOwners": {
    "tag:cloudagentfleet-host": ["autogroup:admin"]
  },
  "acls": [
    {
      "action": "accept",
      "src": ["group:cloudagentfleet-operators"],
      "dst": ["tag:cloudagentfleet-host:2222"]
    }
  ]
}
```

Tag each machine that should accept operator SSH as `tag:cloudagentfleet-host`.
To use standard SSH, grant `tcp:22` instead.

```bash
ssh -p 2222 user@machine-name.tailnet-name.ts.net
```

## Security checklist

- Hub bound to `127.0.0.1`; only Serve reaches it.
- Hub password set (or the bootstrap password stored and rotated).
- Funnel off on every fleet node.
- Operators granted the Hub tag only, never Codeman ports.
- Codeman hosts accept the Codeman port only from `tag:cloudagentfleet-hub`.
