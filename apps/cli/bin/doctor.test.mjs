import assert from "node:assert/strict";
import test from "node:test";
import { diagnose, formatResults, logProblems } from "./doctor.mjs";

const base = {
  cli: { name: "@cloudagentfleet/worker", version: "0.3.4", installed: true },
  latest: "0.3.4",
  nodeVersion: "22.10.0",
  workerConfigPath: "worker.json",
  workerConfig: { controllerUrl: "https://hub.example", nodeId: "box", backends: ["codeman"] },
  workerNodeIds: ["box"],
  now: Date.parse("2026-01-01T00:01:00Z"),
};

const hubAnswering = (workers, extra = {}) => async (url) => {
  const target = String(url);
  if (target.endsWith("/healthz")) return Response.json({ ok: true, version: "0.3.4" });
  if (target.endsWith("/api/workers")) return Response.json({ workers });
  if (target.includes("127.0.0.1:3000")) return Response.json({});
  if (extra.unreachable) throw new Error("unreachable");
  return Response.json({});
};

const statuses = (results) => Object.fromEntries(results.map((result) => [result.title, result.status]));

test("a healthy Worker has nothing to report", async () => {
  const results = await diagnose({
    ...base,
    fetchImpl: hubAnswering([{ id: "box", status: "online", version: "0.3.4" }]),
  });
  assert.ok(results.every((result) => result.status === "ok"), formatResults(results));
});

test("a Worker the Hub has never seen is a failure with a fix", async () => {
  const results = await diagnose({ ...base, fetchImpl: hubAnswering([]) });
  const missing = results.find((result) => result.title === "Worker box");
  assert.equal(missing.status, "fail");
  assert.match(missing.fix, /worker start/);
});

test("an offline Worker says how long ago the Hub last heard from it", async () => {
  const results = await diagnose({
    ...base,
    fetchImpl: hubAnswering([{ id: "box", status: "offline", lastSeenAt: "2026-01-01T00:00:00Z" }]),
  });
  assert.match(results.find((result) => result.title === "Worker box").detail, /offline, last heard 60s ago/);
});

test("an unreachable Hub and a refused token are told apart", async () => {
  const down = await diagnose({ ...base, fetchImpl: async () => { throw new Error("connect ECONNREFUSED"); } });
  assert.equal(statuses(down)["Hub connection"], "fail");
  const refused = await diagnose({
    ...base,
    fetchImpl: async (url) => String(url).endsWith("/healthz")
      ? Response.json({ ok: true })
      : new Response("{}", { status: 401 }),
  });
  assert.equal(statuses(refused)["Worker token"], "fail");
});

test("old Node, an old CLI and a version gap are flagged", async () => {
  const results = await diagnose({
    ...base,
    nodeVersion: "20.1.0",
    latest: "0.4.0",
    fetchImpl: async (url) => String(url).endsWith("/healthz")
      ? Response.json({ ok: true, version: "0.5.0" })
      : Response.json({ workers: [{ id: "box", status: "online" }] }),
  });
  const found = statuses(results);
  assert.equal(found["Node.js"], "fail");
  assert.equal(found["Version 0.3.4"], "warn");
  assert.equal(found["Version mismatch"], "warn");
});

test("a stopped service and recent log errors are reported", async () => {
  const results = await diagnose({
    ...base,
    fetchImpl: hubAnswering([{ id: "box", status: "online" }]),
    services: { worker: { running: false, installed: true } },
    logs: { worker: "--- t starting Worker ---\nfetch failed\nall good\n" },
    logPaths: { worker: "worker.log" },
  });
  const found = statuses(results);
  assert.equal(found["Worker service"], "warn");
  assert.equal(found["Worker log"], "warn");
});

test("only the current run of a log counts", () => {
  const log = "boom error\n--- 2026 starting Worker ---\nconnected\n";
  assert.deepEqual(logProblems(log), []);
  assert.deepEqual(logProblems("--- x starting Worker ---\nHTTP 401 from hub\n"), ["HTTP 401 from hub"]);
});

test("a machine with nothing set up is pointed at init", async () => {
  const results = await diagnose({ ...base, workerConfig: undefined, hubConfig: undefined, fetchImpl: fetch });
  assert.match(results.find((result) => result.title === "This machine").fix, /init/);
});
