# Contributing to Cloud Agent Fleet

Thanks for helping improve Cloud Agent Fleet. This guide covers the ground
rules, local setup, checks, and how to open a change.

## Ground rules

- **Be kind.** Everyone taking part follows the
  [code of conduct](CODE_OF_CONDUCT.md).
- **Security problems are reported privately**, never as public issues. See
  [SECURITY.md](SECURITY.md).
- **Start with an issue** for anything bigger than a small fix, so we can agree
  on the approach before you spend time on it.
- **Your contribution is licensed under the project's license.** Cloud Agent
  Fleet is [MIT-licensed](LICENSE). By opening a pull request you confirm you
  wrote the change (or have the right to submit it) and agree it is released
  under that license. There is no CLA to sign. Please do not copy in code that
  is under an incompatible license.
- **Third-party projects stay third-party.** We install Codeman, Open WebUI
  Computer, and the coding agents with their official installers and never
  bundle or modify them. Open WebUI Computer's license forbids changing its
  branding, so changes must not alter or cover its UI. See
  [docs/ACKNOWLEDGEMENTS.md](docs/ACKNOWLEDGEMENTS.md).

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
| Preview the website and docs | `pnpm site:build` (writes `site-dist/`) |
| Guided machine setup | `cloudagentfleet init` |
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
`fixed`): the Hub and Worker packages ship the same `cloudagentfleet` CLI
and Worker, so they must not drift apart.

- `@cloudagentfleet/hub`: Hub, bundled dashboard, CLI, and the Worker (runs only
  if `init` is told to, for the Hub's own machine)
- `@cloudagentfleet/worker`: Worker, CLI
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
   publish rights for the whole `@cloudagentfleet` scope (a granular token
   limited to existing packages cannot publish a new package later).
2. Actions may open pull requests (Settings → Actions → Workflow permissions:
   read and write, allow creating pull requests).

Each release:

1. Merge feature PRs with changeset files into `master`.
2. The **Release** workflow typechecks, tests, builds, and verifies the npm
   packs, then opens or updates the **Version Packages** PR (version bumps,
   `CHANGELOG.md` entries, changeset files removed).
3. Merge that PR. The workflow publishes all three packages to npm with build
   provenance, creates a GitHub Release per package, and marks the Worker's
   release as **Latest**.
4. Standalone archives (hub and worker for Windows, macOS, and Linux)
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

- Hub → `apps/control-plane/dist/`: Hub bundle, CLI, Worker bundle, and
  `public/` (the UI)
- Worker → `apps/node-agent/dist/`: Worker bundle and CLI
- UI → `apps/dashboard/dist/public/` (drafts excluded)
- `dist/cli-bundle/` for the standalone archives

`pnpm verify:packs` fails the pipeline if an npm tarball would miss its
bundles or UI, or include `src/`, `bin/`, TypeScript, tests, or draft UI files.
`pnpm package:standalone` builds this platform's two archives from
`dist/cli-bundle/` with a private Node runtime.

## Website and docs site

The site at https://hirenf14.github.io/cloudagentfleet/ is the landing page in
`site/` plus the docs pages rendered from `docs/*.md` (the list is in
`scripts/build-site.mjs`). Edit the markdown in `docs/`; the **Pages** workflow
rebuilds and deploys on every push to `master` that touches `site/` or
`docs/`. Preview locally:

```bash
pnpm site:build          # writes site-dist/
npx serve site-dist      # or any static server
```

## Branch and pull request workflow

1. Fork the repository (or branch, if you have write access) from `master`,
   for one focused change.
2. Keep commits small and describe why, not just what.
3. Run `pnpm typecheck` and `pnpm test`; run `pnpm build` and
   `pnpm verify:packs` if you touched packaging.
4. Add a changeset (`pnpm changeset`) when the change affects operators or
   package users.
5. Open a PR against `master`. The template asks for a summary, a test plan,
   and the docs you updated.
6. CI must pass. A maintainer reviews, may ask for changes, and merges.
7. Merging does not publish by itself: releases happen when the Version
   Packages PR is merged (see [Releases](#releases)).

Changes to behavior you can see (the dashboard, `init`, enrollment) should
include a screenshot or the output you saw.

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

## Reviews

- Prefer small, reviewable diffs.
- Match existing TypeScript / module style in the package you touch.
- Add or update tests with the change. Prefer tests that exercise real
  behavior (a real HTTP server, a real browser for the dashboard) over mocks.
- Call out threat-model impact for auth, proxy, or enrollment changes
  (see [`docs/THREAT-MODEL.md`](docs/THREAT-MODEL.md)).
- Reviewers: be specific, say what blocks the merge and what is a suggestion,
  and follow the [code of conduct](CODE_OF_CONDUCT.md).

Questions that do not fit an issue comment can go on the PR discussion thread.

## License

[MIT](LICENSE) © Cloud Agent Fleet contributors. The npm packages and release
archives include the license text.
