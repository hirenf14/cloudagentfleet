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

Link the CLI onto your PATH so every documented command works the same way as a
global install:

```bash
pnpm --filter @hosted-agents/cli link --global
cloudagentfleet --help
```

`hosted-agents` is a compatibility alias for the same binary.

## Everyday commands

| Goal | Command |
| --- | --- |
| Build all packages | `pnpm build` |
| Typecheck | `pnpm typecheck` |
| Unit / package tests | `pnpm test` |
| Start Hub (Controller) | `pnpm --filter @hosted-agents/control-plane dev` |
| Start dashboard assets | `pnpm --filter @hosted-agents/dashboard dev` |
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

## Release artifacts (maintainers)

```bash
pnpm build:release
pnpm package:standalone
```

`build:release` produces the npm package contents under `dist/release`.
`package:standalone` wraps that tree with a platform Node runtime and a
`cloudagentfleet` launcher. After unpacking a standalone archive, run
`cloudagentfleet …` — do not rely on install shell scripts.

## Branch and pull request workflow

1. Create a branch from `master` for one focused change.
2. Keep commits small and descriptive (why over what).
3. Run `pnpm typecheck` and `pnpm test` before opening a PR.
4. Open a PR against `master` with a short summary and a test plan.
5. Link related docs or issues when behavior or operator instructions change.

## Documentation expectations

- Operator-facing steps must use `cloudagentfleet …` (or the documented pnpm
  filters for Hub/dashboard process startups).
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
