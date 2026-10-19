# Roadmap

`[x]` shipped · `[~]` partial · `[ ]` not started

## Phase 1: Foundation

- [x] Shared protocol and domain types
- [x] Durable Hub state store (`data/hub.json`, atomic writes; replaces the
      earlier SQLite plan)
- [x] Node enrollment, heartbeat timeout, revocation, and audit events
- [x] Private control-plane API

## Phase 1a: One-command setup

- [~] Standalone release archives for Windows, macOS, and Linux (unsigned)
- [x] `cloudagentfleet setup` prerequisite detection
- [x] Confirmation-based dependency provisioning (Codeman, Cursor CLI)
- [ ] One-time pairing and per-machine node identity
- [x] User-level startup service installation
- [~] Resume after reboot, doctor, and remove flows (no dry-run yet)
- [~] Outbound connectivity and capability health checks
- [x] Explicit confirmation for optional installs

## Phase 2: Codeman integration

- [x] Enroll Codeman instances (Tailscale URL or Worker connector)
- [x] Start, attach, observe, and stop persistent sessions
- [x] Native Codeman UI and terminal proxied through the Hub
- [x] Worker-managed Codeman install and supervision

## Phase 2a: Host backend abstraction

- [x] Backend-neutral instances, adapters, and feature gating
- [~] Open WebUI Computer (`cptr`) as an optional backend (link mode shipped;
      proxy and setup pending)

See `docs/BACKEND-ABSTRACTION.md`.

## Phase 3: Preview access

- [ ] Session-scoped HTTP/SSE/WebSocket relay
- [ ] Authenticated browser preview URLs
- [ ] Port discovery and explicit port registration
- [ ] Optional local loopback tunnel helper

## Phase 4: Remote browser

- [ ] Isolated Chromium/Playwright sessions
- [ ] Viewport frame transport
- [ ] Mouse, keyboard, resize, navigation, and reload events
- [ ] Session shutdown and profile cleanup

## Phase 5: Provider adapters

- [~] Cursor and Claude CLI readiness detection on the Worker
- [ ] Cursor worker routing
- [ ] Claude runner routing
- [ ] Provider-specific status and errors

## Phase 6: Release hardening

- [~] End-to-end failure and security tests (two-host mock and live harness)
- [ ] Resource limits and backup/restore
- [ ] Structured observability
- [ ] Operator runbook
