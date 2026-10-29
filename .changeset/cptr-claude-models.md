---
"@cloudagentfleet/worker": patch
"@cloudagentfleet/hub": patch
---

Open WebUI Computer offers the current Claude models. It hard-codes an older list, so the Worker now adds the current Claude Code models (and sets the default) through cptr's admin API each time it starts or finds cptr running. Models and a default you set yourself are kept; `~/.cloudagentfleet/cptr-models.json` replaces the built-in list, and `CLOUDAGENTFLEET_CPTR_SYNC_MODELS=false` turns this off.
