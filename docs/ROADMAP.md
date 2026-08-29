# Roadmap

## Phase 1: Foundation

- Shared protocol and domain types
- SQLite persistence contracts
- Node enrollment, heartbeat, revocation, and audit events
- Private control-plane API

## Phase 1a: One-command setup

- `hosted-agents setup` prerequisite detection
- One-time pairing and protected node identity
- User-level startup service installation
- Outbound connectivity and capability health checks
- Explicit confirmation for optional installs

## Phase 2: Codeman integration

- Discover Codeman instances and remote cases
- Start, attach, observe, and stop persistent sessions
- Preserve Codeman's terminal and Docker isolation behavior

## Phase 3: Preview access

- Session-scoped HTTP/SSE/WebSocket relay
- Authenticated browser preview URLs
- Port discovery and explicit port registration
- Optional local loopback tunnel helper

## Phase 4: Remote browser

- Isolated Chromium/Playwright sessions
- Viewport frame transport
- Mouse, keyboard, resize, navigation, and reload events
- Session shutdown and profile cleanup

## Phase 5: Provider adapters

- Cursor worker readiness and routing
- Claude runner readiness and routing
- Provider-specific status and errors

## Phase 6: Release hardening

- End-to-end failure and security tests
- Resource limits and backup/restore
- Structured observability
- Operator runbook
