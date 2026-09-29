# Two-host Codeman E2E

The repeatable harness has two explicit modes:

```powershell
# No Codeman install, provider login, network, or secrets required.
pnpm --filter @cloudagentfleet/hub test:multihost:mock

# Uses two already-running, real Codeman HTTP endpoints.
pnpm --filter @cloudagentfleet/hub test:multihost:live
```

The mock mode starts two isolated local Codeman-shaped HTTP/SSE servers and an
ephemeral loopback Hub. It registers both instances as `tailscale-url` records,
checks health, verifies one Hub URL lists both, creates one session on each,
sends input, observes output events, and stops both sessions. The mock servers
never start shells, agents, or provider processes.

The live mode starts the same ephemeral loopback Hub and performs the same
registration and session flow against two configured Codeman endpoints. It does
not install software, start Codeman, configure Tailscale Serve, or write
project/user configuration.

## Prerequisites

### All modes

- Node.js with support for `--experimental-strip-types` (Node 22.6 or newer).
- pnpm and the repository dependencies installed with `pnpm install`.
- Git is needed by the repository setup CLI, but not by the harness itself.

### Live mode

- Codeman is installed and already running on each host (`codeman web`).
- Each endpoint exposes Codeman's supported `/api/v1/status`,
  `/api/v1/sessions`, `/api/v1/sessions/:id/interactive`,
  `/api/v1/sessions/:id/input`, `/api/v1/sessions/:id`, and `/api/v1/events`
  APIs.
- The Codeman provider/agent selected by the session is installed and
  authenticated on that host. The harness defaults to the `claude` mode; it
  does not run `claude login`, `cursor` setup, or copy provider credentials.
- The Hub host can reach both endpoints. For Tailscale URL mode, install
  Tailscale, sign in to the intended tailnet, confirm `tailscale status` is
  connected, and use HTTPS tailnet URLs. Tailscale ACLs must restrict the Hub;
  do not enable Funnel.
- If Codeman Basic auth is enabled, provide a username and password for each
  endpoint through the environment below. They are read in memory only.

PowerShell configuration for live mode:

```powershell
$env:CODEMAN_URL_A = "https://codeman-a.<tailnet>.ts.net"
$env:CODEMAN_URL_B = "https://codeman-b.<tailnet>.ts.net"
$env:CODEMAN_WORKSPACE_A = "/home/operator/workspaces/project-a"
$env:CODEMAN_WORKSPACE_B = "/home/operator/workspaces/project-b"
# Optional, only when Basic auth is enabled:
# $env:CODEMAN_USERNAME_A = "operator"
# $env:CODEMAN_PASSWORD_A = "<machine-A-password>"
# $env:CODEMAN_USERNAME_B = "operator"
# $env:CODEMAN_PASSWORD_B = "<machine-B-password>"
pnpm --filter @cloudagentfleet/hub test:multihost:live
```

The workspace paths must be valid on their respective Codeman hosts. The
workspace and agent metadata used by this harness are explicit test inputs;
the current Codeman bridge does not discover workspaces from the provider API.

For the connector and browser path, start a Controller and Worker, enroll the
Worker as a `connector` instance, then verify this sequence through the single
Hub URL:

```text
load dashboard → choose Enter a path → receive policy-filtered suggestions
→ select a directory → create session → send command/Ctrl-C/clear
→ observe formatted ANSI output at the bottom → stop → remove
```

Connector suggestions are resolved on the Worker. Direct Tailscale instances
provide completion from their registered workspace metadata because Codeman's
documented HTTP API has no remote filesystem completion endpoint.

For the preferred direct Tailscale/native UI path, verify this sequence:

```text
login with Hub password → open a registered host → native Codeman UI loads
→ /api/v1 requests stay on that host → /ws/sessions/:id/terminal connects
→ terminal input/output/resize remain native → switch host → no session bleed
```

The browser must never receive a Codeman endpoint or Basic credential. The
Controller owns those values and strips upstream cookies while proxying.

## CLI and Hub flow

For the supported interactive CLI flow, start the Controller first:

```powershell
$env:HOSTED_AGENTS_HOST = "127.0.0.1"
$env:HOSTED_AGENTS_PORT = "8787"
pnpm --filter @cloudagentfleet/hub dev
```

Then use either:

```text
cloudagentfleet enroll connector ...
cloudagentfleet enroll tailscale-url ...
```

Connector mode requires an online Worker with the same instance ID. Direct
Tailscale URL mode requires an HTTPS Codeman endpoint and performs health
verification through the Controller. To publish the single private Hub, use
`cloudagentfleet hub serve`; this requires a connected Tailscale CLI and does
not publish individual Codeman endpoints.

The harness intentionally uses direct HTTP registration rather than the
interactive CLI so it cannot overwrite `~/.hosted-agents/instances.json` or a
Worker configuration while testing.

## Evidence and blockers

A successful run prints separate `[mock]` or `[live]` evidence for the
two-instance list and the create/input/output/stop flow. A live failure before
the first line identifies the missing environment variable; a health or event
failure identifies the Codeman URL/API/network boundary. The next command is
then to start the missing `codeman web`, sign in Tailscale, correct the
workspace path, or provide the required Basic-auth variables.

The browser smoke test should additionally record that `.xterm` is mounted,
the terminal contains no literal escape sequences in rendered text, its
scroll position follows the newest output, and the path suggestion list is
bounded to the Worker policy.

## Production release checks

- `tailscale-url` registration accepts only HTTPS `*.ts.net` names or
  Tailscale `100.64.0.0/10` addresses (loopback is allowed for local tests).
  Keep the allowlist aligned with the tailnet's actual Codeman hosts.
- Tailscale membership is only a network boundary. Keep the Controller bearer
  token enabled for Worker calls, require the Hub UI password, enforce
  Tailscale ACLs, and never use Funnel for this Hub.
- Pairing, per-node identity keys, and signed/replay-protected Worker messages
  are still roadmap items. Do not treat the current bearer-token connector as
  production-grade machine identity.
