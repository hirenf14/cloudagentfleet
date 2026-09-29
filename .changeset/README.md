# Changesets

This repo uses [Changesets](https://github.com/changesets/changesets) to draft
version bumps and changelogs for the three public packages:

- `@cloudagentfleet/hub`
- `@cloudagentfleet/ui`
- `@cloudagentfleet/worker`

Those packages are **linked**: one changeset bumps them together so Hub, UI, and
Worker stay on the same version line.

## Add a changeset on your PR

```bash
pnpm changeset
```

Pick **patch**, **minor**, or **major**, write a short summary aimed at
operators, and commit the generated file under `.changeset/`.

Private workspace packages (`cli`, `protocol`, `codeman-bridge`) are ignored.

## What happens on `master`

1. Merging PRs that include changeset files leaves those files on `master`.
2. The Release workflow opens (or updates) a **Version Packages** PR that bumps
   the three package versions, updates each `CHANGELOG.md`, and removes consumed
   changeset files.
3. Merging that Version Packages PR publishes to npm and creates GitHub Releases.
   Standalone platform archives are built afterward.

See [`CONTRIBUTING.md`](../CONTRIBUTING.md#releases) for secrets and commands.
