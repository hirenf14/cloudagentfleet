---
"@cloudagentfleet/worker": patch
---

A job's result is the agent's whole reply to the prompt (its progress notes and final answer, in order), not one interim message: the Worker reads Codeman's full conversation and keeps reading until it stops changing, because Claude can write its last message just after the stop signal.
