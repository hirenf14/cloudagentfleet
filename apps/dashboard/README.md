# @cloudagentfleet/ui

Cloud Agent Fleet Hub UI assets (`dist/public/…`).

This package has **no CLI**. Install it next to `@cloudagentfleet/hub` so the Hub can resolve and serve the dashboard.

## Install

```bash
npm install @cloudagentfleet/hub @cloudagentfleet/ui
```

Hub resolves assets from this package automatically:

```bash
npx cloudagentfleet-hub
```

Then open `http://127.0.0.1:8787`.

## What is published

Only the production UI build under `dist/public/` (HTML, CSS, JS). Draft and source trees are not included.

## Related packages

- [`@cloudagentfleet/hub`](https://www.npmjs.com/package/@cloudagentfleet/hub)
- [`@cloudagentfleet/worker`](https://www.npmjs.com/package/@cloudagentfleet/worker)

Source and docs: [hirenf14/cloudagentfleet](https://github.com/hirenf14/cloudagentfleet)
