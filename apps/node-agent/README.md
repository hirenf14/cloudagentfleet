# @cloudagentfleet/worker

Cloud Agent Fleet Worker — machine companion and operator CLI.

Requires Node.js **22.6+**. By default the Worker installs Codeman if missing and
starts/stops a Codeman instance it owns (`HOSTED_AGENTS_MANAGE_CODEMAN` /
`HOSTED_AGENTS_CODEMAN_INSTALL`, both default `true`). Set them to `false` to
attach to an existing `codeman web` only.

## Install

```bash
npm install --global @cloudagentfleet/worker
cloudagentfleet --help
```

Or in a folder:

```bash
mkdir -p ~/cloudagentfleet-worker && cd ~/cloudagentfleet-worker
npm install @cloudagentfleet/worker
npx cloudagentfleet --help
```

## Quick start

**Same `HOSTED_AGENTS_AUTH_TOKEN` as the Hub** is required (Hub UI auth rejects
Worker enroll without it). Codeman is managed by the Worker by default (install
if missing, start if down).

```bash
export HOSTED_AGENTS_AUTH_TOKEN="replace-with-a-long-shared-secret"
cloudagentfleet setup --run
```

Use the Hub’s reachable URL as Controller URL (not `127.0.0.1` if Hub is on
another machine). Note the Worker ID printed/chosen during setup.

### Enroll so the Hub UI shows an instance

The dashboard lists **instances**, not raw Workers. After the Worker is online:

```bash
export HOSTED_AGENTS_AUTH_TOKEN="replace-with-a-long-shared-secret"

cloudagentfleet enroll connector \
  --controller-url http://<hub-host>:8787 \
  --instance-id codeman-1 \
  --name "My Codeman" \
  --node-id <worker-id-from-setup> \
  --workspace-mode folders \
  --workspace-root "$HOME/workspaces"
```

Restart the Worker (`cloudagentfleet worker stop` / `start`, or re-run
`cloudagentfleet setup --run`) so it uses `CODEMAN_INSTANCE_ID=codeman-1`.

Check:

```bash
curl -H "Authorization: Bearer $HOSTED_AGENTS_AUTH_TOKEN" http://<hub-host>:8787/api/workers
curl -H "Authorization: Bearer $HOSTED_AGENTS_AUTH_TOKEN" http://<hub-host>:8787/api/instances
```

## Useful commands

```bash
cloudagentfleet doctor
cloudagentfleet hub serve
cloudagentfleet hub status
cloudagentfleet hub stop
cloudagentfleet worker stop
cloudagentfleet worker remove
```

`hosted-agents` is a compatibility alias for `cloudagentfleet`.

## Binaries

| Command | Role |
| --- | --- |
| `cloudagentfleet` | Operator CLI (setup, enroll, hub, worker, doctor) |
| `cloudagentfleet-worker` | Worker runtime process |
| `hosted-agents` | Alias for `cloudagentfleet` |

Published contents are compiled CLI bundles under `dist/` only.

## Related packages

- [`@cloudagentfleet/hub`](https://www.npmjs.com/package/@cloudagentfleet/hub)
- [`@cloudagentfleet/ui`](https://www.npmjs.com/package/@cloudagentfleet/ui)

Source and docs: [hirenf14/cloudagentfleet](https://github.com/hirenf14/cloudagentfleet)
