# @cloudagentfleet/hub

The Cloud Agent Fleet **Hub**: the private dashboard (included) and the fleet
API, with the `cloudagentfleet` CLI to run it as a service. It also carries
the Worker, for when the Hub's own machine should offer its agents too.
Requires Node.js 22.6+; nothing else. Host it on a server or your main
machine.

```bash
npm install --global @cloudagentfleet/hub
cloudagentfleet init
```

`init` installs the Hub as a user service that starts when you sign in (no
administrator rights), offers to publish it privately on your tailnet with
Tailscale Serve, asks whether this machine should also run a Worker (default
no), and prints the dashboard address and password.

Add machines with `@cloudagentfleet/worker` and `cloudagentfleet init` on each;
`cloudagentfleet hub token` prints the Worker token they ask for.

## Commands

| Task | Command |
| --- | --- |
| Service | `cloudagentfleet hub service <install\|start\|status\|stop\|remove>` |
| Run in this terminal | `cloudagentfleet hub run` (or `cloudagentfleet-hub`) |
| Worker token for new machines | `cloudagentfleet hub token` |
| Publish on your tailnet | `cloudagentfleet hub serve` / `status` / `stop` |

## Settings

`~/.cloudagentfleet/hub-config.json` (written by `init`) holds the port
(default 8787, the host-UI origin uses the next one) and optional public URLs.
State, the generated password (`hub-ui-auth.json`), and the Worker token
(`hub-worker-token`) live in the same folder.

| Variable | Default | Purpose |
| --- | --- | --- |
| `CLOUDAGENTFLEET_HOST` | `127.0.0.1` | Bind address |
| `CLOUDAGENTFLEET_PORT` | `8787` | Dashboard port (host UIs use port + 1) |
| `CLOUDAGENTFLEET_DATA_PATH` | `~/.cloudagentfleet/hub.json` | Fleet state file |
| `CLOUDAGENTFLEET_UI_PASSWORD` | generated | Your own dashboard password |
| `CLOUDAGENTFLEET_AUTH_TOKEN` | generated | Your own Worker token |

Guide: [Getting started](https://github.com/hirenf14/cloudagentfleet/blob/master/docs/GETTING-STARTED.md) ·
Source: [hirenf14/cloudagentfleet](https://github.com/hirenf14/cloudagentfleet)
