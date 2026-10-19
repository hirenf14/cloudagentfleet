---
"@cloudagentfleet/hub": minor
"@cloudagentfleet/ui": minor
"@cloudagentfleet/worker": minor
---

Proxy Open WebUI Computer through the Hub and move the Hub under `/_fleet/`.

- The dashboard and all Hub-owned browser routes now live under `/_fleet/` (`/` redirects there). Proxied host UIs (Codeman and cptr) move to a separate host-UI origin: a second listener on `CLOUDAGENTFLEET_HOST_PORT` (default 8788), which `cloudagentfleet hub serve` publishes on Tailscale HTTPS port 8443. Grant operators both 443 and 8443. Workers and the CLI keep using the unprefixed `/api/...` routes unchanged.
- cptr hosts are proxied by default: the browser signs in to cptr once, and only cptr's session cookie crosses the proxy, renamed per instance. Use `enroll --link-only` to open cptr directly instead.
- Every mutating request on either origin must now come from that origin, and the dashboard origin rejects mutations from host UIs.
- "Open … UI" opens the host in a new tab so the dashboard stays available.
