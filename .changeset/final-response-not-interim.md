---
"@cloudagentfleet/worker": patch
---

A job's result is the agent's final message, not an interim one: after the stop signal the Worker keeps reading the response until it stops changing, because Claude can write its last message just after the signal.
