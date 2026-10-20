---
"@cloudagentfleet/hub": minor
"@cloudagentfleet/ui": minor
"@cloudagentfleet/worker": minor
---

**Breaking:** remove the legacy "Hosted Agents" names.

- Environment variables now use the `CLOUDAGENTFLEET_` prefix (for example `CLOUDAGENTFLEET_AUTH_TOKEN`, `CLOUDAGENTFLEET_UI_PASSWORD`, `CLOUDAGENTFLEET_CODEMAN_URL`). The old `HOSTED_AGENTS_*` and unprefixed `CODEMAN_URL` / `CODEMAN_INSTANCE_ID` / `CODEMAN_USERNAME` / `CODEMAN_PASSWORD` names are no longer read.
- Configuration moves to `~/.cloudagentfleet/`. The CLI moves an existing `~/.hosted-agents/` directory and removes the old `hosted-agents` user service on first run; run `cloudagentfleet worker install` again afterwards.
- The `hosted-agents` command alias is removed; use `cloudagentfleet`.
- Hub cookies are renamed, so browsers sign in again once after upgrading.

Also fixes `worker start|stop|status|remove` on Windows (Task Scheduler verbs), macOS (`launchctl list <label>`), and Linux (`remove` now disables and deletes the unit), and marks Workers offline after missed heartbeats.
