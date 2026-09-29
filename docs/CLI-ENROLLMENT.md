# CLI Enrollment

## Worker setup

```text
cloudagentfleet setup
```

The command is the single supported path for adding a machine to a private
fleet. It is safe to run repeatedly: an existing node identity is reused after
verification, and missing setup steps are shown before they are applied.

## Codeman instance enrollment

Use `enroll` after the Controller and, for connector mode, the Worker have been
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
`CODEMAN_INSTANCE_ID` (the command updates a matching local Worker config;
restart the Worker afterward).
Tailscale URL mode requires an HTTPS URL and does not enable Tailscale Serve.
Use `--workspace-root` repeatedly or separate roots with `;`; use
`--workspace-mode system` only when whole-system access is intentional.
`--agent-mode` accepts a comma-separated list and `--agent-profile` uses
`id:name:mode[:ready]`. The controller token is read from
`HOSTED_AGENTS_AUTH_TOKEN` and is never written to the instance metadata file.
Use `--no-health` only to defer verification while a connector Worker is
starting.

## Setup flow

1. Detect the operating system, WSL, Node, Git, Codeman, tmux, Docker, browser,
   Cursor CLI, and Claude Code.
2. Ask which execution capabilities to enable, then show the required
   dependency checklist. Ask before installing software, enabling Docker, or
   registering a startup service.
3. Ask for the control-plane URL and a short-lived pairing code displayed in the
   dashboard.
4. Generate a machine keypair locally and send only the public key during
   pairing.
5. Store the private key in the OS credential store when available, otherwise
   in a user-only configuration directory.
6. Install a user-level startup service:
   - systemd user service on Linux
   - launch agent on macOS
   - Task Scheduler or an equivalent user service on Windows
7. Install and start the Hosted Agents worker as a user-level background
   service, verify the outbound connection, and print the machine's
   capabilities and dashboard URL.

## Hosted Agents worker

The persistent worker is our own background service. It owns the outbound
connection, heartbeats, job delivery, preview relay, browser relay, reconnect
backoff, and durable local session reattachment.

```text
cloudagentfleet worker install
cloudagentfleet worker start
cloudagentfleet worker status
cloudagentfleet worker stop
cloudagentfleet worker remove
```

The worker can launch or connect to Codeman, Cursor, and Claude runtimes. When
Codeman is selected and missing, setup provisions the required WSL/tmux
environment on Windows and installs Codeman after confirmation. Cursor and
Claude are only checked for availability and authentication state; users
continue to run provider-specific login/setup commands themselves.

The command can be used as:

```text
cloudagentfleet setup
```

Official provider plan requirements, administrator approval, browser login, and
one-time environment secrets remain provider-owned. Cloud Agent Fleet validates
and monitors provider readiness but does not perform provider setup.

## Safety rules

- Pairing codes are single-use and expire quickly.
- Provider login remains provider-owned; the CLI never asks for or uploads
  Cursor or Anthropic API keys.
- No privileged service is installed without explicit confirmation.
- Releases are checksum/signature verified before self-update.
- `cloudagentfleet worker remove` revokes the node, stops the companion, and
  removes local service registration without deleting project workspaces.
