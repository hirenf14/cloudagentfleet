# Roadmap

What works today, what we plan next, and what is further out. This is a
direction, not a promise: order and scope change as people use it. To suggest
something, [open an issue](https://github.com/techoblix/cloudagentfleet/issues).

## Works today

- **Guided setup.** `cloudagentfleet init` installs what you pick (Codeman,
  Open WebUI Computer, Claude Code CLI, Cursor Agent CLI), runs the Hub and
  Worker as user services, and enrolls the machine. Works without
  administrator rights.
- **Hub and Worker.** A private dashboard, and Workers that connect out so
  machines open no ports. Published on your tailnet with Tailscale Serve.
- **Codeman.** Start, watch, type into, and stop agent sessions in approved
  folders, from any machine in the fleet.
- **Open WebUI Computer.** A full workspace for each machine inside the
  dashboard, signed in automatically, including agent chat and app previews.
- **Windows, macOS, and Linux.** Verified on Windows (with WSL) and Linux;
  macOS services are implemented but not yet tested on a Mac.
- **Installs.** npm packages and downloadable archives that include Node.js
  (Windows, macOS on Apple silicon, Linux x64), built with npm provenance.
- **A calmer dashboard.** Search, recent sessions across machines, a sidebar
  that stays readable with many machines and sessions, built-in help and a
  getting-started checklist.

## Next

- **One-time pairing codes** shown in the dashboard, instead of copying the
  Worker token from the Hub machine.
- **Choose your own password** on first sign-in, instead of a generated one.
- **Signed downloads and installers**, plus Intel Mac and Linux ARM builds, so
  Windows and macOS stop showing a first-run warning.
- **Token-free publishing** to npm, so releases cannot fail on an expired token.
- **Backup and restore** for the Hub's data.

## Later

- **Preview links.** Open a web app running on a machine through a private,
  session-scoped link (Open WebUI Computer's Browser tab covers this today).
- **A remote browser.** An isolated browser running on the machine, for pages
  you cannot reach from your device.
- **Agent-aware routing.** Send a task to the machine that has the right agent
  ready, and show provider-specific status and errors.
- **Open WebUI Computer chats in the fleet view.** Needs a way to list its
  sessions; today they appear only inside its own interface.
- **Operations.** Resource limits, structured logs and metrics, and an operator
  runbook.

## Not planned

- Running agents for you. Cloud Agent Fleet connects to the tools you already
  use; provider logins and accounts stay yours.
- Opening machines to the internet. The design is private by default: a
  loopback Hub reached over your tailnet.
