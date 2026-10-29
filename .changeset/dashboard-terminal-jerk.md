---
"@cloudagentfleet/worker": patch
"@cloudagentfleet/hub": patch
---

The dashboard terminal streams live output smoothly instead of jumping on every refresh: the Worker now forwards Codeman's live output, and the dashboard appends it instead of repainting from snapshots.
