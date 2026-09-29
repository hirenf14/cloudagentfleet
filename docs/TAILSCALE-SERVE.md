# Private Tailscale access (SSH first, Serve later)

Hosted Agents uses Tailscale for private machine reachability. The current
setup phase is **SSH over a dedicated port only**. Ports **80 and 443 stay
untouched**: do not run `tailscale serve`, Funnel, or any Hosted Agents
listener on them.

The Hub web UI and `cloudagentfleet hub serve` are optional and deferred until
you explicitly want a browser origin.

## Current phase: SSH only

Goals:

- Shared tailnet for operators and hosts
- Access only via SSH on a **separate** TCP port (default example: `2222`)
- Leave host `:80` / `:443` free for other software
- No Hub UI / MagicDNS HTTPS yet

### Prerequisites

- Install Tailscale on each machine and confirm `tailscale status` is connected.
- Run `sshd` on the dedicated port (example `2222`), not on 80/443.
- Do **not** run `cloudagentfleet hub serve` or `tailscale serve` in this phase.
- Do **not** enable Tailscale Funnel.

### ACL / grants (SSH port only)

Tailscale ACLs apply only to **tailnet** traffic. They do not close LAN or
loopback ports. Once you replace the default allow-all policy, unlisted
tailnet ports are deny-by-default — so list only the SSH port you intend.

Do **not** grant `tcp:80` or `tcp:443` for Hosted Agents in this phase.

```json
{
  "tagOwners": {
    "tag:hosted-agents-host": ["autogroup:admin"]
  },
  "grants": [
    {
      "src": ["group:hosted-agents-operators"],
      "dst": ["tag:hosted-agents-host"],
      "ip": ["tcp:2222", "icmp:*"]
    }
  ]
}
```

Equivalent ACL shape:

```json
{
  "tagOwners": {
    "tag:hosted-agents-host": ["autogroup:admin"]
  },
  "acls": [
    {
      "action": "accept",
      "src": ["group:hosted-agents-operators"],
      "dst": ["tag:hosted-agents-host:2222"]
    }
  ]
}
```

Tag each machine that should accept operator SSH as `tag:hosted-agents-host`.
Change `2222` to whatever dedicated SSH port you configure in `sshd`. If you
prefer standard SSH, use `tcp:22` / `:22` instead — still omit 80 and 443.

Connect:

```bash
ssh -p 2222 user@machine-name.tailnet-name.ts.net
```

## Later (optional): Hub UI via Tailscale Serve

Only when you want the browser Hub. Serve publishes MagicDNS HTTPS on the
node’s Tailscale HTTPS endpoint (typically 443 on the **tailnet** name). That
is separate from leaving the machine’s ordinary 80/443 services alone, but it
still competes with other Tailscale Serve/Funnel routes on that node. Prefer
keeping this off until the SSH fleet path is stable.

### Prerequisites for Serve

- Controller bound to loopback (`HOSTED_AGENTS_HOST=127.0.0.1`).
- Hub password via `HOSTED_AGENTS_UI_PASSWORD_HASH` or `HOSTED_AGENTS_UI_PASSWORD`.
- No Funnel.
- Operators reach only the Hub tag; Hub reaches Codeman hosts. Operators do
  not get a direct Codeman grant.

### Example grants when enabling Serve later

Add Hub/Codeman tags and grants **without removing** the SSH grant, and
**without** putting Hosted Agents on host-local 80/443 listeners. Serve
proxies loopback (for example `127.0.0.1:8787`); the Controller does not bind
`:80` or `:443`.

```json
{
  "tagOwners": {
    "tag:hosted-agents-hub": ["autogroup:admin"],
    "tag:codeman-host": ["autogroup:admin"],
    "tag:hosted-agents-host": ["autogroup:admin"]
  },
  "grants": [
    {
      "src": ["group:hosted-agents-operators"],
      "dst": ["tag:hosted-agents-host"],
      "ip": ["tcp:2222", "icmp:*"]
    },
    {
      "src": ["group:hosted-agents-operators"],
      "dst": ["tag:hosted-agents-hub"],
      "ip": ["tcp:443"]
    },
    {
      "src": ["tag:hosted-agents-hub"],
      "dst": ["tag:codeman-host"],
      "ip": ["tcp:3000"]
    }
  ]
}
```

### Start Serve (deferred)

```bash
pnpm --filter @hosted-agents/control-plane dev
cloudagentfleet hub serve
```

Equivalent Serve command:

```text
tailscale serve --bg http://127.0.0.1:8787
```

Custom Controller port:

```bash
HOSTED_AGENTS_HOST=127.0.0.1 HOSTED_AGENTS_PORT=9000 \
  pnpm --filter @hosted-agents/control-plane dev
cloudagentfleet hub serve --port 9000
```

### Hub password (Serve / Hub UI phase)

On first Hub start with a durable data directory and no password env vars, the
Controller generates a random UI password, stores it in `data/hub-ui-auth.json`,
and prints the plaintext on **every** start until you replace it.

```bash
# Optional override — stops printing the bootstrap password
export HOSTED_AGENTS_UI_PASSWORD='use-a-long-random-password'
# or
export HOSTED_AGENTS_UI_PASSWORD_HASH='scrypt$N$r$p$salt$hash'
```

Codeman Basic credentials stay server-side (`HOSTED_AGENTS_CODEMAN_CREDENTIALS`
or enroll-time `--username` / `--password`). They are never returned to the
browser.

### Inspect or stop Serve

```bash
cloudagentfleet hub status
cloudagentfleet hub stop
```

`hub stop` runs `tailscale serve reset` on this node. Use it only when this
node’s Serve routes are dedicated to Hosted Agents. It does not stop SSH,
the Controller process, or Codeman.
