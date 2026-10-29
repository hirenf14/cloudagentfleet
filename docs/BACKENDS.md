# Codeman and Open WebUI Computer

Each machine in your fleet can offer **Codeman**, **Open WebUI Computer**, or
both. They do different jobs, and each shows up in the dashboard as its own
entry, so you can pick per machine. `cloudagentfleet init` asks which you want
and installs them.

## At a glance

| | Codeman | Open WebUI Computer |
| --- | --- | --- |
| What it is | Agent sessions in terminals | A full workspace in the browser |
| You can | Start a session, watch its output live, type into it | Browse files, edit code, use a terminal, preview running apps, chat with coding agents |
| Where you use it | In the dashboard's session view | Inside the dashboard, signed in for you |
| Folder limits | The Hub only starts sessions in the folders you approved | None: anyone who can open it has the machine's full access |
| On Windows | Runs in WSL | Runs natively, so it sees your Windows folders |
| Made by | [Ark0N and contributors](https://github.com/Ark0N/Codeman), MIT | [Open WebUI, Inc.](https://openwebui.com/computer), its own license |

## Which should I pick?

- **Mostly run agents and check on them?** Codeman. It is light, and the
  dashboard keeps all your sessions in one list.
- **Want to read and change the code, preview what an agent built, or talk to an
  agent in a chat?** Open WebUI Computer.
- **Both?** Pick both. The machine then has two entries in the sidebar, and
  you use whichever fits the moment.

## Codeman

Codeman keeps coding agents running in persistent terminal sessions. In the
dashboard you:

1. Pick the machine and choose **Start a session**.
2. Choose a workspace (one of the approved folders), an agent (Claude Code,
   Cursor, or a plain shell), and optionally a name.
3. Watch the terminal live and type into it. Sessions keep running if you close
   the page, and are listed under the machine and in **Recent**.

The Hub only starts sessions inside the folders you approved when you set the
machine up, so a stray path cannot be opened by mistake.

If you enrolled a Codeman directly over your tailnet (instead of through the
Worker), **Open Codeman UI** shows Codeman's own interface in the dashboard. A
Codeman reached through the Worker does not have its own page; use the
dashboard's session view.

## Open WebUI Computer

Open WebUI Computer (often shortened to cptr) is a workspace you use in the
browser: a file browser and editor, terminals, a **Browser** tab for previewing
apps running on the machine, and a chat where Claude Code, Codex, Cursor, and
other agents work on your files.

In the dashboard, choose the machine and **Open Open WebUI Computer UI**. It
opens inside the dashboard, and you are already signed in: the Worker created
an account for the Hub when cptr first started and keeps its password on that
machine; the Hub only passes along a session. If you set up cptr yourself, put
its account in `~/.cloudagentfleet/cptr-credentials.json` on that machine, as
`{"username": "...", "password": "..."}`.

Good to know:

- **It is not limited to your approved folders.** The Hub does not control what
  you do inside it, and a signed-in user has full shell access on that
  machine. The machine's page says so.
- **Agent chat needs the agent installed on that machine** and signed in there
  (`claude`, `agent login`). `init` can install them; the logins stay yours.
- **Claude models are kept current by the Worker.** It has an older built-in
  list, so each time the Worker starts (or finds it running) it adds the
  current Claude Code models and sets a default. Models and a default you chose
  are kept. To offer a different set, put `{"models": [...], "default": "..."}`
  in `~/.cloudagentfleet/cptr-models.json` on that machine; set
  `CLOUDAGENTFLEET_CPTR_SYNC_MODELS=false` to leave its list alone.
- **On Windows**, its automatic list of running ports does not work (it needs a
  tool newer Windows 11 builds no longer include). Open a running app in its
  **Browser** tab at `http://localhost:<port>` instead.
- **Its interface is shown unmodified.** Its license does not allow changing or
  covering its branding, and company use falls under
  [Open WebUI's terms](https://openwebui.com/terms).

## How the Hub reaches them

| | Through the Worker (default) | Over your tailnet |
| --- | --- | --- |
| How | The Worker connects out to the Hub and carries the traffic | The Hub connects to a URL you publish with Tailscale Serve |
| Open ports on the machine | None | One, on your tailnet only |
| Set up by | `cloudagentfleet init` | `cloudagentfleet enroll tailscale-url …` ([CLI and enrollment](CLI-ENROLLMENT.md)) |
| Open WebUI Computer sign-in | Automatic | You sign in to it |

Most setups use the Worker. Use the tailnet option when a machine already
publishes its own Codeman or Open WebUI Computer, or you do not want to run a
Worker there.

## Coding agents

Claude Code CLI and Cursor Agent CLI are optional. Both backends launch them,
so install them on each machine that should use them (`init` offers to) and
sign in on that machine. Cloud Agent Fleet never sees your provider
credentials.

## More

- [Getting started](GETTING-STARTED.md)
- [Security](THREAT-MODEL.md): what each backend can reach and how the Hub keeps
  them isolated
- [Credits](ACKNOWLEDGEMENTS.md): licenses and who makes what
- For people building a new backend:
  [the design notes](https://github.com/techoblix/cloudagentfleet/blob/master/docs/BACKEND-ABSTRACTION.md)
