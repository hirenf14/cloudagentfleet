# Codeman Worker

The Worker is the machine-local execution side of Cloud Agent Fleet. It does not
open an inbound listener. It enrolls with the Controller, consumes assignments
over an outbound Server-Sent Events stream, and posts lifecycle events back over
HTTP.

## Prerequisites

By default the Worker **manages Codeman under the hood**:

- `CLOUDAGENTFLEET_MANAGE_CODEMAN` defaults to `true` — install (if missing) and
  start Codeman when `/api/v1/status` is down; stop it on Worker shutdown only
  if this Worker process started it.
- `CLOUDAGENTFLEET_CODEMAN_INSTALL` defaults to `true` when manage is on — run the
  official installer once when `codeman` is not on PATH.
- Set either flag to `false` to attach to an existing Codeman only (no
  install/start/stop).

Manual install (optional when manage/install are on):

```bash
curl -fsSL https://getcodeman.com/install | bash
codeman web
```

On Windows, install and manage run inside WSL (same as setup). Native Windows
without WSL remains unsupported for Codeman. Keep Codeman's authentication and
provider login local to that machine. Cloud Agent Fleet does not copy those
credentials to the Controller.

## Configure and start with the CLI

Install the Worker (`npm install --global @cloudagentfleet/worker`, or the
worker release archive), then run the guided setup, which installs Codeman
when you pick it and runs the Worker as a service:

```bash
cloudagentfleet init
```

`cloudagentfleet setup --run` is the step-by-step alternative that runs the
Worker in the terminal.

The guided flow detects WSL/Codeman, asks before installing Codeman on first
setup, lets you choose approved folders or whole-system access, discovers
workspaces beneath those roots, selects the Codeman mode, and writes
`~/.cloudagentfleet/worker.json` (including `manageCodeman` / `installCodeman`,
default `true`). On `cloudagentfleet run` (or `setup --run`), those flags become
`CLOUDAGENTFLEET_MANAGE_CODEMAN` and `CLOUDAGENTFLEET_CODEMAN_INSTALL` so the Worker
can install/start Codeman without a separate `codeman web -d` on each host.
To configure without launching, omit `--run`; later use `cloudagentfleet run`.

Once a Worker is online, run this Controller-side selection flow:

```bash
cloudagentfleet start
```

It selects an online Worker, then a ready workspace, then a ready agent, asks
for the prompt, and creates the job with an idempotency key.

To expose the Worker-backed Codeman as a Hub instance, enroll it explicitly:

```bash
cloudagentfleet enroll connector \
  --controller-url http://127.0.0.1:8787 \
  --instance-id codeman-worker-linux \
  --name "Codeman on Linux" \
  --node-id worker-linux-1 \
  --workspace-mode folders \
  --workspace-root "$HOME/workspaces"
```

The command checks `/api/instances/:id/health` after registration. For a
Codeman endpoint already reachable over Tailscale, use
`enroll tailscale-url --url https://<name>.<tailnet>.ts.net` instead. This is
the preferred path for the native Codeman UI: the Controller proxies the
selected host's Codeman REST, SSE, and WebSocket traffic over the tailnet, so
terminal input does not pass through the request-per-keystroke Worker path.
The connector remains available for machines that cannot accept Controller
connections. To serve the single private Hub, use the `hub serve` command
described in [`TAILSCALE-SERVE.md`](TAILSCALE-SERVE.md).
`CLOUDAGENTFLEET_AUTH_TOKEN` is read from the environment when the Controller
requires authentication.

## Start the Worker manually

The current runtime accepts configuration through environment variables:

```bash
export CLOUDAGENTFLEET_NODE_ID=worker-linux-1
export CLOUDAGENTFLEET_NODE_NAME="Linux build machine"
export CLOUDAGENTFLEET_CONTROLLER_URL=https://controller.example.test
export CLOUDAGENTFLEET_AUTH_TOKEN="controller-worker-token"
export CLOUDAGENTFLEET_WORKSPACE_MODE=folders
export CLOUDAGENTFLEET_WORKSPACE_ROOTS="$HOME/workspaces"
export CLOUDAGENTFLEET_WORKSPACES='[
  {
    "id": "payments",
    "name": "payments",
    "canonicalPath": "/home/me/workspaces/payments",
    "health": "ready",
    "providers": { "codeman": "ready" }
  }
]'
export CLOUDAGENTFLEET_CODEMAN_URL=http://127.0.0.1:3000
# Optional opt-outs (both default true):
# export CLOUDAGENTFLEET_MANAGE_CODEMAN=false
# export CLOUDAGENTFLEET_CODEMAN_INSTALL=false

node --experimental-strip-types apps/node-agent/src/main.ts
```

`CLOUDAGENTFLEET_CODEMAN_USERNAME` and `CLOUDAGENTFLEET_CODEMAN_PASSWORD` may be set when Codeman Basic
authentication is enabled. They are used only for direct Worker-to-Codeman
requests.

## Assignment flow

1. The Worker posts its registration to `POST /api/workers`.
2. It opens `GET /api/workers/:id/connect` and waits for `job.assign` events.
3. A Codeman job creates a session with the selected workspace path.
4. The Worker starts Codeman's interactive session and submits the prompt with
   the required carriage return.
5. Completion is synchronized using Codeman's stop/exit wait signal, then the
   clean `last-response` is posted as a `job.event`.
6. Controller cancellation deletes the corresponding Codeman session.

The Controller normally sends a workspace ID. The dashboard can also send an
explicit workspace path for a newly discovered location. The Worker checks
health, Codeman readiness, and the approved-folder/system policy again before
creating a session; paths outside the policy are rejected.

The dashboard's path picker requests suggestions from
`GET /api/instances/:id/workspaces/suggestions?path=...`. Connector Workers
enumerate local directories, skip symlinks, verify canonical paths against the
policy, and return at most 50 entries. Direct Tailscale instances can only
complete against their registered workspace metadata because Codeman does not
provide a documented remote filesystem listing endpoint.

## Current limits

- Provider login remains owned by Codeman and is not automated by the Worker.
- Cursor Agent availability depends on the official `agent` CLI (or the
  legacy `cursor-agent` command) being installed and authenticated on each
  machine. Claude Code remains owned by Codeman.
- Codeman is auto-installed only when missing (not upgraded on every start).
  Setup may still ask before the first interactive install; the Worker remains
  the long-term supervisor on every `run`. Install the Worker service
  explicitly with `cloudagentfleet worker install`.
