---
"@cloudagentfleet/hub": minor
"@cloudagentfleet/ui": minor
"@cloudagentfleet/worker": minor
---

Proxy Open WebUI Computer through the Hub and move the Hub under `/_fleet/`.

- The dashboard and all Hub-owned browser routes now live under `/_fleet/` (`/` redirects there). While a host's UI is open, every other path on the Hub origin, including WebSockets, belongs to that host. Workers and the CLI keep using the unprefixed `/api/...` routes unchanged.
- cptr hosts are proxied by default: the browser signs in to cptr once, and only cptr's session cookie crosses the proxy, renamed per instance. Use `enroll --link-only` to open cptr directly instead.
- Every mutating request through the Hub, including proxied host requests, must now come from the Hub origin.
- "Open … UI" opens the host in a new tab so the dashboard stays available.
