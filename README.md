# Cloud Agent Fleet

One private dashboard for the coding agents on all your machines: Claude Code,
Cursor, and others, through Codeman and Open WebUI Computer.

The **Hub** is the dashboard. On each machine a **Worker** connects out to it
(no open ports) and runs that machine's backends: **Codeman** for terminal
sessions you start and watch from the dashboard, and **Open WebUI Computer**
for a full workspace (files, editor, terminal, previews, agent chat) shown
inside the dashboard. The Hub is reached privately over Tailscale.

Configuration lives in `~/.cloudagentfleet/`, and every environment variable
uses the `CLOUDAGENTFLEET_` prefix (see [`.env.example`](.env.example)).

## Get started

Pick one install per machine. Each is standalone, and its guided setup also
installs Codeman, Open WebUI Computer, and the coding agents you choose.

| You want | npm (Node.js 22.6+) | Or a [release archive](https://github.com/hirenf14/cloudagentfleet/releases/latest) (Node.js included) |
| --- | --- | --- |
| Everything on one machine | `npm install --global @cloudagentfleet/all-in-one` | `cloudagentfleet-<os>-<arch>` |
| The Hub (dashboard) | `npm install --global @cloudagentfleet/hub` | `cloudagentfleet-hub-<os>-<arch>` |
| A machine to add | `npm install --global @cloudagentfleet/worker` | `cloudagentfleet-worker-<os>-<arch>` |

Then:

```bash
cloudagentfleet init
```

`init` asks what this machine runs (Hub, Worker, or both) and what it should
offer (Codeman, Open WebUI Computer, Claude Code CLI, Cursor Agent CLI), shows
every install command, installs them after one confirmation, runs the Hub and
Worker as user services (no administrator rights), enrolls the machine, and
prints the dashboard address and password. It is safe to rerun.

**[Read the getting-started guide](docs/GETTING-STARTED.md)** for the full
walkthrough, Windows notes, everyday commands, and troubleshooting. The
dashboard has the same steps built in (**Getting started**, **+ Add machine**,
and **?** for help).

Tailscale on each machine is recommended so the Hub is reachable from your
other devices without opening ports.

On Windows, Codeman runs in WSL (it needs tmux) and Open WebUI Computer runs
natively by default, so it works with your Windows folders:

| Offers | Where the Worker runs |
| --- | --- |
| Codeman | WSL |
| Open WebUI Computer | Windows |
| Both | Two Workers: `<id>` in WSL for Codeman, `<id>-windows` on Windows for cptr |

## Manual enrollment (advanced)

`init` enrolls a machine for you. To register an instance by hand (for example
a Codeman that is reachable directly over the tailnet), use `enroll`:

```bash
cloudagentfleet enroll connector \
  --controller-url https://hub.tailnet.ts.net \
  --instance-id codeman-linux-1 \
  --name "Linux Codeman" \
  --node-id worker-linux-1
```

Direct mode:

```bash
cloudagentfleet enroll tailscale-url \
  --controller-url https://hub.tailnet.ts.net \
  --instance-id codeman-remote \
  --name "Remote Codeman" \
  --url https://codeman.tailnet.ts.net
```

The Hub keeps the endpoint and optional Codeman credentials server-side, then
proxies Codeman's native UI, REST, SSE, and terminal WebSocket. Enrollment
verifies health and reads the Worker token from `CLOUDAGENTFLEET_AUTH_TOKEN`
(`cloudagentfleet hub token` prints it on the Hub machine).

Each session is shown under its machine with its agent, workspace, and short
session ID. The session dialog accepts a discovered workspace or an explicit
path inside the machine's approved folders; enroll with
`--workspace-mode system` only when whole-system access is intentional.

## Add an Open WebUI Computer host

[Open WebUI Computer](https://openwebui.com/computer) (`cptr`) can sit next to
Codeman as an optional per-machine backend. Pick it in `cloudagentfleet init`
(or answer `cptr` or `codeman,cptr` at the backends prompt of `setup`). Setup shows cptr's license,
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

The Hub health-checks `/api/health`. **Open Open WebUI Computer UI** shows it
inside the dashboard (or in its own tab with **Open in new tab**), served from
the Hub's host-UI origin, so it is reachable wherever the Hub is. With the
connector driver, signing in to the Hub signs you in to cptr too: on cptr's
first start the Worker creates a `fleet` account and keeps its password in
`~/.cloudagentfleet/cptr-credentials.json` (owner-only), and the Hub asks the
Worker for a cptr session when your browser has none. The password never
leaves that machine. For a cptr you set up yourself, put its account in that
file as `{"username": "...", "password": "..."}`; otherwise cptr shows its own
login. Over the tailnet (`tailscale-url`) you sign in to cptr yourself. cptr's
editor, terminal, port previews, and agent chat
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

## Services

`init` installs these; you can also manage them directly:

```bash
cloudagentfleet hub service <install|start|status|stop|remove>
cloudagentfleet worker <install|start|status|stop|remove>
```

Both are user-level services (systemd user unit, launchd agent, or a Windows
Task Scheduler task that starts at your logon) and need no administrator
rights. The Hub keeps its state in `~/.cloudagentfleet/` (`hub-config.json`
holds its port and address). `worker install` records the PATH of the shell
that runs it, so Codeman sessions and cptr find `claude`, `codex`, and
`agent` the way your shell does; reinstall the service after installing a new
agent CLI somewhere else.

On Windows the tasks run without a window, restart a failed Hub or Worker
after 5 seconds, and write their output to `hub.log` and `worker.log` in
`%USERPROFILE%\.cloudagentfleet\`. `stop` ends every process the service
started.

## Private Hub access with Tailscale Serve

`init` offers this. To publish (or stop publishing) the loopback Hub yourself:

```bash
cloudagentfleet hub serve
cloudagentfleet hub status
cloudagentfleet hub stop
```

The Hub binds to `127.0.0.1` by default. `hub serve` checks the Tailscale CLI
and local Hub health, then serves only the Hub (443 for the dashboard, 8443
for host UIs). It does not expose Codeman instances or create per-instance
public domains. Restrict access with Tailscale ACLs and do not enable Funnel.
The command rejects non-loopback Hub binds.

See [`docs/TAILSCALE-SERVE.md`](docs/TAILSCALE-SERVE.md) for ACL examples,
alternate ports, and the security checklist. For a two-host validation flow,
see [`docs/MULTIHOST-E2E.md`](docs/MULTIHOST-E2E.md).

## Release archives and packages

Maintainers publish `@cloudagentfleet/hub`, `@cloudagentfleet/worker`,
`@cloudagentfleet/all-in-one`, and `@cloudagentfleet/ui` (the dashboard files
alone, for custom hosting; the Hub already includes them) through Changesets
(see [`CONTRIBUTING.md`](CONTRIBUTING.md#releases)).

Each release attaches three archives per platform (hub, worker, all-in-one).
Each carries a private Node runtime, its launchers (`cloudagentfleet`, and
`cloudagentfleet-hub` where included), a `README.txt` with first steps, a
`release-manifest.json`, and `SHA256SUMS`. Extract, put the folder on your
`PATH`, and run `cloudagentfleet init`; there is no separate install script.

Releases do not bundle Codeman, Open WebUI Computer, provider credentials, or
Tailscale identity; `init` installs the tools you pick with their official
installers, and provider logins stay yours.

From a clone (developers):

```bash
pnpm install
pnpm build:release        # npm package contents
pnpm package:standalone   # this platform's three archives in dist/standalone/
pnpm --filter @cloudagentfleet/hub dev   # Hub from source on 127.0.0.1:8787
```

## Project shape

- `@cloudagentfleet/hub` (`apps/control-plane`) — API, scheduler, persistence, proxies; ships the UI and the CLI
- `@cloudagentfleet/ui` (`apps/dashboard`) — fleet launcher and host context overlay
- `@cloudagentfleet/worker` (`apps/node-agent` + CLI) — machine companion and operator CLI
- `@cloudagentfleet/all-in-one` (`apps/all-in-one`) — the Hub, UI, Worker, and CLI in one install
- `apps/cli` — private CLI sources (`init`, `setup`, services) packaged into every install
- `packages/protocol` — private shared messages, domain types, and workspace policy
- `packages/host-adapters` — private backend adapter contract, registry, shared proxy/relay code, and the Codeman adapters

## Contributing

See [`CONTRIBUTING.md`](CONTRIBUTING.md).

## Status

The repository contains the web overlay, Controller routing, native Codeman
proxy, optional Worker fallback, and tested two-host Codeman execution path.
Preview relay, remote browser, and official Cursor/Claude adapters remain on
the roadmap in [`docs/ROADMAP.md`](docs/ROADMAP.md).
