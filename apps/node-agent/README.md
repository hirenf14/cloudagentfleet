# @cloudagentfleet/worker

Cloud Agent Fleet Worker — machine companion and operator CLI.

Requires Node.js **22.6+**. Codeman should be installed and running on the machine (`codeman web`) when you want live sessions.

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

Point the Worker at a running Hub, then configure and start:

```bash
cloudagentfleet setup --run
```

Or install as a user service:

```bash
cloudagentfleet setup
cloudagentfleet worker install
cloudagentfleet worker start
cloudagentfleet worker status
```

## Enroll with the Hub

Connector mode (Worker-backed):

```bash
cloudagentfleet enroll connector \
  --controller-url http://127.0.0.1:8787 \
  --instance-id codeman-1 \
  --name "My Codeman" \
  --node-id worker-1
```

Direct Tailscale mode (preferred when Codeman is reachable on the tailnet):

```bash
cloudagentfleet enroll tailscale-url \
  --controller-url http://127.0.0.1:8787 \
  --instance-id codeman-1 \
  --name "My Codeman" \
  --url https://codeman.tailnet.ts.net
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
