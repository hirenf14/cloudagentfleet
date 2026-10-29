# Getting started

Cloud Agent Fleet puts the coding agents on all your machines behind one
private dashboard. You start sessions, watch them, type into them, and open
each machine's own workspace, from any device on your tailnet.

## The parts

| Part | What it is | How many |
| --- | --- | --- |
| **Hub** | The dashboard and the list of machines. It can run on a server. | One per fleet |
| **Worker** | A small service on a machine. It connects out to the Hub, so the machine needs no open ports. | One per machine you add |
| **Codeman** | Runs agent sessions in terminals; the dashboard starts, shows, and types into them. | Optional, per machine |
| **Open WebUI Computer** | A full workspace on the machine (files, editor, terminal, previews, agent chat), shown inside the dashboard. | Optional, per machine |
| **Coding agents** | Claude Code CLI and Cursor Agent CLI, used by Codeman and Open WebUI Computer. | Optional, per machine |

The Hub can also run a Worker on its own machine when you want that
machine's agents in the dashboard too.

## 1. Install

Two installs, each standalone (the guided setup installs Codeman, Open WebUI
Computer, and the coding agents you pick):

| Install on | Edition |
| --- | --- |
| The machine or server that hosts the dashboard | **hub** (includes the dashboard, and the Worker if you want it there) |
| Each machine whose agents you want to reach | **worker** |

Start with the Hub, then add machines.

### With a download (nothing else needed)

Release archives carry their own Node runtime. Extract into a folder you keep
(the services run from it), then run `init` from it. Replace `EDITION` with
`cloudagentfleet-hub` or `cloudagentfleet-worker`.

Linux (x64):

```bash
mkdir -p ~/cloudagentfleet && cd ~/cloudagentfleet
curl -fsSLO https://github.com/techoblix/cloudagentfleet/releases/latest/download/EDITION-linux-x64.tar.gz
tar -xzf EDITION-linux-x64.tar.gz
./EDITION-linux-x64/cloudagentfleet init
```

macOS (Apple silicon; on an Intel Mac use npm):

```bash
mkdir -p ~/cloudagentfleet && cd ~/cloudagentfleet
curl -fsSLO https://github.com/techoblix/cloudagentfleet/releases/latest/download/EDITION-darwin-arm64.tar.gz
tar -xzf EDITION-darwin-arm64.tar.gz
./EDITION-darwin-arm64/cloudagentfleet init
```

Windows (PowerShell, not inside WSL):

```powershell
mkdir -Force $HOME\cloudagentfleet; cd $HOME\cloudagentfleet
curl.exe -fsSLO https://github.com/techoblix/cloudagentfleet/releases/latest/download/EDITION-win32-x64.tar.gz
tar -xzf EDITION-win32-x64.tar.gz
.\EDITION-win32-x64\cloudagentfleet.cmd init
```

Each archive has a `SHA256SUMS` file and a `README.txt`. Add the folder to your
`PATH` to type `cloudagentfleet` without its path.

### With npm (Node.js 22.6+)

```bash
npm install --global @cloudagentfleet/hub      # on the Hub's machine
npm install --global @cloudagentfleet/worker   # on each machine you add
cloudagentfleet init
```

Install one of the two per machine (they share the `cloudagentfleet` command).
To add the Hub's own machine to the fleet later, run `cloudagentfleet init`
there again and answer yes to running a Worker; nothing else to install.

The dashboard's **+ Add machine** shows these commands for the system you
pick, with your Hub's address.

## 2. Run the guided setup

```bash
cloudagentfleet init
```

It walks through everything once and is safe to run again:

1. **Hub** (hub install). Installs the Hub as a user service that starts when
   you sign in (no administrator rights), offers to publish it privately on
   your tailnet with Tailscale Serve so your other devices can reach it, then
   asks whether this machine should also run a Worker (default no: a server
   usually has no agents). The steps below are the Worker's.
2. **Worker.** On a worker install, or when you said yes on the Hub.
3. **What this machine offers: one or both.**

   ```text
   1. Codeman
      Agent sessions in terminals. Start them from the dashboard, watch their output
      live, and type into them. Light, and good for running many agents side by side.
      (On Windows it runs in WSL.)

   2. Open WebUI Computer
      A full workspace in the browser: files, editor, terminal, previews of running
      apps, and chat with coding agents. Opens inside the dashboard. Third-party
      software under its own license.

   3. Both
   ```

   Pick Codeman if you mostly run agents and watch them; Open WebUI Computer if
   you also want to browse and edit the code and preview apps; both to have
   each.
4. **Coding agents** (optional). Claude Code CLI and Cursor Agent CLI; already
   installed ones are marked. Nothing is uninstalled.
5. **One install pass.** It lists every install command (each project's
   official installer; for Open WebUI Computer it first installs `uv` if there
   is no Python tool), asks once, and installs them where they run.
6. **Hub address and token** (Worker only, when the Hub is elsewhere). Use the
   address you open the dashboard at, and the token from
   `cloudagentfleet hub token` on the Hub machine.
7. **Name and folders.** A name for the machine, and which folders the Hub may
   start sessions in.
8. **Done.** It installs the Worker service, waits for it to connect, enrolls
   the machine, waits until it is online, and prints the dashboard address and
   password.

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
| See Workers and their status | `cloudagentfleet workers` (`--json` for scripts) |
| A Worker's agent limits | `cloudagentfleet workers usage <id>` |
| Host instances and sessions | `cloudagentfleet instances`, `cloudagentfleet sessions [--instance <id>]` |
| Find what is wrong (versions, Hub link, Worker, backends, logs) | `cloudagentfleet doctor` |
| Update | `cloudagentfleet update` (`--check` only looks) |
| Change choices | `cloudagentfleet init` again |

`workers`, `instances` and `sessions` are read-only and ask the Hub over its API
with the Worker token. They work on the Hub machine with no setup, and on a
Worker machine they use its saved Hub address and token. From anywhere else, pass
`--hub <url> --token <secret>` (or set `CLOUDAGENTFLEET_HUB_URL` and
`CLOUDAGENTFLEET_AUTH_TOKEN`); the token printed by `cloudagentfleet hub token`
is the one to use.

Logs and settings live in `~/.cloudagentfleet/` (`%USERPROFILE%\.cloudagentfleet\`
on Windows), including `cptr.log`. Service output goes to `hub.log` and
`worker.log` on Windows; on Linux the journal keeps it
(`journalctl --user -u cloudagentfleet-worker`), and on macOS launchd does.

## Updates

The Hub looks for newer releases on npm every few hours; the dashboard shows
a banner when the Hub or a Worker is behind (Workers report their version
when they enroll). `cloudagentfleet update` installs the newest release.

A Worker running as a service (`run --restart`, which `worker install` sets
up) installs updates by itself and restarts on them, like Claude Code does.
Turn it off with `cloudagentfleet update auto off` or
`CLOUDAGENTFLEET_AUTO_UPDATE=0`. A Hub only reports by default, because
restarting it drops its in-memory Worker registry until they reconnect; turn
it on with `update auto on` or `CLOUDAGENTFLEET_AUTO_UPDATE=1`.
`CLOUDAGENTFLEET_UPDATE_CHECK=0` stops all checks.

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
