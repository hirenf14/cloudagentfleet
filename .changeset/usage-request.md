---
"@cloudagentfleet/worker": minor
"@cloudagentfleet/hub": minor
---

The Hub can ask a Worker for its coding agents' usage limits. New connector operation `usage.read` and Hub route `POST /api/workers/:id/usage`. The Worker answers by calling the agents themselves: Claude Code's `/usage` (session and weekly percent used), Codex's rate limits from its newest session, and the Cursor account from `agent status`.
