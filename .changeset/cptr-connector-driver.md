---
"@cloudagentfleet/hub": minor
"@cloudagentfleet/worker": minor
---

Open WebUI Computer can run behind the Worker connector: enroll it with `cloudagentfleet enroll connector --backend cptr` (setup's default for cptr), and the Hub reaches it through a tunnel on the Worker's outbound connection, so the cptr machine needs no inbound port. cptr's UI, terminal, port previews, and its own agent chat work through the Hub as they do over the tailnet. Workers also re-enroll after a Hub restart and no longer let a slow request stall other connector traffic.
