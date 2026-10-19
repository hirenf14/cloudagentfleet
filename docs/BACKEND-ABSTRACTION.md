# Host backend abstraction and cptr support

Status: proposed (2026-10-19). Codeman remains the default backend. This plan
adds a backend layer so a second per-machine backend — Open WebUI Computer
(`cptr`) — can be enrolled next to Codeman without forking the Hub, Worker, or
dashboard per backend.

## Goals

- One Hub, mixed fleet: machine A on Codeman, machine B on cptr, machine C on
  both (two instances on one machine).
- Hub, routes, and dashboard depend on **features**, never on a backend name.
- Adding a backend means adding one adapter module plus a registry entry.
- No behaviour change for existing Codeman users; persisted `hub.json` and
  already-installed Workers keep working.

## Non-goals

- Forking or modifying cptr. We only talk to an unmodified cptr instance.
- cptr behind the Worker connector (outbound-only) — direct tailnet only at
  first.
- Enforcing our folder-root policy inside cptr. cptr's own file browser,
  editor, and terminal are not mediated by the Hub; the dashboard must say so.

## Where Codeman is hard-wired today

| Area | Coupling |
| --- | --- |
| `packages/protocol/src/index.ts` | `CodemanInstance`, `CodemanSession`, `CodemanAgentMode`, `CodemanConnector*` messages; no backend discriminator on instances |
| `packages/codeman-bridge` | `CodemanInstanceAdapter` is the only adapter contract; the generic HTTP proxy, WebSocket relay, and HTML switcher injection live inside `CodemanHttpAdapter` |
| `apps/control-plane/src/hub.ts` | `CodemanHub` constructs Codeman adapters directly; `prepareNativeUi` → Codeman "cases"; Codeman-specific error text |
| `apps/control-plane/src/server.ts` | `cloudagentfleet_instance` cookie; `/api/fleet/select` only for `tailscale-url`; connector enrollment requires the `codeman` node capability; `publicInstance` hides the endpoint (fine for proxying, blocks a "link" mode) |
| `apps/node-agent` | `CodemanClient`/`CodemanWorkerRuntime`/`codeman-supervisor` are the only runtime; config assumes one backend per Worker (`CLOUDAGENTFLEET_CODEMAN_URL`, `CLOUDAGENTFLEET_CODEMAN_MODE`) |
| `apps/cli/bin/setup.mjs` | Codeman install/start, mode prompts, `:3000` default, registration payload has no backend field |
| `apps/dashboard/public` | "Codeman Fleet" labels, "Open Codeman UI" tied to `tailscale-url`, session UI assumes a Codeman PTY (`terminalBuffer`, input/resize) |

## Target design

### Protocol (`packages/protocol`)

```ts
export type HostBackend = "codeman" | "cptr";
export type ConnectionMode = "connector" | "tailscale-url";

/** What the Hub may do with an instance. Routes and UI gate on these. */
export type BackendFeature =
  | "sessions"           // list/create/input/resize/stop through the Hub API
  | "terminal"           // Hub WebSocket terminal proxy
  | "native-ui-proxy"    // Hub proxies the backend's own UI on the Hub origin
  | "native-ui-link"     // UI opens the backend directly (no proxy)
  | "workspace-suggest"  // path completion against the host filesystem
  | "jobs";              // fire-and-forget prompt jobs via the Worker

export interface HostInstance {
  id: string;
  label: string;
  backend: HostBackend;
  connectionMode: ConnectionMode;
  nodeId?: string;
  endpoint: string | null;
  status: "online" | "offline" | "unhealthy" | "revoked";
  features: BackendFeature[];
  workspacePolicy?: WorkspacePolicy;
  agents: AgentProfile[];
  workspaces: WorkspaceDescriptor[];
  lastSeenAt: string | null;
  createdAt: string;
}

export interface AgentProfile {
  id: string;
  name: string;
  ready: boolean;
  /** Backend-specific launch key (Codeman mode, cptr agent profile, …). */
  launch: string;
}
```

- `CodemanInstance` → `HostInstance`, `CodemanSession` → `HostSession`,
  `CodemanSessionEvent` → `HostSessionEvent`. `CodemanAgentMode` moves into the
  Codeman adapter; the protocol only carries `launch: string`.
- Validation of `launch` belongs to the backend definition, not the protocol.
- **Wire compatibility:** Hub and Worker ship as separate npm packages, so the
  Worker ↔ Hub messages (`codeman.request`, `codeman.response`,
  `codeman.session.event`, `/api/instances` registration) keep their names and
  shapes. A missing `backend` field means `"codeman"`. Renames are internal
  types only.
- **Persistence:** `HubStateStore.load()` migrates old records (`backend`
  absent → `"codeman"`, `capabilities` → `features` derived from
  `connectionMode`, `agents[].mode` → `launch`) and writes `schemaVersion: 2`.

### Adapters (`packages/codeman-bridge` → `packages/host-adapters`)

```
packages/host-adapters/src/
  contract.ts         HostAdapter + facet interfaces, BackendDefinition
  registry.ts         backend → definition; createAdapter(instance, deps)
  shared/http-proxy.ts  header filtering, redirect rewrite, switcher injection
  shared/ws-relay.ts    upgrade handshake + socket relay
  shared/sse.ts         readSseStream (today in codeman-bridge/wire.ts)
  codeman/http.ts       CodemanHttpAdapter
  codeman/connector.ts  CodemanConnectorAdapter
  codeman/wire.ts       status/event/agent mapping
  cptr/link.ts          Level 1 adapter
  cptr/proxy.ts         Level 2 adapter (after the spike)
```

```ts
export interface HostAdapter {
  readonly instance: HostInstance;
  readonly features: ReadonlySet<BackendFeature>;
  /** Health + discovery used by "Check health" and enrollment. */
  probe(): Promise<{ agents: AgentProfile[]; workspaces: WorkspaceDescriptor[]; version?: string }>;
  sessions?: SessionControl;        // feature "sessions"
  terminal?: TerminalProxy;         // feature "terminal"
  nativeUi?: NativeUiProxy;         // feature "native-ui-proxy"
  workspaces?: WorkspaceSuggestions; // feature "workspace-suggest"
  subscribeEvents?(listener: (event: HostSessionEvent) => void): () => void;
}

export interface BackendDefinition {
  backend: HostBackend;
  label: string;                         // "Codeman", "Open WebUI Computer"
  connectionModes: ConnectionMode[];
  validateEndpoint(url: string): void;   // e.g. tailnet HTTPS only
  validateLaunch(launch: string): boolean;
  createAdapter(instance: HostInstance, deps: AdapterDeps): HostAdapter;
}
```

Rules:

- A facet exists only if its feature is advertised; the Hub checks the
  feature, then calls the facet. A missing facet is a contract-test failure.
- The shared HTTP proxy keeps today's guarantees for every backend: strip
  client `cookie`/`authorization`/`origin`, drop upstream `set-cookie`, rewrite
  absolute redirects, inject the fleet switcher into HTML, inject server-side
  credentials.

### Hub (`apps/control-plane`)

- `CodemanHub` → `FleetHub`; builds adapters through the registry only.
- `requireFeature(instanceId, feature)` throws `UnsupportedError` (HTTP 409,
  in `errors.ts` beside `NotFoundError`/`UnavailableError`).
- `prepareNativeUi` → `adapter.nativeUi?.prepare?.()` (Codeman seeds cases;
  cptr does nothing).
- Session routes gate on `sessions`; the terminal upgrade gates on `terminal`;
  `/api/fleet/select/:id` gates on `native-ui-proxy`.
- New `GET /api/backends` → `[{ backend, label, features, connectionModes }]`
  so the dashboard has no hard-coded backend knowledge.
- `publicInstance` keeps hiding `endpoint`, except it exposes `launchUrl` for
  `native-ui-link` instances (an authenticated tailnet URL the operator
  already owns; recorded as an accepted trade-off in THREAT-MODEL).
- Connector enrollment checks the node capability for the instance's backend
  instead of hard-coding `codeman`.

### Dashboard (`apps/dashboard`)

- Labels come from `/api/backends` (`"Codeman Fleet"` → `"Fleet"`).
- Per instance, render actions from `features`: "Open UI" (proxy or link),
  "New session" only with `sessions`, terminal only with `terminal`.
- Show a backend badge and, for cptr, a note: "Folder policy is not enforced
  inside Open WebUI Computer."

### Worker and CLI

- Phase B introduces a `BackendSupervisor` interface (`ensure()`,
  `stopIfOwned()`) with the existing Codeman supervisor as its only
  implementation. A cptr supervisor comes in Phase E.
- CLI: `enroll tailscale-url --backend <codeman|cptr>` (default `codeman`).
  Help text and prompts read the backend label from the CLI's local copy of the
  registry metadata.

## Phases

Each phase lands as its own PR, with `pnpm typecheck`, `pnpm test`,
`pnpm test:multihost:mock` and `pnpm build:release` green.

### Phase A — cleanup (done in this branch)

Typecheck fixed (`@types/node`, `allowImportingTsExtensions`); the agent-mode
list, display names, status/event mapping, SSE parsing, and path-policy
helpers are each defined once (`protocol` + `codeman-bridge/src/wire.ts`); the
Hub throws typed errors instead of string-prefix status mapping; dead code
removed. See "Open cleanup decisions" for what was deliberately left.

### Phase B — abstraction refactor, Codeman only (no behaviour change)

1. Protocol: `HostInstance`/`HostSession`/`AgentProfile.launch`, `backend`,
   `features`; persistence migration with a fixture test of a v1 `hub.json`.
2. Rename `codeman-bridge` → `host-adapters`; move the proxy, relay, and SSE
   code into `shared/`.
3. Facet contract + registry; Codeman adapters implement it.
4. `FleetHub`, feature gating, `UnsupportedError`, `/api/backends`, cookie
   rename.
5. Dashboard renders from `features` and `/api/backends`.
6. **Adapter contract test suite**: one table-driven test run against every
   registered backend (with fake upstreams) — advertised features must have
   facets, the proxy must strip credentials, unsupported routes must return
   409.

Done when: an old `hub.json` loads unchanged in behaviour, an old Worker
enrolls against the new Hub, and no file outside `host-adapters/src/codeman/`
imports a Codeman-specific type.

### Spike S — cptr feasibility (gate for Phases D–E, about half a day)

Answer and record in this file:

1. **License:** do the cptr "Open Use" terms allow a third party to link to,
   reverse-proxy, and install (`pip install cptr`) it on a user's behalf?
   If not, stop after Phase C or drop cptr.
2. **API surface:** beyond `/v1/chat/completions`, are there stable routes for
   health, workspaces, sessions or chats, agent profiles, and ports? This
   decides whether cptr can ever advertise `sessions`.
3. **Proxyability:** does cptr work behind the Hub at the root of the Hub
   origin — login/JWT cookie, WebSockets, port previews, HMR? Do its paths
   collide with Hub-owned prefixes (`/api/auth`, `/api/fleet`,
   `/api/instances`, `/api/workers`, `/api/jobs`, `/api/audit`, `/healthz`,
   `/fleet-host-switcher.js`)?
4. **Auth handoff:** can the Hub hold a cptr credential or token and inject
   it, so the user doesn't log in twice?

### Phase C — cptr Level 1: link mode

- `cptr/link.ts`: features `["native-ui-link"]`; `probe()` = reachability of
  the endpoint (HTTP status, no auth).
- `enroll tailscale-url --backend cptr --url https://box.tailnet.ts.net:8000`.
- Dashboard: "Open Open WebUI Computer" opens `launchUrl` in a new tab, plus
  health status and a badge.

Done when: a mixed fleet (one Codeman, one cptr) lists both, health checks
both, and opens each correctly.

### Phase D — cptr Level 2: proxied (only if the spike passes item 3)

- `cptr/proxy.ts`: features `["native-ui-proxy"]` via the shared HTTP proxy
  and WebSocket relay; optional credential injection (spike item 4).
- Contract tests plus a mock-cptr case in `multihost-harness.ts`.

### Phase E — cptr Level 3: setup and status (only if the spike passes items 1–2)

- `setup` offers "Codeman / cptr / both"; the cptr option installs via pip or
  Docker (Docker mounts only the approved roots) and adds a user service.
- `BackendSupervisor` for cptr (install if missing, start if down).
- If cptr exposes a session or chat API: implement `sessions` (read-only list
  first) so cptr activity shows in the fleet view.

## Risks

- **Vendor scope creep:** if Open WebUI ships multi-machine support itself,
  Phases D–E lose value. Keep Phases B–C cheap; they also benefit any future
  backend.
- **Security model divergence:** cptr hosts have weaker path guarantees. The
  dashboard has to make this visible; never present a cptr host as
  policy-enforced.
- **Wire compatibility:** renaming protocol messages would break mixed Hub and
  Worker versions; this plan keeps them.

## Cleanup decisions (resolved)

- Legacy `HOSTED_AGENTS_*` / `~/.hosted-agents` / `hosted-agents` names
  were removed in favour of `CLOUDAGENTFLEET_*`, `~/.cloudagentfleet`, and the
  `cloudagentfleet` CLI. The CLI moves an old config directory and removes the
  old user service once; there is no env-var fallback.
- Worker service commands use the real native verbs (systemd
  `enable --now`/`disable --now`, launchd `load -w`/`unload -w`/`list
  <label>`, Task Scheduler `/Run`/`/End`/`/Query`/`/Delete`), and `status`
  no longer fails for an inactive service.
- `NodeRegistry` applies the heartbeat timeout on every read, so Workers go
  `offline` after missed heartbeats.
- The root `build` is the release build; per-package `build` scripts are gone;
  every TypeScript test runner passes `--experimental-strip-types`; CI runs
  `pnpm typecheck`; `packageManager` pins pnpm 9.
- Stale docs (Tailscale Serve, architecture, CLI enrollment, roadmap) were
  rewritten to match the code.
