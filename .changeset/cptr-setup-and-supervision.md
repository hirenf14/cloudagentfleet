---
"@cloudagentfleet/hub": minor
"@cloudagentfleet/ui": minor
"@cloudagentfleet/worker": minor
---

`cloudagentfleet setup` can add Open WebUI Computer (`cptr`) to a machine: choose `cptr` or `codeman,cptr` at the new backends prompt, confirm the install (pipx, uv, or pip), and optionally publish it on your tailnet with Tailscale Serve. The Worker supervises each selected backend (`CLOUDAGENTFLEET_BACKENDS`), starts cptr on loopback, and prints its first-run setup token. Existing Worker configs keep running Codeman only.
