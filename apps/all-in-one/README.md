# @cloudagentfleet/all-in-one

Cloud Agent Fleet for a single machine: the **Hub** (with its dashboard), the
**Worker**, and the `cloudagentfleet` CLI in one install. Nothing else is
needed besides Node.js 22.6+.

```bash
npm install --global @cloudagentfleet/all-in-one
cloudagentfleet init        # choose "both"
```

`init` installs the Hub and the Worker as user services (no administrator
rights), enrolls this machine, and prints the dashboard address and password.

Use this package **instead of** `@cloudagentfleet/hub` and
`@cloudagentfleet/worker` (they share command names). To add more machines
later, install `@cloudagentfleet/worker` on each one and run
`cloudagentfleet init` there.

Prefer no Node.js at all? Download the `cloudagentfleet-<platform>-<arch>`
archive from the GitHub release; it carries its own runtime.

Guide: [Getting started](https://github.com/hirenf14/cloudagentfleet/blob/master/docs/GETTING-STARTED.md)
