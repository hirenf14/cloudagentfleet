# Contributing to Cloud Agent Fleet

Thanks for helping improve Cloud Agent Fleet. This guide covers local setup,
checks, and how to open a change.

## Prerequisites

- Node.js **22.6+** (needed for `--experimental-strip-types`)
- [pnpm](https://pnpm.io) **9+**
- Git

Optional for live Codeman / Tailscale paths: Codeman, Tailscale CLI, and provider
CLIs on the machines under test.

## Clone and install

```bash
git clone https://github.com/hirenf14/cloudagentfleet.git
cd cloudagentfleet
pnpm install
```

Link the public package CLIs onto your PATH:

```bash
pnpm --filter @cloudagentfleet/worker link --global
pnpm --filter @cloudagentfleet/hub link --global
cloudagentfleet --help
cloudagentfleet-hub --help
```

`hosted-agents` is a compatibility alias for the worker CLI.

## Everyday commands

| Goal | Command |
| --- | --- |
| Build all packages | `pnpm build` |
| Typecheck | `pnpm typecheck` |
| Unit / package tests | `pnpm test` |
| Start Hub | `pnpm --filter @cloudagentfleet/hub dev` |
| Start UI asset checks | `pnpm --filter @cloudagentfleet/ui dev` |
| Guided machine setup | `cloudagentfleet setup` |
| Environment check | `cloudagentfleet doctor` |
| Enroll a host | `cloudagentfleet enroll …` |
| Tailscale Hub Serve | `cloudagentfleet hub serve` / `status` / `stop` |
| Worker service | `cloudagentfleet worker install\|start\|status\|stop\|remove` |

Prefer these CLI entry points over invoking files under `apps/cli/bin` or
`scripts/` directly.

## Multi-host checks

Mock harness (no Codeman or secrets required):

```bash
pnpm test:multihost:mock
```

Live harness (two already-running Codeman HTTP endpoints):

```bash
pnpm test:multihost:live
```

See [`docs/MULTIHOST-E2E.md`](docs/MULTIHOST-E2E.md) for environment variables
and expected evidence output.

## Releases

Public packages (linked versions via Changesets):

- `@cloudagentfleet/hub`
- `@cloudagentfleet/ui`
- `@cloudagentfleet/worker`

### Draft a changelog entry

On every user-facing PR:

```bash
pnpm changeset
```

Commit the new file under `.changeset/` with your PR.

### Automated publish

1. Add repository secret `NPM_TOKEN` (Automation token with publish rights for
   `@cloudagentfleet/*`).
2. Ensure Actions can open PRs (read/write for Contents and Pull requests).
3. Merge feature PRs into `master` that include changeset files.
4. The **Release** workflow opens or updates a **Version Packages** PR
   (bumps versions + `CHANGELOG.md`).
5. Merge that PR to publish all three packages to npm and create GitHub Releases.
6. Standalone platform archives build when publish succeeds.

Manual maintainer commands:

```bash
pnpm changeset
pnpm version-packages
pnpm build:release
pnpm release
```

`build:release` bundles Hub and Worker into ignored `dist/` CLI binaries
(protocol inlined) and stages a flat `dist/cli-bundle` for standalone archives.
`package:standalone` wraps that CLI bundle with a private Node runtime.

## Branch and pull request workflow

1. Create a branch from `master` for one focused change.
2. Keep commits small and descriptive (why over what).
3. Run `pnpm typecheck` and `pnpm test` before opening a PR.
4. Add a changeset when the change affects operators or package consumers.
5. Open a PR against `master` with a short summary and a test plan.
6. Link related docs or issues when behavior or operator instructions change.

## Documentation expectations

- Operator-facing steps must use `cloudagentfleet …` / `cloudagentfleet-hub`
  (or the documented pnpm filters for Hub/UI process startups).
- Do not document `node apps/cli/bin/…` paths or one-off shell install scripts
  as the supported path.
- Update README and the relevant file under `docs/` in the same PR when you
  change CLI flags, enrollment, or Hub Serve behavior.

## Security and secrets

- Never commit credentials, Tailscale auth keys, Hub UI passwords, or
  `.env` files with secrets.
- Do not enable Tailscale Funnel in examples.
- Prefer loopback Hub binds (`127.0.0.1`) and Tailscale ACLs for private access.

## Code of conduct for reviews

- Prefer small, reviewable diffs.
- Match existing TypeScript / module style in the package you touch.
- Call out threat-model impact for auth, proxy, or enrollment changes
  (see [`docs/THREAT-MODEL.md`](docs/THREAT-MODEL.md)).

Questions that do not fit an issue comment can go on the PR discussion thread.
