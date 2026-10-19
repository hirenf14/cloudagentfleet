---
"@cloudagentfleet/hub": patch
"@cloudagentfleet/ui": patch
"@cloudagentfleet/worker": patch
---

Fixes from verifying Open WebUI Computer end to end:

- **Workers survive a Hub restart.** A Hub restart forgot enrolled nodes; the Worker's next heartbeat failed and crashed the whole process (stopping Codeman and cptr, and orphaning Codeman). Workers now re-enroll automatically and keep running.
- **The dashboard stays usable with an offline host.** One unreachable instance (for example an offline Worker) blanked the whole fleet view.
- **No cached host UI after Hub logout.** Proxied pages are now cache-keyed on cookies and revalidated, so a page cached while signed in cannot be shown after logout.
- The "folder policy is not enforced" note now shows for every host whose sessions the Hub doesn't mediate, including proxied cptr.
- `enroll tailscale-url` accepts loopback URLs (as the Hub already did) for a Hub on the same machine.
- Setup: `tmux` is detected correctly, the enroll hint suggests the local cptr URL, and the setup-token hint points to the token file; `enroll` names the right backend in its success message.
