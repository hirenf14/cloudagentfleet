---
"@cloudagentfleet/hub": minor
"@cloudagentfleet/ui": minor
"@cloudagentfleet/worker": minor
---

Host UIs now open inside the dashboard: **Open … UI** shows the host's own UI (for example Open WebUI Computer) next to the fleet sidebar, with **Open in new tab** and **Overview** above it. It still runs on the separate host-UI origin, so it cannot use your Hub session.

Signing in to the Hub now signs you in to a connector cptr too. On cptr's first start the Worker creates a `fleet` account and keeps its password on that machine (`~/.cloudagentfleet/cptr-credentials.json`, owner-only); the Hub asks the Worker for a session when your browser has none. For a cptr you already set up, put its account in that file. Set `CLOUDAGENTFLEET_CPTR_AUTO_SETUP=false` to keep cptr's first-run setup manual.

The dashboard can no longer be framed by other sites (`frame-ancestors 'none'`), and host UIs only by the dashboard and themselves.
