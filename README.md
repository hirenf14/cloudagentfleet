# Hosted Agents

Private multi-machine agent fleet control for Codeman, Cursor, and Claude Code.

Hosted Agents keeps Codeman as the local execution plane for persistent terminal
and CLI sessions, then adds fleet enrollment, routing, preview-port forwarding,
and interactive remote browser sessions.

One local server runs the Controller and web router. Each additional machine
runs a persistent Worker client; the Controller never executes agent commands
itself.

## Project shape

- `apps/control-plane` — private API, scheduler, persistence, and relay
- `apps/dashboard` — operator UI for machines, sessions, previews, and audit
- `apps/cli` — guided machine setup, pairing, and health checks
- `apps/node-agent` — outbound-connected machine companion
- `packages/protocol` — shared messages and domain types

## Provider boundary

Cursor and Claude use separate hosted-agent control planes and credentials.
Hosted Agents integrates with both where their official worker/runner paths are
available. Codeman remains the fallback/local execution plane for persistent
CLI sessions.

## Machine setup

The onboarding entry point is:

```bash
hosted-agents setup
```

The current bootstrap performs a read-only environment check. Pairing, identity
storage, and user-service installation will be enabled once control-plane
transport is implemented.

## Status

The repository currently contains the initial architecture and security
baseline. Implementation follows the roadmap in `docs/ROADMAP.md`.
