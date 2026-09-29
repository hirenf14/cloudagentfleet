# @cloudagentfleet/hub

Cloud Agent Fleet Hub — private control plane, Codeman proxy, and fleet API.

Requires Node.js **22.6+** and `@cloudagentfleet/ui` (Hub serves UI assets from that package).

## Install

```bash
mkdir -p ~/cloudagentfleet-hub && cd ~/cloudagentfleet-hub
npm install @cloudagentfleet/hub @cloudagentfleet/ui
```

Or globally:

```bash
npm install --global @cloudagentfleet/hub @cloudagentfleet/ui
```

## Start

From a dedicated folder (recommended):

```bash
mkdir -p data
export HOSTED_AGENTS_HOST=127.0.0.1
export HOSTED_AGENTS_PORT=8787
export HOSTED_AGENTS_DATA_PATH="$PWD/data/hub.json"

npx cloudagentfleet-hub
```

You should see:

```text
Hosted Agents Controller listening on 127.0.0.1:8787
Hub UI password: <generated>
```

Open `http://127.0.0.1:8787` and sign in with the printed password.

### Optional environment

| Variable | Default | Purpose |
| --- | --- | --- |
| `HOSTED_AGENTS_HOST` | `127.0.0.1` | Bind address (`0.0.0.0` for LAN) |
| `HOSTED_AGENTS_PORT` | `8787` | HTTP port |
| `HOSTED_AGENTS_DATA_PATH` | `data/hub.json` | Fleet state file |
| `HOSTED_AGENTS_UI_PASSWORD` | (generated) | Hub UI password (stops printing bootstrap password) |
| `HOSTED_AGENTS_AUTH_TOKEN` | unset | Optional API token for workers / enrollment |

## Binary

- `cloudagentfleet-hub` — starts the Hub (compiled CLI bundle only; no source tree)

## Related packages

- [`@cloudagentfleet/ui`](https://www.npmjs.com/package/@cloudagentfleet/ui) — Hub UI assets
- [`@cloudagentfleet/worker`](https://www.npmjs.com/package/@cloudagentfleet/worker) — machine Worker + operator CLI

Source and docs: [hirenf14/cloudagentfleet](https://github.com/hirenf14/cloudagentfleet)
