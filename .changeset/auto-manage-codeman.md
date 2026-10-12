---
"@cloudagentfleet/hub": patch
"@cloudagentfleet/ui": patch
"@cloudagentfleet/worker": patch
---

Auto-install and supervise Codeman from the Worker by default (`HOSTED_AGENTS_MANAGE_CODEMAN` / `HOSTED_AGENTS_CODEMAN_INSTALL`), so operators only need `cloudagentfleet setup --run` or `cloudagentfleet run` on each host.
