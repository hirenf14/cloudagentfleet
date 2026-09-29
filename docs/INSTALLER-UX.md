# Installer UX

## Principle

Cloud Agent Fleet must be installable by a normal developer without Cursor,
Claude, Codeman, or any AI agent running. The CLI owns the machine bootstrap;
provider tools remain user-authenticated integrations.

## Human setup journey

1. Install the npm package (`npm install --global cloudagentfleet`) or extract
   a platform archive and put its `cloudagentfleet` launcher on `PATH`.
2. Run `cloudagentfleet setup`.
3. Choose the machine name and workspace access:
   - approved folders
   - explicit whole-system scope
4. Choose capabilities:
   - Cloud Agent Fleet Worker
   - Codeman integration
   - preview relay
   - remote browser
5. Review a plain-language checklist of required changes.
6. Confirm each privileged or network-affecting change.
7. Let setup check dependencies, including WSL/tmux/Codeman when Codeman is
   selected. Provider installation and login remain explicit user actions.
8. Enroll the Worker with the Controller.
9. Install and start the user-level Worker service with
   `cloudagentfleet worker install` and `cloudagentfleet worker start`.
10. Run `cloudagentfleet doctor` and show the dashboard link.

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

`pnpm build:release` creates a source-free Worker/CLI runtime. The web Hub and
dashboard are deployed separately on the Controller host.
`pnpm package:standalone` adds the current platform's Node runtime,
`cloudagentfleet` launcher, manifest, and checksum file, then creates a
`.tar.gz` archive. The release workflow runs these commands on Windows, macOS,
and Linux so each archive contains a native runtime.

The current release does not implement pairing codes, OS credential-store
integration, automatic updates, or signed artifact publication. These are
required before treating the installer as a zero-touch production installer.
