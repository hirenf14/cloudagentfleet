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

Public packages, always released together on one version (Changesets
`fixed`): the Hub, Worker, and all-in-one packages each ship the same
`cloudagentfleet` CLI, so they must not drift apart.

- `@cloudagentfleet/hub`: Hub, bundled dashboard, CLI
- `@cloudagentfleet/worker`: Worker, CLI
- `@cloudagentfleet/all-in-one`: Hub, dashboard, Worker, CLI
- `@cloudagentfleet/ui`: dashboard files only (optional; for custom hosting)

### Draft a changelog entry

On every user-facing PR:

```bash
pnpm changeset
```

Pick the packages the change is visible in and a bump (`patch`, `minor`, or
`major`; while we are on 0.x, `minor` marks a breaking change). Write the
summary for operators, and commit the file under `.changeset/` with your PR.
Every public package gets the highest bump anyway.

### Automated publish

One-time setup:

1. Repository secret `NPM_TOKEN`: an npm automation (or granular) token with
   publish rights for the whole `@cloudagentfleet` scope. A granular token
   limited to existing packages cannot publish a new one, such as
   `@cloudagentfleet/all-in-one` on its first release.
2. Actions may open pull requests (Settings → Actions → Workflow permissions:
   read and write, allow creating pull requests).

Each release:

1. Merge feature PRs with changeset files into `master`.
2. The **Release** workflow typechecks, tests, builds, and verifies the npm
   packs, then opens or updates the **Version Packages** PR (version bumps,
   `CHANGELOG.md` entries, changeset files removed).
3. Merge that PR. The workflow publishes all four packages to npm with build
   provenance, creates a GitHub Release per package, and marks the Worker's
   release as **Latest**.
4. Standalone archives (hub, worker, all-in-one for Windows, macOS, and Linux)
   are built and attached to that Latest release, which is what the
   `releases/latest/download/…` links in the docs and dashboard use.

Rehearse locally without publishing:

```bash
pnpm changeset status                 # what would be bumped
pnpm build:release && pnpm verify:packs
pnpm -r publish --dry-run --no-git-checks --access public
```

Manual publish (maintainers, only if the workflow cannot run):

```bash
pnpm version-packages   # changeset version
pnpm release            # build:release + changeset publish
```

`build:release` writes ignored build outputs only:

- Hub → `apps/control-plane/dist/`: Hub bundle, CLI, and `public/` (the UI)
- Worker → `apps/node-agent/dist/`: Worker bundle and CLI
- All-in-one → `apps/all-in-one/dist/`: all of the above
- UI → `apps/dashboard/dist/public/` (drafts excluded)
- `dist/cli-bundle/` for the standalone archives

`pnpm verify:packs` fails the pipeline if an npm tarball would miss its
bundles or UI, or include `src/`, `bin/`, TypeScript, tests, or draft UI files.
`pnpm package:standalone` builds this platform's three archives from
`dist/cli-bundle/` with a private Node runtime.

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
