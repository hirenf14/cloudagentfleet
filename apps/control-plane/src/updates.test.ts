import assert from "node:assert/strict";
import test from "node:test";
import type { HostedNode } from "../../../packages/protocol/src/index.ts";
import { UpdateMonitor } from "./updates.ts";

const node = (id: string, version: string | undefined, status: HostedNode["status"] = "online"): HostedNode => ({
  id,
  name: id,
  platform: "linux",
  status,
  capabilities: ["codeman"],
  labels: {},
  workspacePolicy: { mode: "folders", roots: [] },
  workspaces: [],
  ...(version ? { version } : {}),
  lastSeenAt: null,
});

const registry = (versions: Record<string, string>) => async (url: string | URL | Request) => {
  const name = decodeURIComponent(String(url)).replace("https://registry.npmjs.org/", "").replace("/latest", "");
  const version = versions[name];
  return version ? Response.json({ version }) : new Response("missing", { status: 404 });
};

test("the monitor reports a newer Hub and the Workers that are behind", async () => {
  const monitor = new UpdateMonitor({
    current: "0.3.4",
    fetchImpl: registry({ "@cloudagentfleet/hub": "0.4.0", "@cloudagentfleet/worker": "0.4.0" }) as typeof fetch,
  });
  await monitor.check();
  const report = monitor.report([node("old", "0.3.4"), node("new", "0.4.0"), node("unknown", undefined), node("gone", "0.1.0", "revoked")]);
  assert.equal(report.hub.updateAvailable, true);
  assert.equal(report.hub.latest, "0.4.0");
  assert.deepEqual(report.outdatedWorkers.map((worker) => worker.id), ["old"]);
  assert.ok(report.checkedAt);
});

test("an unreachable registry reports nothing and keeps the last answer", async () => {
  let online = true;
  const monitor = new UpdateMonitor({
    current: "0.3.4",
    fetchImpl: (async (url: string | URL | Request) => {
      if (!online) throw new Error("offline");
      return registry({ "@cloudagentfleet/hub": "0.3.4", "@cloudagentfleet/worker": "0.3.4" })(url);
    }) as typeof fetch,
  });
  assert.equal(monitor.report([]).hub.updateAvailable, false);
  assert.equal(monitor.report([]).checkedAt, null);
  await monitor.check();
  online = false;
  await monitor.check();
  assert.equal(monitor.report([]).hub.latest, "0.3.4");
});

test("a disabled monitor never starts a lookup", () => {
  let fetched = false;
  const monitor = new UpdateMonitor({
    current: "0.3.4",
    enabled: false,
    fetchImpl: (async () => {
      fetched = true;
      return new Response("{}");
    }) as typeof fetch,
  });
  monitor.start();
  monitor.stop();
  assert.equal(fetched, false);
  assert.equal(monitor.report([]).enabled, false);
});
