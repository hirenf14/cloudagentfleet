# Getting started

Cloud Agent Fleet puts the coding agents on all your machines behind one
private dashboard. You start sessions, watch them, type into them, and open
each machine's own workspace, from any device on your tailnet.

## The parts

| Part | What it is | How many |
| --- | --- | --- |
| **Hub** | The dashboard and the list of machines. | One per fleet |
| **Worker** | A small service on a machine. It connects out to the Hub, so the machine needs no open ports. | One per machine |
| **Codeman** | Runs agent sessions in terminals; the dashboard starts, shows, and types into them. | Optional, per machine |
| **Open WebUI Computer** | A full workspace on the machine (files, editor, terminal, previews, agent chat), shown inside the dashboard. | Optional, per machine |
| **Coding agents** | Claude Code CLI and Cursor Agent CLI, used by Codeman and Open WebUI Computer. | Optional, per machine |

One machine can run the Hub and a Worker. Every machine you add later runs a
Worker only.

## 1. Pick an install

Each install is standalone: it brings everything for its role, and the guided
setup installs Codeman, Open WebUI Computer, and the coding agents you pick.

| You want | npm (Node.js 22.6+) | Or a release archive (no Node.js needed) |
| --- | --- | --- |
| Everything on one machine | `npm install --global @cloudagentfleet/all-in-one` | `cloudagentfleet-<os>-<arch>` |
| The Hub on a machine | `npm install --global @cloudagentfleet/hub` | `cloudagentfleet-hub-<os>-<arch>` |
| A machine to add to a fleet | `npm install --global @cloudagentfleet/worker` | `cloudagentfleet-worker-<os>-<arch>` |

Archives are on the [latest release](https://github.com/hirenf14/cloudagentfleet/releases/latest).
Extract one, put the folder on your `PATH` (or run its launchers by path); it
carries its own Node runtime and a `SHA256SUMS` file to check.

Install one of the three per machine; they share command names.

## 2. Run the guided setup

```bash
cloudagentfleet init
```

It walks through everything once and is safe to run again:

1. **Role.** Hub, Worker, or both, depending on what you installed.
2. **Hub** (if chosen). Installs the Hub as a user service that starts when you
   sign in (no administrator rights), and offers to publish it privately on
   your tailnet with Tailscale Serve so your other devices can reach it.
3. **What this machine offers.** One checklist:

   ```text
   1. Codeman — terminal sessions you start and watch from the dashboard
   2. Open WebUI Computer — a full workspace UI: files, editor, terminal, previews, agent chat
   3. Claude Code CLI — Anthropic's coding agent, used by both
   4. Cursor Agent CLI — Cursor's coding agent, used by both
   ```

   It then shows every install command it will run, asks once, and installs
   them (using each project's official installer; for Open WebUI Computer it
   first installs `uv` if there is no Python tool).
4. **Hub address and token** (Worker only, when the Hub is elsewhere). Use the
   address you open the dashboard at, and the token from
   `cloudagentfleet hub token` on the Hub machine.
5. **Name and folders.** A name for the machine, and which folders the Hub may
   start sessions in.
6. **Done.** It installs the Worker service, waits for it to connect, enrolls
   the machine, and prints the dashboard address and password.

Sign in to your coding agents yourself (`claude`, `agent login`); Cloud Agent
Fleet never handles provider logins.

### Windows

Run `init` from a normal terminal (PowerShell or Command Prompt), not inside
WSL. Codeman needs Linux, so it runs in WSL; Open WebUI Computer runs natively
on Windows by default, so it works with your Windows folders. With both, the
Worker service runs a WSL Worker for Codeman and a Windows Worker
(`<name>-windows`) for Open WebUI Computer. If WSL is missing, run
`wsl --install` in an administrator PowerShell, restart, and run `init` again.

## 3. Use the dashboard

Open the address `init` printed and sign in.

- **Getting started** in the sidebar tracks the remaining first steps until
  you finish or hide it.
- **Machines** lists each machine. Pick one to see its page:
  - **Start a session** runs an agent (or a plain shell) in one of its
    workspaces; you watch and type in the dashboard.
  - **Open … UI** shows that machine's own interface inside the dashboard. For
    Open WebUI Computer you are signed in automatically.
  - **Check health** asks whether the machine is reachable right now.
- **Recent** shows the latest sessions across all machines.
- **+** next to Machines shows how to add a machine, with this Hub's address.
- Press `/` or `Ctrl`/`⌘`+`K` to search, `?` for help.

## 4. Add more machines

On each new machine: install the Worker (npm or the worker archive), run
`cloudagentfleet init`, and give it the Hub address and the token from
`cloudagentfleet hub token` on the Hub machine. It appears in the dashboard
when `init` finishes.

## Everyday commands

| Task | Command |
| --- | --- |
| Hub service | `cloudagentfleet hub service status` (also `start`, `stop`, `remove`) |
| Worker service | `cloudagentfleet worker status` (also `start`, `stop`, `remove`) |
| Publish the Hub on your tailnet | `cloudagentfleet hub serve` |
| Token for new machines | `cloudagentfleet hub token` |
| Check this machine | `cloudagentfleet doctor` |
| Change choices | `cloudagentfleet init` again |

Logs and settings live in `~/.cloudagentfleet/` (`%USERPROFILE%\.cloudagentfleet\`
on Windows), including `cptr.log`. Service output goes to `hub.log` and
`worker.log` on Windows; on Linux the journal keeps it
(`journalctl --user -u cloudagentfleet-worker`), and on macOS launchd does.

## Security in short

- The Hub listens on `127.0.0.1` only; Tailscale Serve publishes it to your
  tailnet, never to the internet. Restrict it further with Tailscale ACLs.
- Workers connect out to the Hub with the Worker token; no machine opens a
  port.
- Each machine's own UI runs on a separate origin, so it cannot use your
  dashboard session. Open WebUI Computer's password stays on its machine; the
  Hub only relays a session.
- Session folders are limited to the ones you approved, except inside Open
  WebUI Computer, which has full access to its machine.

More: [Threat model](THREAT-MODEL.md), [Tailscale Serve](TAILSCALE-SERVE.md).

## Troubleshooting

| Symptom | Try |
| --- | --- |
| A machine stays offline | `cloudagentfleet worker status`, then the Worker log; rerun `init` on that machine. |
| `Instance registration failed: 401` | The Worker token is wrong: run `cloudagentfleet hub token` on the Hub machine and rerun `init`. |
| The dashboard is not reachable from another device | Run `cloudagentfleet hub serve` on the Hub machine and use the `https://….ts.net` address. |
| Open WebUI Computer asks you to sign in | It was set up before automatic sign-in: put its account in `~/.cloudagentfleet/cptr-credentials.json` as `{"username": "...", "password": "..."}` on that machine. |
| A dev server port is missing in Open WebUI Computer on Windows | Open `http://localhost:<port>` in its Browser tab (its port list needs `wmic`, which current Windows 11 lacks). |

## Remove

```bash
cloudagentfleet worker remove
cloudagentfleet hub service remove
cloudagentfleet hub stop          # if you published it with Tailscale Serve
```

Then uninstall the package (`npm uninstall --global @cloudagentfleet/…`) or
delete the archive folder. Your settings stay in `~/.cloudagentfleet/` until
you delete it; Codeman, Open WebUI Computer, and the agent CLIs stay installed.
