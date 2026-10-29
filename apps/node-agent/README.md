# @cloudagentfleet/worker

[![npm version](https://img.shields.io/npm/v/@cloudagentfleet/worker)](https://www.npmjs.com/package/@cloudagentfleet/worker)
[![npm downloads](https://img.shields.io/npm/dm/@cloudagentfleet/worker)](https://www.npmjs.com/package/@cloudagentfleet/worker)
[![License: MIT](https://img.shields.io/npm/l/@cloudagentfleet/worker)](https://github.com/techoblix/cloudagentfleet/blob/master/LICENSE)
[![Node.js](https://img.shields.io/node/v/@cloudagentfleet/worker)](https://nodejs.org)
[![CI](https://img.shields.io/github/actions/workflow/status/techoblix/cloudagentfleet/ci.yml?branch=master)](https://github.com/techoblix/cloudagentfleet/actions/workflows/ci.yml)

The Cloud Agent Fleet **Worker** and the `cloudagentfleet` CLI: install it on
each machine whose coding agents you want in your fleet's dashboard. Requires
Node.js 22.6+; nothing else.

```bash
npm install --global @cloudagentfleet/worker
cloudagentfleet init
```

`init` asks what this machine should offer and installs the ones you pick, in
one confirmed pass, using each project's official installer:

- **Codeman**: terminal sessions you start and watch from the dashboard
  (in WSL on Windows)
- **Open WebUI Computer**: a full workspace UI shown inside the dashboard
  (installs `uv` first if there is no Python tool)
- **Claude Code CLI** and **Cursor Agent CLI**: the coding agents both use

It then asks for the Hub address and the Worker token (`cloudagentfleet hub
token` on the Hub machine), installs the Worker as a user service (no
administrator rights), and enrolls the machine. Rerun it any time to change
your choices. Provider logins (`claude`, `agent login`) stay yours.

This is the machine that hosts the dashboard? Install `@cloudagentfleet/hub`
instead: it includes the Worker, and its `init` asks whether to run one.

## Commands

| Task | Command |
| --- | --- |
| Guided setup | `cloudagentfleet init` |
| Step-by-step setup (more questions) | `cloudagentfleet setup` |
| Service | `cloudagentfleet worker <install\|start\|status\|stop\|remove>` |
| Run in this terminal | `cloudagentfleet run` |
| Register an instance by hand | `cloudagentfleet enroll …` |
| Find what is wrong | `cloudagentfleet doctor` |
| Update (Worker services also update themselves) | `cloudagentfleet update` |

Settings live in `~/.cloudagentfleet/worker.json`. By default the Worker
starts Codeman and Open WebUI Computer when they are down
(`manageCodeman` / `manageCptr` in that file turn this off).

Guide: [Getting started](https://github.com/techoblix/cloudagentfleet/blob/master/docs/GETTING-STARTED.md) ·
Source: [techoblix/cloudagentfleet](https://github.com/techoblix/cloudagentfleet)
