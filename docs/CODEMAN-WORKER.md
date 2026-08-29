# Codeman Worker

The Worker is the machine-local execution side of Hosted Agents. It does not
open an inbound listener. It enrolls with the Controller, consumes assignments
over an outbound Server-Sent Events stream, and posts lifecycle events back over
HTTP.

## Prerequisites

Codeman must be installed and running on the Worker machine:

```bash
curl -fsSL https://getcodeman.com/install | bash
codeman web
```

On Windows, run those commands inside WSL. Keep Codeman's authentication and
provider login local to that machine. Hosted Agents does not copy those
credentials to the Controller.

## Configure and start with the CLI

From the repository root, run:

```bash
node apps/cli/bin/hosted-agents.mjs setup --run
```

The guided flow detects WSL/Codeman, asks before installing Codeman, lets you
choose approved folders or whole-system access, discovers workspaces beneath
those roots, selects the Codeman mode, writes a machine-local configuration,
starts Codeman, and launches the Worker. To configure without launching, omit
`--run`; later use `hosted-agents run`.

Once a Worker is online, run this Controller-side selection flow:

```bash
node apps/cli/bin/hosted-agents.mjs start
```

It selects an online Worker, then a ready workspace, then a ready agent, asks
for the prompt, and creates the job with an idempotency key.

## Start the Worker manually

The current runtime accepts configuration through environment variables:

```bash
export HOSTED_AGENTS_NODE_ID=worker-linux-1
export HOSTED_AGENTS_NODE_NAME="Linux build machine"
export HOSTED_AGENTS_CONTROLLER_URL=https://controller.example.test
export HOSTED_AGENTS_AUTH_TOKEN="controller-worker-token"
export HOSTED_AGENTS_WORKSPACE_MODE=folders
export HOSTED_AGENTS_WORKSPACE_ROOTS="$HOME/workspaces"
export HOSTED_AGENTS_WORKSPACES='[
  {
    "id": "payments",
    "name": "payments",
    "canonicalPath": "/home/me/workspaces/payments",
    "health": "ready",
    "providers": { "codeman": "ready" }
  }
]'
export CODEMAN_URL=http://127.0.0.1:3000

node --experimental-strip-types apps/node-agent/src/main.ts
```

`CODEMAN_USERNAME` and `CODEMAN_PASSWORD` may be set when Codeman Basic
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

Workspace IDs, not arbitrary paths, cross the Controller boundary. The Worker
checks health, Codeman readiness, and the approved-folder/system policy again
before creating a session.

## Current limits

- The first Codeman mode is Claude; the mode becomes configurable when the
  provider adapter contract is added.
- Session output is reported on completion; the live terminal/session sidebar
  is a separate dashboard task.
- The setup CLI does not yet install Codeman or the Worker service.
