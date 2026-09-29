# Cloud Agent Fleet

Private multi-machine agent fleet control for Codeman, Cursor, and Claude Code.

Cloud Agent Fleet is a web overlay around Codeman. Codeman remains the local
execution plane for persistent terminal and CLI sessions; this project adds one
Hub URL, fleet enrollment, host context, and routing.

One local server runs the Controller and web router. Direct Codeman hosts are
reached over Tailscale. A persistent Worker is only needed as a fallback for
machines that cannot accept Controller-to-Codeman connections.

## Requirements

- Node.js 22.6 or newer
- [pnpm](https://pnpm.io) (for development from source)
- Tailscale on each machine you want on the private fleet

## Install

Public npm packages:

| Package | Role | Binary |
| --- | --- | --- |
| `@cloudagentfleet/hub` | Control plane | `cloudagentfleet-hub` |
| `@cloudagentfleet/ui` | Hub UI assets | (dependency of Hub) |
| `@cloudagentfleet/worker` | Machine companion + operator CLI | `cloudagentfleet`, `cloudagentfleet-worker` |

```bash
npm install --global @cloudagentfleet/worker
cloudagentfleet --help
```

Hub host:

```bash
npm install --global @cloudagentfleet/hub @cloudagentfleet/ui
cloudagentfleet-hub
```

From a clone of this repository:

```bash
pnpm install
pnpm --filter @cloudagentfleet/worker link --global
pnpm --filter @cloudagentfleet/hub link --global
cloudagentfleet --help
cloudagentfleet-hub --help
```

`hosted-agents` remains a compatibility alias for the worker CLI.

## Machine setup

```bash
cloudagentfleet setup
```

To configure and start the Worker in one pass:

```bash
cloudagentfleet setup --run
```

The flow detects prerequisites, asks before installing Codeman, lets you select
approved folders or whole-system access, discovers workspaces, and can start
the Worker. The Worker enrolls over outbound SSE/HTTP and executes fallback
jobs through Codeman's `/api/v1/sessions` API. Direct Tailscale mode does not
require the Worker for browser terminal traffic.

## Enroll a Codeman host

```bash
cloudagentfleet enroll connector \
  --controller-url https://controller.example.test \
  --instance-id codeman-linux-1 \
  --name "Linux Codeman" \
  --node-id worker-linux-1
```

Preferred direct mode:

```bash
cloudagentfleet enroll tailscale-url \
  --controller-url https://controller.example.test \
  --instance-id codeman-remote \
  --name "Remote Codeman" \
  --url https://codeman.tailnet.ts.net
```

The Controller keeps the endpoint and optional Codeman credentials server-side,
then proxies Codeman's native UI, REST, SSE, and terminal WebSocket through the
Hub. Enrollment verifies Hub health, reads the optional Controller token from
`HOSTED_AGENTS_AUTH_TOKEN`, and does not automate Tailscale Serve.

To link another machine, repeat setup on that host with a unique Worker and
instance ID:

```bash
cloudagentfleet setup --run
cloudagentfleet enroll connector \
  --controller-url http://<hub-host>:8787 \
  --instance-id codeman-machine-b \
  --name "Codeman Machine B" \
  --node-id worker-machine-b
```

Each session is shown under its instance and includes its agent, workspace, and
short stable session ID. Direct hosts open Codeman's own UI through
**Open Codeman UI**; terminal behavior remains upstream Codeman.

The unified session dialog accepts a discovered workspace or an explicit path.
Explicit paths must fall inside the instance's configured folder roots; use
`--workspace-mode system` during enrollment only when whole-system path
selection is intentional.

## Worker service

```bash
cloudagentfleet worker install
cloudagentfleet worker start
cloudagentfleet worker status
cloudagentfleet worker stop
cloudagentfleet worker remove
```

## Private Hub access with Tailscale Serve

Start the Controller on the Hub host (from a clone):

```bash
pnpm --filter @cloudagentfleet/hub dev
```

Then publish only the loopback Hub through Tailscale:

```bash
cloudagentfleet hub serve
cloudagentfleet hub status
cloudagentfleet hub stop
```

The Hub binds to `127.0.0.1` by default. `hub serve` checks the Tailscale CLI
and local Hub health, then serves only `http://127.0.0.1:8787`. It does not
expose Codeman instances or create per-instance public domains. Restrict access
with Tailscale ACLs and do not enable Funnel. The command rejects non-loopback
Controller binds.

See [`docs/TAILSCALE-SERVE.md`](docs/TAILSCALE-SERVE.md) for ACL examples,
alternate ports, and the security checklist. For a two-host validation flow,
see [`docs/MULTIHOST-E2E.md`](docs/MULTIHOST-E2E.md).

## Run a Codeman Worker locally

Install Codeman with its official installer, start `codeman web`, then use:

```bash
cloudagentfleet setup --run
cloudagentfleet doctor
```

Details are in [`docs/CODEMAN-WORKER.md`](docs/CODEMAN-WORKER.md). Codeman owns
tmux, PTYs, CLI credentials, terminal streaming, and durable sessions; this
project owns enrollment, workspace policy, routing, and job lifecycle.

## Install without the source tree

Maintainers publish the three packages through Changesets (see
[`CONTRIBUTING.md`](CONTRIBUTING.md#releases)). Operators install from npm:

```bash
npm install --global @cloudagentfleet/worker
cloudagentfleet setup
cloudagentfleet worker install
cloudagentfleet worker start
```

```bash
npm install --global @cloudagentfleet/hub @cloudagentfleet/ui
cloudagentfleet-hub
```

Release archives include a private Node runtime and a `cloudagentfleet`
launcher. After extracting an archive, put the directory on your `PATH` (or
invoke the launcher by path) and run the same CLI commands — there is no
separate install script.

The release does not bundle Codeman, Claude credentials, Cursor credentials, or
Tailscale identity.

## Project shape

- `@cloudagentfleet/hub` (`apps/control-plane`) — API, scheduler, persistence, Codeman proxy
- `@cloudagentfleet/ui` (`apps/dashboard`) — fleet launcher and host context overlay
- `@cloudagentfleet/worker` (`apps/node-agent` + CLI) — machine companion and operator CLI
- `apps/cli` — private CLI sources packaged into the worker release
- `packages/protocol` — private shared messages and domain types

## Contributing

See [`CONTRIBUTING.md`](CONTRIBUTING.md).

## Status

The repository contains the web overlay, Controller routing, native Codeman
proxy, optional Worker fallback, and tested two-host Codeman execution path.
Preview relay, remote browser, and official Cursor/Claude adapters remain on
the roadmap in [`docs/ROADMAP.md`](docs/ROADMAP.md).
