# Credits and third-party software

Cloud Agent Fleet coordinates other people's excellent work. It does not
bundle, copy, or modify any of the projects below: `cloudagentfleet init`
installs them with their own official installers, only after you confirm, and
each stays under its own license and terms.

Cloud Agent Fleet is an independent project. It is not affiliated with,
endorsed by, or sponsored by the authors of these projects; their names are
used only to say what Cloud Agent Fleet works with.

## Codeman

[Codeman](https://github.com/Ark0N/Codeman) by Ark0N and the Codeman
contributors is the terminal-session backend: it runs coding agents in
persistent tmux sessions with a web UI. Cloud Agent Fleet talks to Codeman's
HTTP API to start, list, stream, and stop sessions, and shows Codeman's own UI
through the Hub with a small fleet switcher added.

- License: MIT, © 2024–2026 Codeman Contributors
- Installed by: `curl -fsSL https://getcodeman.com/install | bash` (its official
  installer), when you pick Codeman in `init`
- Source: https://github.com/Ark0N/Codeman

## Open WebUI Computer

[Open WebUI Computer](https://openwebui.com/computer) (`cptr`) by Open WebUI,
Inc. is the workspace backend: files, editor, terminal, previews, and agent
chat in the browser. Cloud Agent Fleet shows cptr's own, unmodified UI through
the Hub and signs you in with a session cptr itself issues.

- License: the [Open Use License](https://github.com/open-webui/computer/blob/main/LICENSE),
  which is the Elastic License 2.0 plus attribution preservation: its name,
  logos, and about and version screens may not be removed, obscured, replaced,
  or supplemented. Cloud Agent Fleet never alters cptr's UI or branding.
- **Commercial, organizational, or production use** of Open WebUI Computer is
  subject to Open WebUI's commercial terms: https://openwebui.com/terms. Check
  them before using cptr in a company.
- Installed by: `uv tool install cptr` (or pipx or pip), when you pick Open WebUI
  Computer in `init`; `init` shows the license link first.
- Source: https://github.com/open-webui/computer

## Coding agents

- **Claude Code** by Anthropic, installed with its official installer
  (`https://claude.ai/install.sh` or `install.ps1`) when you pick it. Use is
  under Anthropic's terms.
- **Cursor Agent CLI** by Anysphere (Cursor), installed with its official
  installer (`https://cursor.com/install`) when you pick it. Use is under
  Cursor's terms.

You sign in to each agent yourself; Cloud Agent Fleet never handles provider
credentials.

## Tools it relies on

- [Tailscale](https://tailscale.com) publishes the Hub privately with
  Tailscale Serve. Install it yourself; it is not bundled.
- [uv](https://github.com/astral-sh/uv) by Astral (MIT or Apache-2.0) is
  installed by `init` only when Open WebUI Computer needs a Python tool and
  none is present.
- [Node.js](https://nodejs.org) (MIT) is included in the release archives as
  their runtime, with its license file.
- In the dashboard: [React](https://react.dev) (MIT) and
  [xterm.js](https://xtermjs.org) (MIT), loaded from unpkg.

## Reporting a credit problem

If something here misstates your project or its terms, please
[open an issue](https://github.com/hirenf14/cloudagentfleet/issues); we will fix
it promptly.
