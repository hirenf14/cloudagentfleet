---
"@cloudagentfleet/worker": patch
"@cloudagentfleet/hub": patch
---

Re-running `cloudagentfleet init` or `setup` on a machine whose Worker is already running no longer gets stuck. The running Worker service is stopped first (it held its ports and files busy, and starting a task that is already running does nothing, so the new settings never loaded), then the new one is started; if setup fails, the old service is started again.
