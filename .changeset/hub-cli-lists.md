---
"@cloudagentfleet/worker": minor
"@cloudagentfleet/hub": minor
"@cloudagentfleet/ui": minor
---

Ask the Hub from the command line: `cloudagentfleet workers` lists enrolled Workers with their status, version and last seen; `workers usage <id>` shows a Worker's agent limits; `instances` and `sessions` list what the Hub holds. All are read-only, take `--json`, and use the saved Hub settings on a Hub or Worker machine, or `--hub <url> --token <secret>` from anywhere else.
