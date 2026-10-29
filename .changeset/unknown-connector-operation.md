---
"@cloudagentfleet/worker": patch
---

A Worker answers a connector operation it does not know with an error instead of dropping its connection to the Hub. An older Worker that received a newer operation (such as `usage.read`) used to reconnect, which cancelled the Hub's other pending requests to it.
