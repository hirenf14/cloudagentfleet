# CLI Enrollment

## Command

```text
hosted-agents setup
```

The command is the single supported path for adding a machine to a private
fleet. It is safe to run repeatedly: an existing node identity is reused after
verification, and missing setup steps are shown before they are applied.

## Setup flow

1. Detect the operating system, WSL, Node, Git, Codeman, tmux, Docker, browser,
   Cursor CLI, and Claude Code.
2. Show a required/optional checklist. Ask before installing optional software,
   enabling Docker, or registering a startup service.
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
hosted-agents worker install
hosted-agents worker start
hosted-agents worker status
hosted-agents worker stop
hosted-agents worker remove
```

The worker can launch or connect to already-configured Codeman, Cursor, and
Claude runtimes. It only checks their availability and authentication state.
Users continue to run provider-specific login/setup commands themselves.

The command can be used as:

```text
hosted-agents setup
```

Official provider plan requirements, administrator approval, browser login, and
one-time environment secrets remain provider-owned. Hosted Agents validates and
monitors provider readiness but does not perform provider setup.

## Safety rules

- Pairing codes are single-use and expire quickly.
- Provider login remains provider-owned; the CLI never asks for or uploads
  Cursor or Anthropic API keys.
- No privileged service is installed without explicit confirmation.
- Releases are checksum/signature verified before self-update.
- `hosted-agents remove` revokes the node, stops the companion, and removes
  local service registration without deleting project workspaces.
