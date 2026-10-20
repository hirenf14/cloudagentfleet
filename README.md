# Cloud Agent Fleet

Private multi-machine agent fleet control for Codeman, Cursor, and Claude Code.

Cloud Agent Fleet is a web overlay around Codeman. Codeman remains the local
execution plane for persistent terminal and CLI sessions; this project adds one
Hub URL, fleet enrollment, host context, and routing.

One local server runs the Controller and web router. Direct Codeman hosts are
reached over Tailscale. On each machine, the Worker installs and supervises
Codeman; its outbound connector is the fallback path for machines that cannot
accept Controller-to-Codeman connections.

Configuration lives in `~/.cloudagentfleet/`, and every environment variable
uses the `CLOUDAGENTFLEET_` prefix (see [`.env.example`](.env.example)).

## Requirements

- Node.js 22.6 or newer
- [pnpm](https://pnpm.io) (for development from source)
- Tailscale on each machine you want on the private fleet

## Install

Operators install **only the npm packages** — not this repository. Each package is
self-contained:

| Package | What you get |
| --- | --- |
| `@cloudagentfleet/hub` | One Hub CLI binary (`cloudagentfleet-hub`) |
| `@cloudagentfleet/ui` | Full Hub UI asset package (`public/…`) |
| `@cloudagentfleet/worker` | Operator CLI + Worker binaries |

```bash
npm install --global @cloudagentfleet/worker
cloudagentfleet --help
```

Hub host (Hub binary resolves UI from the installed `@cloudagentfleet/ui` package):

```bash
npm install --global @cloudagentfleet/hub @cloudagentfleet/ui
cloudagentfleet-hub
```

From a clone of this repository (developers only):

```bash
pnpm install
pnpm build:release
pnpm --filter @cloudagentfleet/worker link --global
pnpm --filter @cloudagentfleet/hub link --global
cloudagentfleet --help
cloudagentfleet-hub   # starts the Hub on 127.0.0.1:8787
```

## Machine setup

```bash
cloudagentfleet setup
```

To configure and start the Worker in one pass:

```bash
cloudagentfleet setup --run
```

The flow detects prerequisites, asks before installing Codeman on first setup,
lets you select approved folders or whole-system access, discovers workspaces,
and can start the Worker. The Worker manages Codeman under the hood by default
(install if missing, start if down; opt out with `manageCodeman: false` in
`~/.cloudagentfleet/worker.json` or `CLOUDAGENTFLEET_MANAGE_CODEMAN=false`). The
Worker enrolls over outbound SSE/HTTP and executes fallback jobs through
Codeman's `/api/v1/sessions` API. Direct Tailscale mode does not require the
Worker for browser terminal traffic.

On Windows, run setup from a normal (not WSL) terminal. Codeman needs tmux, so
it always runs in WSL; Open WebUI Computer runs natively on Windows by default
(setup asks), so it works with your Windows folders and tools:

| Backends | Where the Worker runs |
| --- | --- |
| `codeman` | WSL |
| `cptr` | Windows |
| `codeman,cptr` | Two Workers: `<id>` in WSL for Codeman, `<id>-windows` on Windows for cptr |

`cloudagentfleet run` starts both Workers and stops them together.

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
`CLOUDAGENTFLEET_AUTH_TOKEN`, and does not automate Tailscale Serve.

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
short stable session ID. Direct hosts open Codeman's own UI in a new tab
through **Open Codeman UI**; terminal behavior remains upstream Codeman.

The unified session dialog accepts a discovered workspace or an explicit path.
Explicit paths must fall inside the instance's configured folder roots; use
`--workspace-mode system` during enrollment only when whole-system path
selection is intentional.

## Add an Open WebUI Computer host

[Open WebUI Computer](https://openwebui.com/computer) (`cptr`) can sit next to
Codeman as an optional per-machine backend. In `cloudagentfleet setup`, answer
`cptr` or `codeman,cptr` at the backends prompt. Setup shows cptr's license,
offers to install it with pipx, uv, or pip (with your confirmation; with
`claude-agent-sdk` when Claude Code is installed), and asks how the Hub should
reach it. The Worker then keeps it running on loopback and writes the one-time
setup token to `~/.cloudagentfleet/cptr-setup-token` on its first start.

Each Worker connector instance names a **driver**: `codeman` (the default) or
`cptr`. With the cptr driver (setup's default), the Hub reaches cptr through
the Worker's existing outbound connection, so the cptr machine needs no
inbound port:

```bash
cloudagentfleet enroll connector \
  --backend cptr \
  --controller-url http://<hub-host>:8787 \
  --node-id laptop \
  --instance-id laptop-cptr \
  --name "Laptop (Open WebUI Computer)"
```

To reach cptr over the tailnet instead (you can also install and run cptr
yourself this way), publish it with Tailscale Serve and enroll its URL:

```bash
cloudagentfleet enroll tailscale-url \
  --backend cptr \
  --controller-url http://<hub-host>:8787 \
  --instance-id laptop-cptr \
  --name "Laptop (Open WebUI Computer)" \
  --url https://laptop.tailnet.ts.net
```

The Hub health-checks `/api/health`. **Open Open WebUI Computer UI** opens it in
a new tab through the Hub's host-UI origin, so it is reachable wherever the Hub
is; sign in once with cptr's own account (the Hub keeps that session separate
from its own cookies). cptr's editor, terminal, port previews, and agent chat
(Claude Code, Codex, Cursor, and others it detects on the machine) all work
through the Hub. On Windows, cptr's automatic port list relies on `wmic`, which
current Windows 11 builds no longer include; open a dev server in cptr's
Browser tab (`http://localhost:<port>`) instead. Add `--link-only` to a
tailscale-url instance to have the
dashboard open cptr's URL directly instead. Hub folder policy does not apply
inside cptr. Cloud Agent Fleet does not bundle or modify cptr; its use is
governed by the Open WebUI Computer license.

The Hub has two origins: the dashboard (`/_fleet/`, port 8787, served on 443)
and host UIs (port 8788, served on 8443). Backend UIs never run on the
dashboard origin, so they cannot use your Hub session to call the Hub API.

## Worker service

```bash
cloudagentfleet worker install
cloudagentfleet worker start
cloudagentfleet worker status
cloudagentfleet worker stop
cloudagentfleet worker remove
```

`worker install` records the PATH of the shell that runs it, so Codeman
sessions and cptr find `claude`, `codex`, and `agent` the way your shell does.
Reinstall the service after installing a new agent CLI somewhere else.

On Windows the service is a Task Scheduler task that starts at your logon and
needs no administrator rights. It runs without a window, restarts failed
Workers after 5 seconds, and writes their output to
`%USERPROFILE%\.cloudagentfleet\worker.log`.

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

```bash
cloudagentfleet setup --run
cloudagentfleet doctor
```

The Worker installs/starts Codeman when manage is on (default). Details are in
[`docs/CODEMAN-WORKER.md`](docs/CODEMAN-WORKER.md). Codeman owns tmux, PTYs, CLI
credentials, terminal streaming, and durable sessions; this project owns
enrollment, workspace policy, routing, and job lifecycle.

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

Release archives include a private Node runtime and compiled CLI bundles
(`cloudagentfleet`, `cloudagentfleet-worker`, `cloudagentfleet-hub`). After
extracting an archive, put the directory on your `PATH` (or invoke a launcher
by path) and run the same CLI commands — there is no separate install script.

The release does not bundle Codeman, Claude credentials, Cursor credentials, or
Tailscale identity.

## Project shape

- `@cloudagentfleet/hub` (`apps/control-plane`) — API, scheduler, persistence, Codeman proxy
- `@cloudagentfleet/ui` (`apps/dashboard`) — fleet launcher and host context overlay
- `@cloudagentfleet/worker` (`apps/node-agent` + CLI) — machine companion and operator CLI
- `apps/cli` — private CLI sources packaged into the worker release
- `packages/protocol` — private shared messages, domain types, and workspace policy
- `packages/host-adapters` — private backend adapter contract, registry, shared proxy/relay code, and the Codeman adapters

## Contributing

See [`CONTRIBUTING.md`](CONTRIBUTING.md).

## Status

The repository contains the web overlay, Controller routing, native Codeman
proxy, optional Worker fallback, and tested two-host Codeman execution path.
Preview relay, remote browser, and official Cursor/Claude adapters remain on
the roadmap in [`docs/ROADMAP.md`](docs/ROADMAP.md).
