---
"@cloudagentfleet/hub": patch
"@cloudagentfleet/ui": patch
"@cloudagentfleet/worker": patch
---

Fixes found running a real Worker service:

- A Hub with a UI password but no `CLOUDAGENTFLEET_AUTH_TOKEN` now generates a Worker token in its data directory (`hub-worker-token`, owner-only), and setup asks for it, so Workers can enroll.
- `cloudagentfleet worker install` records your shell's PATH, so Codeman sessions and cptr find `claude`, `codex`, and `agent` under systemd and launchd. Reinstall the service to pick this up.
- `cloudagentfleet run` exits with the Worker's exit code, so the service manager restarts a failed Worker.
- The Worker finds cptr in `~/.local/bin` or at the path setup recorded, and setup installs `claude-agent-sdk` with cptr when Claude Code is present.
- The dashboard no longer offers to start Hub sessions on a cptr host.
