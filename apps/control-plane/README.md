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

From a dedicated folder (recommended). **Set a shared API token** — with a data
directory the Hub always enables UI login, and Workers / `enroll` need this
bearer token (without it they get `401 Authentication required`):

```bash
mkdir -p data
export HOSTED_AGENTS_HOST=127.0.0.1
export HOSTED_AGENTS_PORT=8787
export HOSTED_AGENTS_DATA_PATH="$PWD/data/hub.json"
export HOSTED_AGENTS_AUTH_TOKEN="replace-with-a-long-shared-secret"

npx cloudagentfleet-hub
```

You should see:

```text
Hosted Agents Controller listening on 127.0.0.1:8787
Hub UI password: <generated>
```

Open `http://127.0.0.1:8787` and sign in with the printed password.

### Register a Codeman instance (required for the dashboard)

A running Worker alone does **not** appear in the Hub UI. After the Worker is
online, enroll an instance:

```bash
# Same token as Hub. Use the Worker ID from setup.
export HOSTED_AGENTS_AUTH_TOKEN="replace-with-a-long-shared-secret"

cloudagentfleet enroll connector \
  --controller-url http://127.0.0.1:8787 \
  --instance-id codeman-1 \
  --name "My Codeman" \
  --node-id <worker-id-from-setup> \
  --workspace-mode folders \
  --workspace-root "$HOME/workspaces"
```

Then **restart the Worker** so it picks up `CODEMAN_INSTANCE_ID=codeman-1`.
Refresh the Hub UI — the instance should appear.

Check registration:

```bash
curl -H "Authorization: Bearer $HOSTED_AGENTS_AUTH_TOKEN" http://127.0.0.1:8787/api/workers
curl -H "Authorization: Bearer $HOSTED_AGENTS_AUTH_TOKEN" http://127.0.0.1:8787/api/instances
```

### Environment

| Variable | Default | Purpose |
| --- | --- | --- |
| `HOSTED_AGENTS_HOST` | `127.0.0.1` | Bind address (`0.0.0.0` for LAN; token then required) |
| `HOSTED_AGENTS_PORT` | `8787` | HTTP port |
| `HOSTED_AGENTS_DATA_PATH` | `data/hub.json` | Fleet state file |
| `HOSTED_AGENTS_UI_PASSWORD` | (generated) | Hub UI password (stops printing bootstrap password) |
| `HOSTED_AGENTS_AUTH_TOKEN` | unset | **Required** for Workers and CLI enroll when UI auth is on |

Source: [hirenf14/cloudagentfleet](https://github.com/hirenf14/cloudagentfleet)
