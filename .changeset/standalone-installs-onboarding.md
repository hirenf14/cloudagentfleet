---
"@cloudagentfleet/hub": minor
"@cloudagentfleet/ui": minor
"@cloudagentfleet/worker": minor
"@cloudagentfleet/all-in-one": minor
---

Three standalone installs and a guided setup.

- **Pick one install per machine**, from npm or a release archive with its own Node runtime: `@cloudagentfleet/all-in-one` (Hub and Worker), `@cloudagentfleet/hub` (now includes the dashboard and the CLI, so `@cloudagentfleet/ui` is no longer needed beside it), or `@cloudagentfleet/worker`. Releases attach `cloudagentfleet-hub-*`, `cloudagentfleet-worker-*`, and `cloudagentfleet-*` archives per platform.
- **`cloudagentfleet init`** sets up a machine in one pass: choose Hub, Worker, or both; pick what the machine offers (Codeman, Open WebUI Computer, Claude Code CLI, Cursor Agent CLI) and confirm once to install them with their official installers; it runs the Hub and Worker as user services, enrolls the machine, and prints the dashboard address and password. Safe to rerun.
- **The Hub runs as a service**: `cloudagentfleet hub service install|start|status|stop|remove`, plus `hub run` and `hub token` (the Worker token new machines need). An installed Hub keeps its state in `~/.cloudagentfleet/` (an existing `./data/hub.json` is still used).
- **In the dashboard**: a Getting started guide that checks itself off, **+ Add machine** with this Hub's commands (the token never reaches the browser), **?** help with plain explanations and shortcuts (`/` or Ctrl/⌘+K to search), and hints under each machine action.
- New [getting-started guide](https://github.com/hirenf14/cloudagentfleet/blob/master/docs/GETTING-STARTED.md).
