# Installer UX

## Principle

Cloud Agent Fleet must be installable by a normal developer without Cursor,
Claude, Codeman, or any AI agent running. The CLI owns the machine bootstrap;
provider tools remain user-authenticated integrations.

## Human setup journey

1. Install one of two standalone installs per machine, from npm or a release
   archive with its own Node runtime: the **Hub** (dashboard, CLI, and a Worker
   that runs only if chosen) on the machine or server hosting the dashboard,
   and the **Worker** on each machine whose agents you want to reach.
2. Run `cloudagentfleet init`. In one pass it:
   - on a Hub install: installs the Hub as a user service on the first free
     port pair, waits for it, offers Tailscale Serve, and asks whether this
     machine should also run a Worker (default no);
   - shows one checklist of what the machine offers (Codeman, Open WebUI
     Computer, Claude Code CLI, Cursor Agent CLI), lists every install command
     (official installers; `uv` first when cptr has no Python tool), and runs
     them after a single confirmation, each where it will run (WSL or
     Windows);
   - asks only for the Hub address and Worker token (when the Hub is
     elsewhere), a machine name, and approved folders;
   - installs the Worker service, waits for it to connect, enrolls its
     instances, and waits until they are online;
   - prints the dashboard address and password, how to add machines, and the
     provider login commands to run yourself.
3. In the dashboard, **Getting started** tracks the remaining first steps,
   **+ Add machine** shows the commands with this Hub's address, and **?**
   explains the parts and shortcuts.
4. `cloudagentfleet setup` remains the step-by-step Worker configuration for
   people who want every option.

## Required UX behaviors

- `setup` is safe to rerun; Windows WSL installation and reboot resume remain
  an installer follow-up.
- `setup --dry-run` shows all detected and planned changes without applying
  them.
- `cloudagentfleet doctor` explains detected dependencies and missing
  prerequisites.
- `cloudagentfleet worker status` shows service, connection, workspace, and
  provider readiness separately.
- `cloudagentfleet worker remove` revokes the Worker and removes only Cloud
  Agent Fleet service/configuration; it does not delete workspaces or provider
  installs.
- Errors include a human-readable explanation without printing credentials or
  cookies. Standalone archives include SHA-256 checksums.
- Provider login commands are shown as optional next steps, never run
  automatically.
- Supported install paths are CLI commands only — no `install.sh` /
  `install.ps1` bootstrap scripts.

## Windows/WSL behavior

The setup flow detects whether WSL and a Linux distribution are present. If
Codeman is selected and WSL is missing, it explains that administrator approval
and a reboot may be required, requests confirmation, and reports the next
manual step. The user should not need to understand the internal WSL commands.

## Distribution artifacts

`pnpm build:release` builds the npm package contents: `@cloudagentfleet/hub`
(Hub, bundled UI, CLI, and the Worker for the Hub's own machine),
`@cloudagentfleet/worker` (Worker, CLI), and `@cloudagentfleet/ui` (the UI files
alone). `pnpm package:standalone` then builds this platform's two archives
(`cloudagentfleet-hub-*`, `cloudagentfleet-worker-*`), each with the Node runtime, launchers, a README with
first steps, a manifest, and SHA-256 checksums. The release workflow runs these
on Windows, macOS, and Linux.

The current release does not implement pairing codes, OS credential-store
integration, automatic updates, or signed artifact publication. These are
required before treating the installer as a zero-touch production installer.
