---
"@cloudagentfleet/worker": patch
---

Jobs on a new Codeman session no longer come back empty: the Worker waits for the agent to finish starting before typing the first prompt, and presses Enter again if the prompt was typed but never sent.
