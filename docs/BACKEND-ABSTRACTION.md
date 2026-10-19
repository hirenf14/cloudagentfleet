# Host backend abstraction and cptr support

Status (2026-10-19): **Phases A, B, Spike S, C, and D are done.** Codeman and
cptr (proxied by default, link mode with `--link-only`) are registered. Next
is Phase E (setup and supervision of cptr).

The goal is to enroll a second per-machine backend, Open WebUI Computer
(`cptr`), next to Codeman without forking the Hub, Worker, or dashboard per
backend.

## Goals

- One Hub, mixed fleet: machine A on Codeman, machine B on cptr, machine C on
  both (two instances on one machine).
- The Hub, routes, and dashboard depend on **features**, never on a backend
  name.
- Adding a backend means adding one adapter module plus a registry entry.
- No behaviour change for existing Codeman users; persisted `hub.json` files
  and already-installed Workers keep working.

## Non-goals

- Forking or modifying cptr. We only talk to an unmodified cptr instance.
- cptr behind the Worker connector (outbound-only); direct tailnet only at
  first.
- Enforcing our folder-root policy inside cptr. cptr's own file browser,
  editor, and terminal are not mediated by the Hub, and the dashboard must say
  so.

## Design (implemented)

### Protocol (`packages/protocol`)

- `HostInstance` has a `backend` (`HOST_BACKENDS`, currently `["codeman"]`) and
  a `features` list (`BACKEND_FEATURES`: `sessions`, `terminal`,
  `native-ui-proxy`, `native-ui-link`, `workspace-suggest`). The Hub sets
  `features` from the attached adapter; it is never trusted from a
  registration.
- `HostSession`, `HostSessionEvent`, and `AgentProfile` replace the
  Codeman-prefixed types. `AgentProfile.mode` is a backend-specific launch key
  (a Codeman mode for Codeman), validated by the backend rather than the
  protocol.
- **Wire compatibility:** Worker ↔ Hub messages (`codeman.request`,
  `codeman.response`, `codeman.session.event`) and the `/api/instances`
  registration shape are unchanged. A registration without `backend` means
  `"codeman"`. These connector messages stay Codeman-named because the
  connector is Codeman-specific.
- **Persistence:** `HubStateStore` loads instances saved before this change as
  `backend: "codeman"`, `features: []`; the Hub recomputes features when it
  attaches adapters at startup.

### Adapters (`packages/host-adapters`)

```
src/
  contract.ts        HostAdapter, facet interfaces, BackendDefinition
  registry.ts        backend → definition; createAdapter, describeBackends
  shared/http-proxy.ts  native-UI proxy (credential stripping, redirect rewrite, switcher)
  shared/ws-relay.ts    WebSocket upgrade + byte relay; rejectSocket
  shared/sse.ts         readSseStream
  codeman/adapters.ts   CodemanHttpAdapter, CodemanConnectorAdapter
  codeman/wire.ts       Codeman status/event/agent mapping, CodemanStatus
  codeman/index.ts      codemanBackend definition
  contract.test.ts      runs against every registered backend
```

- `HostAdapter` has core methods (`listAgents`, `listWorkspaces`, optional
  `subscribeEvents`) and one facet per feature: `sessionControl` (sessions),
  `terminalProxy` (terminal), `nativeUi` (native-ui-proxy, with an optional
  `prepareNativeUi`), and `pathSuggestions` (workspace-suggest).
  `native-ui-link` will have no facet; the dashboard opens a link instead.
- `BackendDefinition` gives `label`, `connectionModes`, `features(mode)`,
  `defaultAgents()`, and `createAdapter(instance, { credentials, connector })`.
- The contract test checks that each backend and connection mode advertises
  exactly the facets it implements, and that default agents are complete.
- Codeman features: `tailscale-url` → sessions, terminal, native-ui-proxy,
  workspace-suggest. `connector` → sessions, workspace-suggest.

### Hub (`apps/control-plane`)

- `FleetHub` builds adapters only through the registry (with an
  `adapterFactory` test seam), stores advertised features, and reaches
  backend functions only through facets. A missing feature raises
  `UnsupportedError` (HTTP 409).
- `/_fleet/api/fleet/select/:id` gates on `native-ui-proxy`; session sync gates on
  `sessions`; the terminal upgrade gates on `terminal`.
- `GET /api/backends` returns `[{ backend, label, connectionModes, features }]`.
- Connector enrollment checks the node capability named after the backend.
- The selected-host cookie is `cloudagentfleet_instance`.

### Dashboard and CLI

- The dashboard reads labels from `/api/backends` and gates "Open … UI",
  "Start a session", and session polling on `features`. The in-UI host
  switcher lists only `native-ui-proxy` hosts.
- `cloudagentfleet enroll --backend <codeman>` (default `codeman`) writes
  `backend` into the registration. The CLI keeps its own backend list, since
  it is plain `.mjs`; keep it in sync with the registry.

### Known Codeman-specific remainders

These are intentional and stay until a second backend needs them:

- The Worker (`apps/node-agent`) is a Codeman runtime: `CodemanClient`,
  `CodemanWorkerRuntime`, and `codeman-supervisor`. A `BackendSupervisor`
  interface waits for a second implementation (Phase E).
- The connector RPC (`CodemanConnectorOperation`, `ControlPlane.requestConnector`)
  is Codeman-shaped.
- `CODEMAN_AGENT_MODES` and `codemanAgentName` live in `protocol` because both
  the Worker and the Codeman adapter use them.
- `WorkspaceDescriptor.providers` and job `Provider` still use `codeman` as a
  provider key.

## Spike S — results (2026-10-19, cptr v0.9.21)

Read from the cptr source (`LICENSE`, `cptr/app.py`, `cli.py`, `routers/*`,
`socket/main.py`, `utils/browser/proxy.py`, `frontend/svelte.config.js`) and
docs.openwebui.com. This is not legal advice.

1. **License:** the "Open Use License" is Elastic License 2.0 plus an
   attribution clause (no removing, modifying, obscuring, replacing, or
   supplementing cptr's name, logos, or about/version screens). openwebui.com/terms
   says it is free for work and commercial use. Linking to, proxying, and
   `pip install`-ing a user's own instance appear fine. **Don't bundle or
   redistribute it**, don't offer it as a hosted service to third parties, and
   keep the fleet switcher away from cptr's branding.
2. **API:** only `GET /api/health` (no auth) and the `/v1` gateway (bearer API
   key) are documented. Everything else (`/api/state/workspaces`,
   `/api/chats`, `/api/terminal`, `/api/admin/agents`, `/api/browser/*`,
   Socket.IO) is internal and uses a `cptr_session` JWT cookie, not bearer
   tokens. `sessions` support is therefore out of scope for now.
3. **Proxyability:** cptr must be served at `/` (no base path), and port
   previews are same-origin under `/api/browser/frame/...`. CORS defaults to
   `*`, and cookies have no Domain. **Collision:** cptr uses `/api/auth*`,
   which the Hub reserves, so root proxying (Phase D) requires moving the Hub's
   own routes off `/api/auth`. Recommendation: put every Hub-owned route under
   one reserved prefix (for example `/_fleet/`) so no backend can collide.
4. **Auth handoff:** a `trusted_header` mode exists but doesn't cover Socket.IO,
   terminals, or admin routes. The workable path is for the Hub to log in
   server-side and inject `Cookie: cptr_session=…` upstream, capturing refreshed
   cookies. Login is rate-limited to 5 per minute.
5. **Runtime:** `cptr run` defaults to `127.0.0.1:8000`. Reaching it from the
   Hub needs `--host 0.0.0.0` (or the Tailscale IP), or Tailscale Serve in
   front. The first-run setup URL carries a one-time token printed on stdout.

**Verdict:** Phase C (link) is feasible now. Phase D is feasible after the Hub
route prefix move and cookie injection. Phase E is feasible without bundling,
but the supervisor must handle the first-run setup token.

## Spike S — questions (answered above)

1. **License:** do the cptr "Open Use" terms allow a third party to link to,
   reverse-proxy, and install (`pip install cptr`) it on a user's behalf?
   If not, stop after Phase C or drop cptr.
2. **API surface:** beyond `/v1/chat/completions`, are there stable routes for
   health, workspaces, sessions or chats, agent profiles, and ports? This
   decides whether cptr can ever advertise `sessions`.
3. **Proxyability:** does cptr work behind the Hub at the root of the Hub
   origin (login/JWT cookie, WebSockets, port previews, HMR)? Do its paths
   collide with Hub-owned prefixes (`/api/auth`, `/api/fleet`,
   `/api/instances`, `/api/workers`, `/api/jobs`, `/api/audit`,
   `/api/backends`, `/healthz`, `/fleet-host-switcher.js`)?
4. **Auth handoff:** can the Hub hold a cptr credential or token and inject
   it, so the user doesn't log in twice?

## Phase C — cptr Level 1: link mode (done)

Shipped as described below: `packages/host-adapters/src/cptr/`, `launchUrl`
for link-mode hosts only, the dashboard policy note, a THREAT-MODEL entry,
`enroll --backend cptr`, and registration that rejects connection modes a
backend does not support.


- Add `"cptr"` to `HOST_BACKENDS`, `packages/host-adapters/src/cptr/` with a
  definition advertising `["native-ui-link"]`, and a registry entry. The
  contract test then covers it automatically.
- `listAgents()` doubles as the reachability probe (HTTP status, no auth).
- Expose `launchUrl` in `publicInstance` for `native-ui-link` instances only
  (an authenticated tailnet URL the operator already owns; record the
  trade-off in THREAT-MODEL).
- The dashboard opens `launchUrl` in a new tab for `native-ui-link`, shows the
  backend badge, and warns "Folder policy is not enforced inside Open WebUI
  Computer."
- The CLI accepts `--backend cptr` for `tailscale-url`.

Done when a mixed fleet (one Codeman, one cptr) lists both, health-checks
both, and opens each correctly.

## Phase D — cptr Level 2: proxied (done)

Shipped differently from the sketch below, based on the spike:

- **Routing contract:** all Hub-owned routes moved under `/_fleet/`
  (dashboard, its API, its terminal WebSocket, the switcher script). With a
  selected-host cookie, every other path and WebSocket goes to that host, so
  cptr's `/api/auth` no longer collides. Without the cookie, unprefixed
  `/api/...`, `/ws/...`, and `/healthz` stay Hub routes, so installed Workers
  and CLIs are unaffected. `/` redirects to `/_fleet/`.
- **No stored cptr credentials:** instead of the Hub logging in, a
  `CookieBridge` passes only `cptr_session` across the proxy, renamed per
  instance. Each browser signs in to cptr once; cptr logout works; two cptr
  hosts never share a session. Hub logout clears the bridged cookies.
- `nativeUi` gained `proxyUpgrade` (any WebSocket, with subprotocol and
  bridged-cookie forwarding) and `browserCookieNames`. The shared HTTP proxy
  gained per-backend `injectSwitcher` (on for Codeman, off for cptr because
  its license forbids altering its UI), `forwardReferer` (cptr routes
  previews by Referer), and `cookies`. Off-origin redirects are no longer
  rewritten into Hub paths.
- **CSRF is stricter:** every mutating request, Hub or proxied, now needs a
  same-origin Origin/Referer or the CSRF token. Previously, proxied `/api/*`
  mutations were exempt.
- The dashboard opens proxied UIs in a new tab, so it stays open at
  `/_fleet/`.

Original sketch:

- A cptr proxy adapter with `["native-ui-proxy"]`, built on
  `shared/http-proxy.ts` and `shared/ws-relay.ts`, with optional credential
  injection (spike item 4).
- A mock-cptr case in `multihost-harness.ts`.

## Phase E — cptr Level 3: setup and status (only if the spike passes items 1–2)

- `setup` offers "Codeman / cptr / both". The cptr option installs via pip or
  Docker (Docker mounts only the approved roots) and adds a user service.
- Introduce `BackendSupervisor` with Codeman and cptr implementations
  (install if missing, start if down).
- If cptr exposes a session or chat API, implement `sessions` (read-only list
  first) so cptr activity shows in the fleet view.

## Risks

- **Vendor scope creep:** if Open WebUI ships multi-machine support itself,
  Phases D–E lose value. Phases B–C are cheap and benefit any future backend.
- **Security model divergence:** cptr hosts have weaker path guarantees. Never
  present a cptr host as policy-enforced.
- **Wire compatibility:** renaming the connector messages would break mixed
  Hub and Worker versions; they stay as they are.

## Cleanup decisions (resolved in Phase A)

- Legacy `HOSTED_AGENTS_*` / `~/.hosted-agents` / `hosted-agents` names were
  removed in favour of `CLOUDAGENTFLEET_*`, `~/.cloudagentfleet`, and the
  `cloudagentfleet` CLI. The CLI moves an old config directory and removes the
  old user service once; there is no env-var fallback.
- Worker service commands use the real native verbs, and `status` no longer
  fails for an inactive service.
- `NodeRegistry` applies the heartbeat timeout on every read.
- The root `build` is the release build; every TypeScript test runner passes
  `--experimental-strip-types`; CI runs `pnpm typecheck`; `packageManager`
  pins pnpm 9.
- Stale docs (Tailscale Serve, architecture, CLI enrollment, roadmap) now
  match the code.
