# Security policy

Cloud Agent Fleet gives a signed-in operator shell access to their machines, so
we treat security reports seriously. The design is in
[`docs/THREAT-MODEL.md`](docs/THREAT-MODEL.md).

## Reporting a vulnerability

Please **do not open a public issue** for a vulnerability.

Report it privately through GitHub:
[Report a vulnerability](https://github.com/hirenf14/cloudagentfleet/security/advisories/new).
Include what you found, the version (`npm ls -g @cloudagentfleet/hub` or the
archive's `release-manifest.json`), and steps to reproduce it. Do not include
real credentials or tokens.

We aim to acknowledge a report within a few days, keep you updated while we
investigate, and credit you in the advisory if you wish.

## Supported versions

Only the latest release receives fixes. While we are on 0.x, update to the
newest version to get them.

## In scope

- Authentication or session handling in the Hub (dashboard sign-in, CSRF, the
  Worker token).
- Anything that lets a machine's UI, or a page inside it, reach the Hub API or
  another machine (the host-UI origin isolation and its cookie bridge).
- The Worker connector and tunnel: a Hub or Worker reaching more than it
  should.
- Secrets written where they should not be, or files created with loose
  permissions.
- The installers and `init`: commands run without confirmation, or from a
  source other than the project's official installers.

## Out of scope

- Findings that require an attacker who is already signed in to the Hub, or
  who already controls the machine: a signed-in operator can run commands on
  their machines by design.
- Vulnerabilities in Codeman, Open WebUI Computer, Claude Code, Cursor, or
  Tailscale themselves. Please report those to their projects; tell us too if
  Cloud Agent Fleet makes one worse.
- Exposure caused by publishing the Hub beyond your tailnet (for example
  enabling Tailscale Funnel), which the documentation advises against.

## For users

Keep the Hub on `127.0.0.1` behind Tailscale Serve, restrict it with Tailscale
ACLs, keep the Worker token and Hub password private, and never enable
Tailscale Funnel for it. See
[`docs/TAILSCALE-SERVE.md`](docs/TAILSCALE-SERVE.md).
