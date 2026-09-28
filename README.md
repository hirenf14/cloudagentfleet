# Hosted Agents

Private multi-machine agent fleet control for Codeman, Cursor, and Claude Code.

Hosted Agents is a web overlay around Codeman. Codeman remains the local
execution plane for persistent terminal and CLI sessions; Hosted Agents adds
one Hub URL, fleet enrollment, host context, and routing.

One local server runs the Controller and web router. Direct Codeman hosts are
reached over Tailscale. A persistent Worker client is only needed as a fallback
for machines that cannot accept Controller-to-Codeman connections.

## Project shape

- `apps/control-plane` — private API, scheduler, persistence, and relay
- `apps/dashboard` — small fleet launcher and host context overlay
- `apps/cli` — guided machine setup, pairing, and health checks
- `apps/node-agent` — outbound-connected machine companion
- `packages/protocol` — shared messages and domain types

## Provider boundary

Cursor and Claude use separate hosted-agent control planes and credentials.
Hosted Agents integrates with both where their official worker/runner paths are
available. Codeman remains the fallback/local execution plane for persistent
CLI sessions.

## Machine setup

The onboarding entry point is:

```bash
hosted-agents setup
```

The setup flow detects prerequisites, asks before installing Codeman, lets you
select approved folders or whole-system access, discovers workspaces, and can
start the real Worker:

```bash
node apps/cli/bin/hosted-agents.mjs setup --run
```

The Worker enrolls over an outbound SSE/HTTP transport and executes fallback
jobs through Codeman's supported `/api/v1/sessions` API. Direct Tailscale mode
does not require the Worker for browser terminal traffic.

To register a Codeman instance with the Controller:

```bash
hosted-agents enroll connector --controller-url https://controller.example.test \
  --instance-id codeman-linux-1 --name "Linux Codeman" --node-id worker-linux-1
```

Use `hosted-agents enroll tailscale-url --url https://codeman.tailnet.ts.net`
for the preferred direct mode. The Controller keeps the endpoint and optional
Codeman credentials server-side, then proxies Codeman's native UI, REST, SSE,
and terminal WebSocket through the Hub. Enrollment verifies Hub health, reads
the optional Controller token from `HOSTED_AGENTS_AUTH_TOKEN`, and does not
automate Tailscale Serve.

To link another machine, repeat the Worker setup on that machine and give it a
unique Worker/instance ID. Connector mode is the recommended path:

```bash
# On machine B
node apps/cli/bin/hosted-agents.mjs setup --run
node apps/cli/bin/hosted-agents.mjs enroll connector \
  --controller-url http://<hub-host>:8787 \
  --instance-id codeman-machine-b \
  --name "Codeman Machine B" \
  --node-id worker-machine-b
```

Each session is shown under its instance and includes its agent, workspace, and
short stable session ID. Direct hosts open Codeman's own UI through the
`Open Codeman UI` action; the terminal implementation, local echo, ANSI/TUI
handling, and input semantics remain upstream Codeman behavior.

The unified "Start a session" dialog supports either a discovered workspace or
an explicit path. Explicit paths are accepted only inside the instance's
configured folder roots; use `--workspace-mode system` during enrollment when
whole-system path selection is intentionally required.

## Private Hub access with Tailscale Serve

The Controller is one private Hub for the fleet and binds to `127.0.0.1` by
default. After starting it with:

```bash
pnpm --filter @hosted-agents/control-plane dev
```

configure one tailnet route from a second terminal:

```bash
node apps/cli/bin/hosted-agents.mjs hub serve
```

This checks the installed, connected Tailscale CLI and the local Hub health
endpoint, then serves only `http://127.0.0.1:8787` through Tailscale. It does
not expose Codeman instances or create per-instance public domains. Use
`hosted-agents hub status` to inspect the route and `hosted-agents hub stop` to
reset Tailscale Serve routes. Restrict access with Tailscale ACLs and do not
enable Funnel. The command rejects non-loopback Controller binds and does not
use a shell to invoke Tailscale.

See [`docs/TAILSCALE-SERVE.md`](docs/TAILSCALE-SERVE.md) for Windows
PowerShell commands, alternate ports, and the complete security checklist.

For a repeatable two-host validation flow, run the explicit mock or live
harness documented in [`docs/MULTIHOST-E2E.md`](docs/MULTIHOST-E2E.md).

## Run a Codeman Worker locally

Install Codeman using its official installer, start `codeman web`, and then
start our Worker with the environment described in
[`docs/CODEMAN-WORKER.md`](docs/CODEMAN-WORKER.md). Codeman remains responsible
for tmux, PTYs, CLI credentials, terminal streaming, and durable sessions; this
project owns worker enrollment, workspace policy, routing, and job lifecycle.

## Install without the source tree

Maintainers can publish the built package with:

```bash
npm install
npm run build:release
npm publish
```

Operators can install the CLI globally and run guided setup:

```bash
npm install --global hosted-agents
hosted-agents setup
hosted-agents worker install
hosted-agents worker start
```

The release workflow also produces platform archives containing a private Node
runtime and a `hosted-agents` launcher. Unix archives provide `install.sh`;
Windows archives provide `install.ps1` and `hosted-agents.cmd`. The release
does not bundle Codeman, Claude credentials, Cursor credentials, or Tailscale
identity.

## Status

The repository contains the web overlay, Controller routing, native Codeman
proxy, optional Worker fallback, and tested two-host Codeman execution path.
Preview relay, remote browser, and official Cursor/Claude adapters remain on
the roadmap in `docs/ROADMAP.md`.
