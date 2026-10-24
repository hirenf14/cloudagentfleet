# @cloudagentfleet/ui

## 0.3.3

## 0.3.2

## 0.3.1

## 0.3.0

## 0.2.1

### Patch Changes

- [#12](https://github.com/hirenf14/cloudagentfleet/pull/12) [`3e323c5`](https://github.com/hirenf14/cloudagentfleet/commit/3e323c55611d989f79bfe744bd46be7ed67b13b4) Thanks [@hirenf14](https://github.com/hirenf14)! - Cloud Agent Fleet is now released under the MIT license. The packages declare `"license": "MIT"` and include the license text, and the release archives ship `LICENSE` next to the Node.js license. Adds a code of conduct, a security policy with private vulnerability reporting, issue and pull request templates, and updated contribution guidelines.

## 0.2.0

### Minor Changes

- [#9](https://github.com/hirenf14/cloudagentfleet/pull/9) [`7a327ea`](https://github.com/hirenf14/cloudagentfleet/commit/7a327eacbcce19d518352ca4046357130ae67468) Thanks [@hirenf14](https://github.com/hirenf14)! - Introduce a host backend layer. Instances now carry a `backend` (currently `codeman`) and the features their adapter advertises; the Hub gates every backend action on those features (unsupported → HTTP 409) and adds `GET /api/backends`. The dashboard renders actions and labels from features and backends, and `cloudagentfleet enroll` accepts `--backend` (default `codeman`). Existing Hub state and Workers keep working unchanged.

- [#9](https://github.com/hirenf14/cloudagentfleet/pull/9) [`ef24f5d`](https://github.com/hirenf14/cloudagentfleet/commit/ef24f5d3c3c44081e003560a0dfb2422d3156230) Thanks [@hirenf14](https://github.com/hirenf14)! - Add Open WebUI Computer (`cptr`) as an optional backend in link mode: `cloudagentfleet enroll tailscale-url --backend cptr --url …` registers a self-installed cptr, the Hub health-checks its `/api/health`, and the dashboard opens it in a new tab with a note that Hub folder policy does not apply there. Registration now rejects connection modes a backend does not support, and `enroll` fails when the instance comes back unhealthy instead of reporting success.

- [#9](https://github.com/hirenf14/cloudagentfleet/pull/9) [`b10abcd`](https://github.com/hirenf14/cloudagentfleet/commit/b10abcdc3481fb0e6f5154e9157ca3f3e53874e8) Thanks [@hirenf14](https://github.com/hirenf14)! - Proxy Open WebUI Computer through the Hub and move the Hub under `/_fleet/`.

  - The dashboard and all Hub-owned browser routes now live under `/_fleet/` (`/` redirects there). Proxied host UIs (Codeman and cptr) move to a separate host-UI origin: a second listener on `CLOUDAGENTFLEET_HOST_PORT` (default 8788), which `cloudagentfleet hub serve` publishes on Tailscale HTTPS port 8443. Grant operators both 443 and 8443. Workers and the CLI keep using the unprefixed `/api/...` routes unchanged.
  - cptr hosts are proxied by default: the browser signs in to cptr once, and only cptr's session cookie crosses the proxy, renamed per instance. Use `enroll --link-only` to open cptr directly instead.
  - Every mutating request on either origin must now come from that origin, and the dashboard origin rejects mutations from host UIs.
  - "Open … UI" opens the host in a new tab so the dashboard stays available.

- [#9](https://github.com/hirenf14/cloudagentfleet/pull/9) [`40cb4d2`](https://github.com/hirenf14/cloudagentfleet/commit/40cb4d216607490e96ea3c2c2b278f96c087981f) Thanks [@hirenf14](https://github.com/hirenf14)! - `cloudagentfleet setup` can add Open WebUI Computer (`cptr`) to a machine: choose `cptr` or `codeman,cptr` at the new backends prompt, confirm the install (pipx, uv, or pip), and optionally publish it on your tailnet with Tailscale Serve. The Worker supervises each selected backend (`CLOUDAGENTFLEET_BACKENDS`), starts cptr on loopback, and prints its first-run setup token. Existing Worker configs keep running Codeman only.

- [#9](https://github.com/hirenf14/cloudagentfleet/pull/9) [`72c5fbe`](https://github.com/hirenf14/cloudagentfleet/commit/72c5fbe005f6c9d936593178d3a7e3f862ae0a76) Thanks [@hirenf14](https://github.com/hirenf14)! - Host UIs now open inside the dashboard: **Open … UI** shows the host's own UI (for example Open WebUI Computer) next to the fleet sidebar, with **Open in new tab** and **Overview** above it. It still runs on the separate host-UI origin, so it cannot use your Hub session.

  Signing in to the Hub now signs you in to a connector cptr too. On cptr's first start the Worker creates a `fleet` account and keeps its password on that machine (`~/.cloudagentfleet/cptr-credentials.json`, owner-only); the Hub asks the Worker for a session when your browser has none. For a cptr you already set up, put its account in that file. Set `CLOUDAGENTFLEET_CPTR_AUTO_SETUP=false` to keep cptr's first-run setup manual.

  The dashboard can no longer be framed by other sites (`frame-ancestors 'none'`), and host UIs only by the dashboard and themselves.

- [#9](https://github.com/hirenf14/cloudagentfleet/pull/9) [`0c930c2`](https://github.com/hirenf14/cloudagentfleet/commit/0c930c2d43e120ed5c792a6610ad252724f21070) Thanks [@hirenf14](https://github.com/hirenf14)! - A calmer dashboard, in the style of Open WebUI Computer: black surfaces, hairline borders, 12px type with monospace details, and colour only for status. The top bar is gone; the sidebar holds the brand, live status, search, Recent, Machines, and a new **Sign out**. A machine's page is a short column of Start / Continue / Recent / Details. The sidebar stays usable with many machines and sessions: search shows every match, machines are capped at six (online first, with **Show all**), each machine's sessions fold away, running sessions show three at a time, and ended ones fold into one line. The sign-in page and Hub notices match.

- [#9](https://github.com/hirenf14/cloudagentfleet/pull/9) [`56facb8`](https://github.com/hirenf14/cloudagentfleet/commit/56facb8a7f0bee9ebf6082a51002974ea600ab50) Thanks [@hirenf14](https://github.com/hirenf14)! - **Breaking:** remove the legacy "Hosted Agents" names.

  - Environment variables now use the `CLOUDAGENTFLEET_` prefix (for example `CLOUDAGENTFLEET_AUTH_TOKEN`, `CLOUDAGENTFLEET_UI_PASSWORD`, `CLOUDAGENTFLEET_CODEMAN_URL`). The old `HOSTED_AGENTS_*` and unprefixed `CODEMAN_URL` / `CODEMAN_INSTANCE_ID` / `CODEMAN_USERNAME` / `CODEMAN_PASSWORD` names are no longer read.
  - Configuration moves to `~/.cloudagentfleet/`. The CLI moves an existing `~/.hosted-agents/` directory and removes the old `hosted-agents` user service on first run; run `cloudagentfleet worker install` again afterwards.
  - The `hosted-agents` command alias is removed; use `cloudagentfleet`.
  - Hub cookies are renamed, so browsers sign in again once after upgrading.

  Also fixes `worker start|stop|status|remove` on Windows (Task Scheduler verbs), macOS (`launchctl list <label>`), and Linux (`remove` now disables and deletes the unit), and marks Workers offline after missed heartbeats.

- [#9](https://github.com/hirenf14/cloudagentfleet/pull/9) [`9b067ec`](https://github.com/hirenf14/cloudagentfleet/commit/9b067ec13f9c2be2adc7f153b17332e80a5e34de) Thanks [@hirenf14](https://github.com/hirenf14)! - Standalone installs and a guided setup.

  - **Two installs, from npm or a release archive with its own Node runtime**: `@cloudagentfleet/hub` now includes the dashboard (`@cloudagentfleet/ui` is no longer needed beside it), the CLI, and the Worker, which runs on the Hub's machine only if you choose it; `@cloudagentfleet/worker` goes on each machine you add. Releases attach `cloudagentfleet-hub-*` and `cloudagentfleet-worker-*` archives per platform.
  - **`cloudagentfleet init`** sets up a machine in one pass: on the Hub it installs the Hub service and asks whether to also run a Worker there; for a Worker it asks what the machine offers (Codeman, Open WebUI Computer, Claude Code CLI, Cursor Agent CLI) and confirm once to install them with their official installers; it runs the Hub and Worker as user services, enrolls the machine, and prints the dashboard address and password. Safe to rerun.
  - **The Hub runs as a service**: `cloudagentfleet hub service install|start|status|stop|remove`, plus `hub run` and `hub token` (the Worker token new machines need). An installed Hub keeps its state in `~/.cloudagentfleet/` (an existing `./data/hub.json` is still used).
  - **In the dashboard**: a Getting started guide that checks itself off, **+ Add machine** with this Hub's commands (the token never reaches the browser), **?** help with plain explanations and shortcuts (`/` or Ctrl/⌘+K to search), and hints under each machine action.
  - New [getting-started guide](https://github.com/hirenf14/cloudagentfleet/blob/master/docs/GETTING-STARTED.md).

### Patch Changes

- [#9](https://github.com/hirenf14/cloudagentfleet/pull/9) [`b8940dd`](https://github.com/hirenf14/cloudagentfleet/commit/b8940dd05e5b4e596074a7941ada302bc2ad9c4c) Thanks [@hirenf14](https://github.com/hirenf14)! - Auto-install and supervise Codeman from the Worker by default (`CLOUDAGENTFLEET_MANAGE_CODEMAN` / `CLOUDAGENTFLEET_CODEMAN_INSTALL`), so operators only need `cloudagentfleet setup --run` or `cloudagentfleet run` on each host.

- [#9](https://github.com/hirenf14/cloudagentfleet/pull/9) [`fb4ddaf`](https://github.com/hirenf14/cloudagentfleet/commit/fb4ddaf0e99316101e27b7f81b8029f35a5d9cea) Thanks [@hirenf14](https://github.com/hirenf14)! - `cloudagentfleet init` now introduces Codeman and Open WebUI Computer (what each offers) and lets you pick one or both, then asks separately which coding agents to install (optional; nothing is uninstalled). The dashboard's **+ Add machine** covers every installation: another machine or the Hub's own machine, Windows, macOS, or Linux, and a download (Node included, with the exact download, extract, and `init` commands) or npm. The getting-started guide has the same commands per system.

- [#9](https://github.com/hirenf14/cloudagentfleet/pull/9) [`57fc5ed`](https://github.com/hirenf14/cloudagentfleet/commit/57fc5ed283d7c1d2d5c441f0de82381d3eaf36e0) Thanks [@hirenf14](https://github.com/hirenf14)! - The dashboard sidebar stays compact with many sessions: a **Recent** list shows the five latest sessions across all machines, each machine lists only its running sessions (newest first, three at a time), and ended sessions fold into one "N ended" toggle. The selected session always stays visible.

- [#9](https://github.com/hirenf14/cloudagentfleet/pull/9) [`0d3fcd5`](https://github.com/hirenf14/cloudagentfleet/commit/0d3fcd571f97f9d997f50ccd96e9ac04b61c9a4b) Thanks [@hirenf14](https://github.com/hirenf14)! - Fixes from verifying Open WebUI Computer end to end:

  - **Workers survive a Hub restart.** A Hub restart forgot enrolled nodes; the Worker's next heartbeat failed and crashed the whole process (stopping Codeman and cptr, and orphaning Codeman). Workers now re-enroll automatically and keep running.
  - **The dashboard stays usable with an offline host.** One unreachable instance (for example an offline Worker) blanked the whole fleet view.
  - **No cached host UI after Hub logout.** Proxied pages are now cache-keyed on cookies and revalidated, so a page cached while signed in cannot be shown after logout.
  - The "folder policy is not enforced" note now shows for every host whose sessions the Hub doesn't mediate, including proxied cptr.
  - `enroll tailscale-url` accepts loopback URLs (as the Hub already did) for a Hub on the same machine.
  - Setup: `tmux` is detected correctly, the enroll hint suggests the local cptr URL, and the setup-token hint points to the token file; `enroll` names the right backend in its success message.

- [#9](https://github.com/hirenf14/cloudagentfleet/pull/9) [`650288f`](https://github.com/hirenf14/cloudagentfleet/commit/650288f7f346999be0c9b27aacb14098e5ef052c) Thanks [@hirenf14](https://github.com/hirenf14)! - Hardening from review: the Hub proxy and WebSocket relay now verify upstream TLS certificates for non-loopback hosts; `hub stop` removes only the Hub's own Serve routes instead of resetting all of Serve; an upgraded legacy `hosted-agents` service keeps running (it is replaced by `worker install` rather than removed on `run`); a Codeman daemon that never becomes ready is stopped instead of orphaned; an optional cptr failure no longer stops the Worker; cptr's setup token is kept out of logs; session calls no longer clone the whole Hub state.

- [#9](https://github.com/hirenf14/cloudagentfleet/pull/9) [`00d11a7`](https://github.com/hirenf14/cloudagentfleet/commit/00d11a79e8bcec6985a5f5495a8920fd268d529d) Thanks [@hirenf14](https://github.com/hirenf14)! - Internal cleanup: one shared Codeman wire-format module for the Hub and Worker, typed Hub errors, a working `pnpm typecheck`, and a fixed "optional" label in the new-session dialog.

- [#9](https://github.com/hirenf14/cloudagentfleet/pull/9) [`60ec08a`](https://github.com/hirenf14/cloudagentfleet/commit/60ec08a7f2bc8d4ae5e85871432937de0fa3e949) Thanks [@hirenf14](https://github.com/hirenf14)! - Fixes found running a real Worker service:

  - A Hub with a UI password but no `CLOUDAGENTFLEET_AUTH_TOKEN` now generates a Worker token in its data directory (`hub-worker-token`, owner-only), and setup asks for it, so Workers can enroll.
  - `cloudagentfleet worker install` records your shell's PATH, so Codeman sessions and cptr find `claude`, `codex`, and `agent` under systemd and launchd. Reinstall the service to pick this up.
  - `cloudagentfleet run` exits with the Worker's exit code, so the service manager restarts a failed Worker.
  - The Worker finds cptr in `~/.local/bin` or at the path setup recorded, and setup installs `claude-agent-sdk` with cptr when Claude Code is present.
  - The dashboard no longer offers to start Hub sessions on a cptr host.

## 0.1.8

### Patch Changes

- [`895eaa1`](https://github.com/hirenf14/cloudagentfleet/commit/895eaa1cb81a75bc617020cc984c3b4f10ed66bb) Thanks [@hirenf14](https://github.com/hirenf14)! - Republish packages after ui@0.1.7 registry tarball was missing.

## 0.1.7

### Patch Changes

- [`e8300b3`](https://github.com/hirenf14/cloudagentfleet/commit/e8300b3321289b1544c1cd8026c01fb363ab666e) Thanks [@hirenf14](https://github.com/hirenf14)! - Keep Shell (raw CLI) in the agent list and clarify provider CLI labels in Start session.

- [`e8300b3`](https://github.com/hirenf14/cloudagentfleet/commit/e8300b3321289b1544c1cd8026c01fb363ab666e) Thanks [@hirenf14](https://github.com/hirenf14)! - Use cloudagentfleet consistently in CLI help and Hub branding (hosted-agents remains a compatibility alias).

## 0.1.4

### Patch Changes

- [`c917cb8`](https://github.com/hirenf14/cloudagentfleet/commit/c917cb83c20000d1d42a4a4eeefde5c9935f1a6b) Thanks [@hirenf14](https://github.com/hirenf14)! - Add GitHub repository, homepage, and bugs links to published packages.

## 0.1.3

### Patch Changes

- [`c659eba`](https://github.com/hirenf14/cloudagentfleet/commit/c659eba74f7328de378d9f73799bf6c938b7f7a3) Thanks [@hirenf14](https://github.com/hirenf14)! - Add package READMEs with install and start instructions for npm.

## 0.1.1

### Patch Changes

- [`ad68c04`](https://github.com/hirenf14/cloudagentfleet/commit/ad68c04bf6bcd4419f007e609d1fd6a3fcef339a) Thanks [@hirenf14](https://github.com/hirenf14)! - Initial public release of Cloud Agent Fleet Hub, UI, and Worker packages.
