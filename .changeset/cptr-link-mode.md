---
"@cloudagentfleet/hub": minor
"@cloudagentfleet/ui": minor
"@cloudagentfleet/worker": minor
---

Add Open WebUI Computer (`cptr`) as an optional backend in link mode: `cloudagentfleet enroll tailscale-url --backend cptr --url …` registers a self-installed cptr, the Hub health-checks its `/api/health`, and the dashboard opens it in a new tab with a note that Hub folder policy does not apply there. Registration now rejects connection modes a backend does not support, and `enroll` fails when the instance comes back unhealthy instead of reporting success.
