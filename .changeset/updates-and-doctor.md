---
"@cloudagentfleet/worker": minor
"@cloudagentfleet/hub": minor
"@cloudagentfleet/ui": minor
---

Update notices, automatic Worker updates, and a real `cloudagentfleet doctor`. The Hub checks npm every few hours (`CLOUDAGENTFLEET_UPDATE_CHECK=0` turns it off) and the dashboard shows a banner when the Hub or any Worker is behind; Workers now report their version when they enroll. `cloudagentfleet update` installs the newest release (`--check` only looks), and a Worker service started with `run --restart` installs updates itself and restarts on them (`cloudagentfleet update auto off` or `CLOUDAGENTFLEET_AUTO_UPDATE=0` to stop; a Hub only reports unless you turn it on). `doctor` now checks Node, the CLI/Hub versions, the Hub link and token, whether each Worker is online, the Codeman and Open WebUI Computer backends, the service, and recent log errors, with a fix for each.
