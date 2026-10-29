import assert from "node:assert/strict";
import test from "node:test";
import { ago, formatUsage, formatWorkers, parseFleetArgs, resolveHubTarget, runFleetCommand } from "./fleet.mjs";

const NOW = Date.parse("2026-10-29T12:00:00Z");
const worker = (extra = {}) => ({ id: "mac", name: "Hiren's Mac", platform: "macos", status: "online", version: "0.4.2", lastSeenAt: "2026-10-29T11:58:00Z", ...extra });

/** A Hub that answers by path and records each request. */
function fakeHub(routes) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const { pathname, search } = new URL(url);
    calls.push({ method: init.method ?? "GET", path: pathname + search, authorization: init.headers?.authorization });
    const handler = routes[`${init.method ?? "GET"} ${pathname}`];
    if (!handler) return new Response("{}", { status: 404 });
    const { status = 200, body = {} } = handler();
    return new Response(JSON.stringify(body), { status });
  };
  return { fetchImpl, calls };
}
const target = { url: "http://hub:8787", token: "secret" };

test("args: flags with values, --json, and a bad option", () => {
  assert.deepEqual(parseFleetArgs(["usage", "mac", "--json"]), { flags: { json: true }, positional: ["usage", "mac"] });
  assert.deepEqual(parseFleetArgs(["--hub", "http://h", "--token", "t", "--instance", "i"]).flags, { json: false, hub: "http://h", token: "t", instance: "i" });
  assert.throws(() => parseFleetArgs(["--hub"]), /needs a value/);
  assert.throws(() => parseFleetArgs(["--bogus"]), /Unknown option/);
});

test("target: a Worker machine uses its own Hub and token, a Hub machine its own port and token file", () => {
  const worker = { controllerUrl: "https://hub.tailnet.ts.net/", authToken: "worker-token" };
  assert.deepEqual(resolveHubTarget({ workerConfig: worker, env: {} }), { url: "https://hub.tailnet.ts.net", token: "worker-token" });
  assert.deepEqual(
    resolveHubTarget({ hubConfig: { host: "0.0.0.0", port: 8787 }, hubWorkerToken: "file-token", env: {} }),
    { url: "http://127.0.0.1:8787", token: "file-token" },
  );
  assert.equal(resolveHubTarget({ env: {} }).url, undefined);
});

test("target: --hub never gets this machine's own token, only one named on the command line or in the environment", () => {
  const worker = { controllerUrl: "https://mine", authToken: "my-token" };
  assert.deepEqual(resolveHubTarget({ flags: { hub: "http://other/" }, workerConfig: worker, hubWorkerToken: "file-token", env: {} }), { url: "http://other", token: undefined });
  assert.deepEqual(resolveHubTarget({ flags: { hub: "http://other", token: "theirs" }, workerConfig: worker, env: {} }), { url: "http://other", token: "theirs" });
  assert.deepEqual(resolveHubTarget({ workerConfig: worker, env: { CLOUDAGENTFLEET_HUB_URL: "http://env", CLOUDAGENTFLEET_AUTH_TOKEN: "env-token" } }), { url: "http://env", token: "env-token" });
});

test("ago: seconds to days, and never", () => {
  assert.equal(ago("2026-10-29T11:59:30Z", NOW), "30s ago");
  assert.equal(ago("2026-10-29T11:58:00Z", NOW), "2m ago");
  assert.equal(ago("2026-10-29T09:00:00Z", NOW), "3h ago");
  assert.equal(ago("2026-10-24T12:00:00Z", NOW), "5d ago");
  assert.equal(ago(null, NOW), "never");
});

test("workers: a table with status, version and last seen, or a hint when there are none", async () => {
  const hub = fakeHub({ "GET /api/workers": () => ({ body: { workers: [worker(), worker({ id: "thefire007", name: "TheFire007", platform: "linux", status: "offline", version: undefined, lastSeenAt: null })] } }) });
  const text = await runFleetCommand("workers", [], { target, fetchImpl: hub.fetchImpl, now: NOW });
  const [header, mac, fire] = text.split("\n");
  assert.match(header, /^ID\s+NAME\s+STATUS\s+VERSION\s+OS\s+LAST SEEN$/);
  assert.match(mac, /^mac\s+Hiren's Mac\s+online\s+0\.4\.2\s+macos\s+2m ago$/);
  assert.match(fire, /^thefire007\s+TheFire007\s+offline\s+unknown\s+linux\s+never$/);
  assert.equal(hub.calls[0].authorization, "Bearer secret");
  assert.match(formatWorkers([], NOW), /No Workers have enrolled yet/);
});

test("--json prints the Hub's data untouched", async () => {
  const workers = [worker()];
  const hub = fakeHub({ "GET /api/workers": () => ({ body: { workers } }) });
  assert.deepEqual(JSON.parse(await runFleetCommand("workers", ["--json"], { target, fetchImpl: hub.fetchImpl, now: NOW })), workers);
});

test("workers usage: asks that Worker, and prints each agent's limits", async () => {
  const usage = {
    claude: { label: "Claude Code", account: "me@x.com", asOf: "x", windows: [{ label: "session", usedPercent: 12, resetsText: "3pm" }, { label: "week", usedPercent: 40, resetsAt: "2026-11-01T00:00:00Z" }] },
    cursor: { label: "Cursor", asOf: "x" },
  };
  const hub = fakeHub({ "POST /api/workers/mac/usage": () => ({ body: { nodeId: "mac", usage } }) });
  const text = await runFleetCommand("workers", ["usage", "mac"], { target, fetchImpl: hub.fetchImpl, now: NOW });
  assert.equal(text, [
    "Claude Code (me@x.com)",
    "  session: 12% used, resets 3pm",
    "  week: 40% used, resets 2026-11-01T00:00:00Z",
    "Cursor",
    "  no limits reported",
  ].join("\n"));
  assert.match(formatUsage({}), /no agent usage/);
  await assert.rejects(runFleetCommand("workers", ["usage"], { target, fetchImpl: hub.fetchImpl }), /Usage: cloudagentfleet workers usage/);
});

test("a Worker that cannot report usage says so (the Hub's 409)", async () => {
  const hub = fakeHub({ "POST /api/workers/old/usage": () => ({ status: 409, body: { error: "This Worker needs the updated Fleet worker to report usage" } }) });
  await assert.rejects(runFleetCommand("workers", ["usage", "old"], { target, fetchImpl: hub.fetchImpl }), /HTTP 409: This Worker needs the updated Fleet worker/);
});

test("instances and sessions list what the Hub holds; sessions can be limited to one instance", async () => {
  const hub = fakeHub({
    "GET /api/instances": () => ({ body: { instances: [{ id: "codeman-mac", label: "Mac Codeman", backend: "codeman", status: "online", nodeId: "mac", agents: [{ id: "claude", name: "Claude" }], lastSeenAt: "2026-10-29T11:59:00Z" }] } }),
    "GET /api/sessions": () => ({ body: { sessions: [{ id: "s1", instanceId: "codeman-mac", agent: { id: "claude", name: "Claude" }, status: "running", needsInput: true, title: "Fix tests", lastEventAt: "2026-10-29T11:55:00Z" }] } }),
  });
  const instances = await runFleetCommand("instances", [], { target, fetchImpl: hub.fetchImpl, now: NOW });
  assert.match(instances.split("\n")[1], /^codeman-mac\s+Mac Codeman\s+codeman\s+online\s+mac\s+Claude\s+1m ago$/);
  const sessions = await runFleetCommand("sessions", ["--instance", "codeman-mac"], { target, fetchImpl: hub.fetchImpl, now: NOW });
  assert.match(sessions.split("\n")[1], /^s1\s+codeman-mac\s+Claude\s+running \(needs input\)\s+Fix tests\s+5m ago$/);
  assert.equal(hub.calls.at(-1).path, "/api/sessions?instanceId=codeman-mac");
});

test("errors say what to do: no Hub, unreachable Hub, refused token", async () => {
  await assert.rejects(runFleetCommand("workers", [], { target: {} }), /No Hub to ask/);
  const down = async () => { throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } }); };
  await assert.rejects(runFleetCommand("workers", [], { target, fetchImpl: down }), /not reachable \(ECONNREFUSED\)/);
  const refused = fakeHub({ "GET /api/workers": () => ({ status: 401 }) });
  await assert.rejects(runFleetCommand("workers", [], { target, fetchImpl: refused.fetchImpl }), /refused the token.*hub token/);
});
