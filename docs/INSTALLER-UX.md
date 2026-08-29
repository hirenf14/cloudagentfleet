# Installer UX

## Principle

Hosted Agents must be installable by a normal developer without Cursor,
Claude, Codeman, or any AI agent running. The installer owns the machine
bootstrap; provider tools remain user-authenticated integrations.

## Human setup journey

1. Download a signed installer for Windows, macOS, or Linux.
2. Run the installer or launch `hosted-agents setup`.
3. Choose the machine name and workspace access:
   - approved folders
   - explicit whole-system scope
4. Choose capabilities:
   - Hosted Agents Worker
   - Codeman integration
   - preview relay
   - remote browser
5. Review a plain-language checklist of required changes.
6. Confirm each privileged or network-affecting change.
7. Let the installer provision dependencies, including WSL/tmux/Codeman when
   Codeman is selected.
8. Pair with the Controller using a short-lived code shown in its dashboard.
9. Install and start the user-level Worker service.
10. Run the health check and show the dashboard link.

## Required UX behaviors

- `setup` is idempotent and resumes after reboot, especially after Windows WSL
  installation.
- `setup --dry-run` shows all detected and planned changes without applying
  them.
- `hosted-agents doctor` explains missing dependencies and repair actions.
- `hosted-agents worker status` shows service, connection, workspace, and
  provider readiness separately.
- `hosted-agents remove` revokes the Worker and removes only Hosted Agents
  service/configuration; it does not delete workspaces or provider installs.
- Errors include a human-readable explanation and a log path, without printing
  credentials or cookies.
- Provider login commands are shown as optional next steps, never run
  automatically.

## Windows/WSL behavior

The installer detects whether WSL and a Linux distribution are present. If
Codeman is selected and WSL is missing, it explains that administrator approval
and a reboot may be required, requests confirmation, and resumes setup after
the reboot. The user should not need to understand the internal WSL commands.
