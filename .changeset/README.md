# Changesets

This repo uses [Changesets](https://github.com/changesets/changesets) to draft
version bumps and changelogs for the four public packages:

- `@cloudagentfleet/hub`
- `@cloudagentfleet/worker`
- `@cloudagentfleet/all-in-one`
- `@cloudagentfleet/ui`

They are **fixed**: every release bumps all four to the same version, because
the Hub, Worker, and all-in-one packages ship the same CLI.

## Add a changeset on your PR

```bash
pnpm changeset
```

Pick **patch**, **minor**, or **major** (on 0.x, minor marks a breaking
change), write a short summary aimed at operators, and commit the generated
file under `.changeset/`.

Private workspace packages (`cli`, `protocol`, `host-adapters`) are ignored.

## What happens on `master`

1. Merging PRs that include changeset files leaves those files on `master`.
2. The Release workflow opens (or updates) a **Version Packages** PR that bumps
   the versions, updates each `CHANGELOG.md`, and removes consumed changeset
   files.
3. Merging that PR publishes to npm (with provenance) and creates GitHub
   Releases; the Worker's is marked Latest and gets the standalone archives.

See [`CONTRIBUTING.md`](../CONTRIBUTING.md#releases) for secrets and commands.
