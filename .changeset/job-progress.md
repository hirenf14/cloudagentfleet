---
"@cloudagentfleet/worker": minor
"@cloudagentfleet/hub": minor
"@cloudagentfleet/protocol": minor
---

A running job reports what the agent has written so far. The Worker re-reads a Claude job's reply every 2s and sends it as an "output" event; the Hub keeps it as the job's `progress` (the whole reply, growing), so a caller polling the job can show the work as it happens instead of only the final result.
