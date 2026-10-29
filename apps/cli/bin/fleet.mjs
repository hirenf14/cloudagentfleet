/**
 * Read-only Hub commands for the CLI: `workers`, `workers usage <id>`,
 * `instances` and `sessions`. They call the Hub's own API with the Worker
 * token (the Hub accepts it on every route), so they work from any machine
 * that can reach the Hub, and on the Hub machine with no setup at all.
 */

const REQUEST_TIMEOUT_MS = 10_000;
/** A Worker answers a usage request itself, which the Hub allows 45 seconds. */
const USAGE_TIMEOUT_MS = 50_000;

/** Options `--hub <url>`, `--token <secret>`, `--instance <id>` and the `--json` flag. */
export function parseFleetArgs(args) {
  const flags = { json: false };
  const positional = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--json") flags.json = true;
    else if (arg === "--hub" || arg === "--token" || arg === "--instance") {
      const value = args[index + 1];
      if (value === undefined || value.startsWith("--")) throw new Error(`${arg} needs a value`);
      flags[arg.slice(2)] = value;
      index += 1;
    } else if (arg.startsWith("--")) {
      throw new Error(`Unknown option: ${arg}`);
    } else {
      positional.push(arg);
    }
  }
  return { flags, positional };
}

/**
 * Where the Hub is and the token to use. An explicit `--hub` / `CLOUDAGENTFLEET_HUB_URL`
 * wins, then this machine's Worker settings, then a Hub running here.
 * Returns `url` undefined when there is nothing to go on.
 */
export function resolveHubTarget({ flags = {}, env = process.env, workerConfig, hubConfig, hubWorkerToken }) {
  const worker = workerConfig && typeof workerConfig === "object" ? workerConfig : undefined;
  const explicitUrl = flags.hub ?? env.CLOUDAGENTFLEET_HUB_URL;
  const explicitToken = flags.token ?? env.CLOUDAGENTFLEET_AUTH_TOKEN;
  let url;
  let own;
  if (explicitUrl) {
    url = explicitUrl;
  } else if (worker?.controllerUrl) {
    url = worker.controllerUrl;
    own = worker.authToken;
  } else if (hubConfig) {
    const host = !hubConfig.host || hubConfig.host === "0.0.0.0" || hubConfig.host === "::" ? "127.0.0.1" : hubConfig.host;
    url = `http://${host.includes(":") ? `[${host}]` : host}:${hubConfig.port}`;
    own = hubWorkerToken;
  }
  return {
    url: url ? String(url).replace(/\/+$/, "") : undefined,
    // A Hub named on the command line gets only a token named there too: this machine's own token belongs to
    // its own Hub and must not be sent to some other address.
    token: explicitUrl ? explicitToken : (explicitToken ?? own ?? worker?.authToken ?? hubWorkerToken),
  };
}

/** One GET or POST to the Hub, with errors that say what to do. */
export async function hubRequest(target, path, { method = "GET", fetchImpl = fetch, timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  if (!target.url) {
    throw new Error("No Hub to ask. Run this on the Hub machine or a Worker machine, or pass --hub <url> (and --token).");
  }
  let response;
  try {
    response = await fetchImpl(`${target.url}${path}`, {
      method,
      headers: { accept: "application/json", ...(target.token ? { authorization: `Bearer ${target.token}` } : {}) },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    // Node nests the reason: a refused connection is an AggregateError inside `cause`.
    const code = error?.cause?.code ?? error?.cause?.errors?.[0]?.code ?? error?.code ?? error?.name;
    throw new Error(`The Hub at ${target.url} is not reachable (${code ?? error}). Check it is running and, over Tailscale, that this machine is on the tailnet.`);
  }
  const body = await response.json().catch(() => undefined);
  if (response.status === 401 || response.status === 403) {
    throw new Error(`The Hub ${target.token ? "refused the token" : "needs a token and none was found"} (HTTP ${response.status}). Pass --token, set CLOUDAGENTFLEET_AUTH_TOKEN, or run \`cloudagentfleet hub token\` on the Hub machine.`);
  }
  if (!response.ok) {
    throw new Error(`The Hub answered HTTP ${response.status}${typeof body?.error === "string" ? `: ${body.error}` : ""}`);
  }
  return body ?? {};
}

/** "3m ago", "2h ago", "5d ago"; "never" when the Hub has not heard from it. */
export function ago(iso, now = Date.now()) {
  const time = iso ? Date.parse(iso) : Number.NaN;
  if (Number.isNaN(time)) return "never";
  const seconds = Math.max(0, Math.round((now - time) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

function table(headers, rows) {
  const all = [headers, ...rows];
  const widths = headers.map((_, column) => Math.max(...all.map((row) => String(row[column] ?? "").length)));
  return all
    .map((row) => row.map((cell, column) => String(cell ?? "").padEnd(widths[column])).join("  ").trimEnd())
    .join("\n");
}

export function formatWorkers(workers, now = Date.now()) {
  if (workers.length === 0) return "No Workers have enrolled yet. Run `cloudagentfleet init` on a machine to add one.";
  return table(
    ["ID", "NAME", "STATUS", "VERSION", "OS", "LAST SEEN"],
    workers.map((worker) => [worker.id, worker.name, worker.status, worker.version ?? "unknown", worker.platform, ago(worker.lastSeenAt, now)]),
  );
}

export function formatInstances(instances, now = Date.now()) {
  if (instances.length === 0) return "No host instances are registered.";
  return table(
    ["ID", "LABEL", "BACKEND", "STATUS", "WORKER", "AGENTS", "LAST SEEN"],
    instances.map((instance) => [
      instance.id,
      instance.label,
      instance.backend,
      instance.status,
      instance.nodeId ?? "-",
      (instance.agents ?? []).map((agent) => agent.name ?? agent.id).join(", ") || "-",
      ago(instance.lastSeenAt, now),
    ]),
  );
}

export function formatSessions(sessions, now = Date.now()) {
  if (sessions.length === 0) return "No sessions.";
  return table(
    ["ID", "INSTANCE", "AGENT", "STATUS", "TITLE", "LAST EVENT"],
    sessions.map((session) => [
      session.id,
      session.instanceId,
      session.agent?.name ?? session.agent?.id ?? "-",
      session.needsInput ? `${session.status} (needs input)` : session.status,
      session.title,
      ago(session.lastEventAt, now),
    ]),
  );
}

/** Usage keyed by agent: one block per agent, one line per limit window. */
export function formatUsage(usage) {
  const agents = Object.entries(usage ?? {});
  if (agents.length === 0) return "This Worker reported no agent usage (no Claude Code, Codex or Cursor found).";
  return agents
    .map(([key, agent]) => {
      const heading = `${agent.label ?? key}${agent.account ? ` (${agent.account})` : ""}`;
      const lines = (agent.windows ?? []).map((window) => {
        const resets = window.resetsAt ? `resets ${window.resetsAt}` : window.resetsText ? `resets ${window.resetsText}` : "";
        return `  ${window.label}: ${window.usedPercent}% used${resets ? `, ${resets}` : ""}`;
      });
      return [heading, ...(lines.length > 0 ? lines : ["  no limits reported"])].join("\n");
    })
    .join("\n");
}

/**
 * Runs one command and returns the text to print (or the JSON with `--json`).
 * `args` is what follows the command name, e.g. `["usage", "mac", "--json"]` for `workers`.
 */
export async function runFleetCommand(name, args, { target, fetchImpl = fetch, now = Date.now() }) {
  const { flags, positional } = parseFleetArgs(args);
  const ask = (path, options) => hubRequest(target, path, { fetchImpl, ...options });
  const output = (data, text) => (flags.json ? JSON.stringify(data, null, 2) : text);

  if (name === "workers") {
    if (positional[0] === "usage") {
      const id = positional[1];
      if (!id) throw new Error("Usage: cloudagentfleet workers usage <worker-id>");
      const result = await ask(`/api/workers/${encodeURIComponent(id)}/usage`, { method: "POST", timeoutMs: USAGE_TIMEOUT_MS });
      return output(result, formatUsage(result.usage));
    }
    if (positional.length > 0) throw new Error(`Unknown workers command: ${positional[0]}`);
    const { workers = [] } = await ask("/api/workers");
    return output(workers, formatWorkers(workers, now));
  }
  if (name === "instances") {
    const { instances = [] } = await ask("/api/instances");
    return output(instances, formatInstances(instances, now));
  }
  if (name === "sessions") {
    const query = flags.instance ? `?instanceId=${encodeURIComponent(flags.instance)}` : "";
    const { sessions = [] } = await ask(`/api/sessions${query}`);
    return output(sessions, formatSessions(sessions, now));
  }
  throw new Error(`Unknown command: ${name}`);
}

export function fleetHelp() {
  return [
    "Ask the Hub what is running (read-only):",
    "",
    "  cloudagentfleet workers                  Enrolled Workers: status, version, last seen",
    "  cloudagentfleet workers usage <id>       One Worker's agent limits (Claude Code, Codex, Cursor)",
    "  cloudagentfleet instances                Host instances (Codeman, Open WebUI Computer)",
    "  cloudagentfleet sessions [--instance <id>]",
    "",
    "Options: --json  --hub <url>  --token <secret>",
    "The Hub and token come from this machine's Worker or Hub settings; override with",
    "--hub / --token or CLOUDAGENTFLEET_HUB_URL / CLOUDAGENTFLEET_AUTH_TOKEN.",
  ].join("\n");
}
