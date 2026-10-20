---
"@cloudagentfleet/hub": patch
"@cloudagentfleet/ui": patch
"@cloudagentfleet/worker": patch
---

Hardening from review: the Hub proxy and WebSocket relay now verify upstream TLS certificates for non-loopback hosts; `hub stop` removes only the Hub's own Serve routes instead of resetting all of Serve; an upgraded legacy `hosted-agents` service keeps running (it is replaced by `worker install` rather than removed on `run`); a Codeman daemon that never becomes ready is stopped instead of orphaned; an optional cptr failure no longer stops the Worker; cptr's setup token is kept out of logs; session calls no longer clone the whole Hub state.
