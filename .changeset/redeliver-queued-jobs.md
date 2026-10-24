---
"@cloudagentfleet/hub": patch
---

Jobs created while a Worker is reconnecting are no longer stuck in "queued": the Hub re-sends them when the Worker connects.
