import { compareVersions } from "./update.mjs";

/** Log lines that point at a cause; shown from the tail of a service log. */
const LOG_PROBLEM = /\b(error|failed|unavailable|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|EADDRINUSE|unauthori[sz]ed|forbidden|exited with code)\b|HTTP (401|403|404|5\d\d)/i;

const ok = (title, detail) => ({ status: "ok", title, detail });
const warn = (title, detail, fix) => ({ status: "warn", title, detail, fix });
const fail = (title, detail, fix) => ({ status: "fail", title, detail, fix });

async function getJson(fetchImpl, url, token) {
  const response = await fetchImpl(url, {
    headers: { accept: "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    signal: AbortSignal.timeout(5_000),
  });
  return { status: response.status, body: await response.json().catch(() => undefined) };
}

function describeNetworkError(error) {
  const cause = error?.cause?.code ?? error?.code ?? error?.name;
  return cause ? `${cause}${error?.message ? `: ${error.message}` : ""}` : String(error);
}

/**
 * The last few lines of the current run of a service log that look like
 * problems. A run begins at a `--- <time> starting ... ---` marker, so errors
 * from before the last restart don't keep showing up.
 */
export function logProblems(logText, limit = 5) {
  const lines = (logText ?? "").split(/\r?\n/);
  const lastStart = lines.findLastIndex((line) => /^--- .* starting .* ---$/.test(line));
  return lines
    .slice(lastStart + 1)
    .filter((line) => line.trim() && LOG_PROBLEM.test(line))
    .slice(-limit);
}

/**
 * Looks for the usual reasons a fleet doesn't work: old Node, missing or
 * broken config, a Hub that can't be reached, a Worker that never enrolled or
 * went quiet, a stopped service, a backend that doesn't answer, and errors in
 * the service logs. Everything it needs comes in through `context`, so it
 * reads no files itself. Each result carries a plain `fix` where there is one.
 */
export async function diagnose(context) {
  const { fetchImpl = fetch, now = Date.now() } = context;
  const results = [];

  const [major = 0, minor = 0] = context.nodeVersion.split(".").map(Number);
  results.push(major > 22 || (major === 22 && minor >= 6)
    ? ok("Node.js", `v${context.nodeVersion}`)
    : fail("Node.js", `v${context.nodeVersion} is too old (22.6 or newer is required)`, "Install Node.js 22 LTS or newer."));

  if (context.cli.installed || context.cli.version !== "0.0.0-dev") {
    if (!context.latest) {
      results.push(ok(`Version ${context.cli.version}`, "could not reach npm to look for a newer release"));
    } else if (compareVersions(context.cli.version, context.latest) < 0) {
      results.push(warn(`Version ${context.cli.version}`, `${context.latest} is available`, "Run `cloudagentfleet update`."));
    } else {
      results.push(ok(`Version ${context.cli.version}`, "up to date"));
    }
  }

  const worker = context.workerConfig;
  if (worker === "invalid") {
    results.push(fail("Worker settings", `${context.workerConfigPath} is not valid JSON`, "Run `cloudagentfleet init` again to rewrite it."));
  } else if (worker) {
    results.push(await checkWorker(context, worker, fetchImpl, now));
  }

  const hub = context.hubConfig;
  if (hub) results.push(await checkHub(context, hub, fetchImpl));

  if (!worker && !hub) {
    results.push(warn("This machine", "no Worker or Hub is set up here", "Run `cloudagentfleet init`."));
  }

  for (const role of ["worker", "hub"]) {
    if (role === "worker" ? !worker || worker === "invalid" : !hub) continue;
    const state = context.services?.[role];
    if (state && !state.running) {
      results.push(warn(
        `${role === "worker" ? "Worker" : "Hub"} service`,
        "not running in the background",
        `Run \`cloudagentfleet ${role === "worker" ? "worker" : "hub service"} ${state.installed ? "start" : "install"}\`.`,
      ));
    }
    const problems = logProblems(context.logs?.[role]);
    if (problems.length > 0) {
      results.push(warn(`${role === "worker" ? "Worker" : "Hub"} log`, `recent problems:\n    ${problems.join("\n    ")}`, `Full log: ${context.logPaths?.[role] ?? ""}`));
    }
  }
  return results.flat();
}

async function checkWorker(context, worker, fetchImpl, now) {
  const controllerUrl = String(worker.controllerUrl ?? "").replace(/\/+$/, "");
  if (!controllerUrl || !worker.nodeId) {
    return fail("Worker settings", "controllerUrl or nodeId is missing", "Run `cloudagentfleet init` again.");
  }
  const findings = [];
  const token = worker.authToken || process.env.CLOUDAGENTFLEET_AUTH_TOKEN;
  let health;
  try {
    health = await getJson(fetchImpl, `${controllerUrl}/healthz`);
  } catch (error) {
    return fail(
      "Hub connection",
      `${controllerUrl} is not reachable (${describeNetworkError(error)})`,
      "Check the Hub is running, the URL is right, and (over Tailscale) both machines are on the tailnet.",
    );
  }
  if (health.status !== 200) {
    return fail("Hub connection", `${controllerUrl}/healthz answered HTTP ${health.status}`, "Check the Hub's address and that it is the Cloud Agent Fleet Hub.");
  }
  const hubVersion = health.body?.version;
  findings.push(ok("Hub connection", `${controllerUrl}${hubVersion ? ` (Hub ${hubVersion})` : ""}`));
  if (hubVersion && compareVersions(context.cli.version, hubVersion) < 0) {
    findings.push(warn("Version mismatch", `this machine runs ${context.cli.version}, the Hub runs ${hubVersion}`, "Run `cloudagentfleet update`."));
  }

  let workers;
  try {
    const listed = await getJson(fetchImpl, `${controllerUrl}/api/workers`, token);
    if (listed.status === 401 || listed.status === 403) {
      findings.push(fail("Worker token", `the Hub refused it (HTTP ${listed.status})`, "Run `cloudagentfleet hub token` on the Hub machine and rerun `cloudagentfleet init` here with it."));
      return findings;
    }
    workers = listed.body?.workers ?? [];
  } catch (error) {
    findings.push(fail("Worker list", describeNetworkError(error)));
    return findings;
  }
  for (const nodeId of context.workerNodeIds ?? [worker.nodeId]) {
    const node = workers.find((candidate) => candidate.id === nodeId);
    if (!node) {
      findings.push(fail(`Worker ${nodeId}`, "the Hub has never seen it", "Start it with `cloudagentfleet worker start` (or `cloudagentfleet run`) and read its log."));
    } else if (node.status !== "online") {
      const seen = node.lastSeenAt ? `${Math.round((now - Date.parse(node.lastSeenAt)) / 1000)}s ago` : "never";
      findings.push(fail(`Worker ${nodeId}`, `${node.status}, last heard ${seen}`, "Check the Worker is running and can reach the Hub; its log usually says why."));
    } else {
      findings.push(ok(`Worker ${nodeId}`, `online${node.version ? `, version ${node.version}` : ""}`));
    }
  }
  const backendUrls = [
    ["codeman", process.env.CLOUDAGENTFLEET_CODEMAN_URL ?? "http://127.0.0.1:3000", "/api/status"],
    ["cptr", worker.cptrUrl ?? process.env.CLOUDAGENTFLEET_CPTR_URL ?? "http://127.0.0.1:8000", "/api/health"],
  ];
  for (const [backend, base, path] of backendUrls) {
    const enabled = Array.isArray(worker.backends) ? worker.backends.includes(backend) : backend === "codeman";
    if (!enabled) continue;
    try {
      const probe = await getJson(fetchImpl, `${base.replace(/\/+$/, "")}${path}`);
      findings.push(probe.status < 500 ? ok(backend === "cptr" ? "Open WebUI Computer" : "Codeman", `${base} answers`) : warn(backend, `${base} answered HTTP ${probe.status}`));
    } catch (error) {
      findings.push(warn(
        backend === "cptr" ? "Open WebUI Computer" : "Codeman",
        `${base} is not answering (${describeNetworkError(error)})`,
        backend === "cptr"
          ? "Start it with `cptr run`, or let the Worker start it. On Windows check whether it runs natively or in WSL."
          : "Codeman needs WSL and tmux on Windows; start it, or let the Worker start it.",
      ));
    }
  }
  return findings;
}

async function checkHub(context, hub, fetchImpl) {
  const base = `http://${hub.host === "0.0.0.0" ? "127.0.0.1" : hub.host}:${hub.port}`;
  try {
    const health = await getJson(fetchImpl, `${base}/healthz`);
    if (health.status !== 200) return fail("Hub", `${base}/healthz answered HTTP ${health.status}`, "Another program may be using the port; change it in hub-config.json.");
    const findings = [ok("Hub", `${base}${health.body?.version ? ` (version ${health.body.version})` : ""}`)];
    if (!context.hubWorkerToken) findings.push(warn("Hub worker token", "not found yet", "Start the Hub once, or set CLOUDAGENTFLEET_AUTH_TOKEN."));
    return findings;
  } catch (error) {
    return fail("Hub", `not answering on ${base} (${describeNetworkError(error)})`, "Run `cloudagentfleet hub service start`, or `cloudagentfleet hub run` to see why it stops.");
  }
}

const MARK = { ok: "[ok]  ", warn: "[warn]", fail: "[FAIL]" };

export function formatResults(results) {
  const lines = [];
  for (const result of results) {
    lines.push(`${MARK[result.status]} ${result.title}${result.detail ? ` - ${result.detail}` : ""}`);
    if (result.fix) lines.push(`       -> ${result.fix}`);
  }
  return lines.join("\n");
}
