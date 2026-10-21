# CLI and enrollment

Most people only need `cloudagentfleet init`, which sets up a machine and
enrolls it ([Getting started](GETTING-STARTED.md)). This page covers the
commands underneath it, for when you want every option or are scripting.

## Worker setup

```text
cloudagentfleet init     # guided: installs what you pick, runs services, enrolls
cloudagentfleet setup    # step by step: asks about every detail, configures only the Worker
```

Both are safe to run repeatedly: an existing node identity is reused after
verification, and missing setup steps are shown before they are applied.
`setup` is the long form of the Worker part of `init`.

## Codeman instance enrollment

Use `enroll` after the Hub and, for connector mode, the Worker have been
started. The command registers the instance, saves only non-secret registration
metadata locally, and verifies health through the Hub:

```text
cloudagentfleet enroll connector \
  --controller-url https://controller.example.test \
  --instance-id codeman-linux-1 \
  --name "Linux Codeman" \
  --node-id worker-linux-1 \
  --workspace-mode folders \
  --workspace-root "$HOME/workspaces" \
  --agent-mode claude

cloudagentfleet enroll tailscale-url \
  --controller-url https://controller.example.test \
  --instance-id codeman-remote \
  --name "Remote Codeman" \
  --url https://codeman-remote.tailnet.ts.net \
  --agent-profile claude:"Claude Code":claude:true
```

`--mode` can be used instead of the positional mode. Connector mode requires
an enrolled Worker node ID; the Worker must use the same
`CLOUDAGENTFLEET_CODEMAN_INSTANCE_ID` (the command updates a matching local Worker config;
restart the Worker afterward).
Tailscale URL mode requires an HTTPS URL and does not enable Tailscale Serve.
Use `--workspace-root` repeatedly or separate roots with `;`; use
`--workspace-mode system` only when whole-system access is intentional.
`--agent-mode` accepts a comma-separated list and `--agent-profile` uses
`id:name:mode[:ready]`. The Worker token is read from
`CLOUDAGENTFLEET_AUTH_TOKEN` and is never written to the instance metadata file.
Use `--no-health` only to defer verification while a connector Worker is
starting.

## Setup flow

1. Detect the operating system, WSL, Node, Git, Codeman, tmux, Docker, browser,
   Cursor CLI, and Claude Code.
2. Offer to install Codeman (official installer) and the Cursor Agent CLI when
   they are missing. Nothing is installed without confirmation.
3. Ask which backends run on this machine (`codeman`, `cptr`, or both), then
   the Controller URL, Worker ID and name, approved workspace folders (or
   whole-system access), and each backend's local URL (plus the Codeman mode).
   For cptr, setup shows its license, offers to install it with pipx, uv, or
   pip, and can publish it on the tailnet with `tailscale serve --https=8444`.
   On Windows, setup asks whether cptr runs natively (the default) or in
   WSL; Codeman always runs in WSL. With Codeman in WSL and cptr on Windows,
   the saved config (`cptrExecution: "local"`) starts two Workers: `<id>` in
   WSL and `<id>-windows` natively, and the cptr enroll command uses the
   latter node id. Setup finds `cptr.exe` even when pip's user Scripts folder
   is not on PATH, and defaults cptr's port to the first free one from 8000
   (WSL forwards its ports to Windows).
   Setup also asks how the Hub reaches cptr: through the Worker connector
   (the default; `enroll connector --backend cptr`, no inbound port) or over
   the tailnet (`enroll tailscale-url --backend cptr`), and prints the matching
   enroll command. Each connector instance names its driver, `codeman` or
   `cptr`; the Worker serves the cptr driver only for its own cptr instance
   (`CLOUDAGENTFLEET_CPTR_INSTANCE_ID`, default `<node>-cptr`).
4. Save the configuration to `~/.cloudagentfleet/worker.json` (user-only, mode
   `0600`). The Worker token comes from `CLOUDAGENTFLEET_AUTH_TOKEN` or the
   "Hub Worker token" prompt (the contents of the Hub's `hub-worker-token`
   file) and is stored there so the Worker service can authenticate.
5. Optionally start Codeman now, and with `--run` start the Worker. The Worker
   installs or starts Codeman itself unless `manageCodeman` is `false`.

## Cloud Agent Fleet worker

The persistent Worker is our own background process. It owns the outbound
connection, heartbeats, job delivery, Codeman supervision, and connector
requests for hosts the Hub cannot reach directly.

```text
cloudagentfleet worker install   # systemd user unit, launchd agent, or Task Scheduler task
cloudagentfleet worker start
cloudagentfleet worker status
cloudagentfleet worker stop
cloudagentfleet worker remove    # stops and unregisters the service
```

`worker remove` does not revoke the node on the Hub and never deletes
project workspaces. `worker install` records the installing shell's PATH in
the service so Codeman sessions and cptr find the agent CLIs (`claude`,
`codex`, `agent`); `cloudagentfleet run` exits with the Worker's own exit code
so the service manager restarts a failed Worker. On Windows, `worker install`
registers a Task Scheduler task with a logon trigger for the current user (no
administrator rights) that runs `cloudagentfleet run --restart --log` in a
headless console: `--restart` restarts failed Workers after 5 seconds (the
headless console does not pass exit codes to Task Scheduler) and `--log`
appends their output to `~/.cloudagentfleet/worker.log`. The service records
its pid in `~/.cloudagentfleet/worker.pid` and refuses to start a second copy;
`worker stop` ends the task and that process tree (the Workers, cptr, and the
WSL Worker), because ending the task alone stops only its console host.

Official provider plan requirements, administrator approval, browser login, and
one-time environment secrets remain provider-owned. Cloud Agent Fleet checks
provider readiness but does not perform provider login.

## Safety rules

- Provider login remains provider-owned; the CLI never asks for or uploads
  Cursor or Anthropic API keys.
- No software or service is installed without explicit confirmation.
- Local configuration files are written user-only (`0600`).
- The Worker token is read from `CLOUDAGENTFLEET_AUTH_TOKEN` and never
  written to instance metadata (`instances.json`).

## Not yet implemented

Single-use pairing codes, per-machine keypairs in the OS credential store, and
signed self-update are planned (see `ROADMAP.md`). Until then, Workers
authenticate with the shared Worker token.
