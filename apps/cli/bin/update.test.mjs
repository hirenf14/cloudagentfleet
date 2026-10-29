import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { autoUpdateEnabled, cachedLatest, compareVersions, refreshLatest, watchForUpdates } from "./update.mjs";

// The watcher's timer is unref'd (a service has child processes to keep it alive); a test needs its own.
function keepAlive(promise) {
  const timer = setInterval(() => undefined, 20);
  return promise.finally(() => clearInterval(timer));
}

const installed = { name: "@cloudagentfleet/worker", version: "0.3.4", installed: true };

test("auto-update defaults on for a Worker and off for a Hub, and settings and env override", () => {
  assert.equal(autoUpdateEnabled("worker", {}, installed, {}), true);
  assert.equal(autoUpdateEnabled("hub", {}, installed, {}), false);
  assert.equal(autoUpdateEnabled("worker", { autoUpdate: false }, installed, {}), false);
  assert.equal(autoUpdateEnabled("hub", { autoUpdate: true }, installed, {}), true);
  assert.equal(autoUpdateEnabled("hub", {}, installed, { CLOUDAGENTFLEET_AUTO_UPDATE: "1" }), true);
  assert.equal(autoUpdateEnabled("worker", {}, installed, { CLOUDAGENTFLEET_AUTO_UPDATE: "0" }), false);
  assert.equal(autoUpdateEnabled("worker", {}, installed, { CLOUDAGENTFLEET_UPDATE_CHECK: "0" }), false);
  assert.equal(autoUpdateEnabled("worker", {}, { ...installed, installed: false }, {}), false);
});

test("the version cache remembers the newest release and goes stale", async () => {
  const dir = mkdtempSync(join(tmpdir(), "caf-update-"));
  const cachePath = join(dir, "update-check.json");
  try {
    assert.equal(cachedLatest(cachePath, installed.name).latest, undefined);
    const now = Date.parse("2026-01-01T00:00:00Z");
    const latest = await refreshLatest(cachePath, installed.name, { fetchImpl: async () => Response.json({ version: "0.4.0" }), now });
    assert.equal(latest, "0.4.0");
    assert.deepEqual(cachedLatest(cachePath, installed.name, now + 60_000), { latest: "0.4.0", stale: false });
    assert.equal(cachedLatest(cachePath, installed.name, now + 7 * 3_600_000).stale, true);
    // An unreachable registry keeps the cached answer.
    assert.equal(await refreshLatest(cachePath, installed.name, { fetchImpl: async () => { throw new Error("offline"); }, now }), "0.4.0");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a service installs a newer release once, then asks to restart", async () => {
  const dir = mkdtempSync(join(tmpdir(), "caf-update-"));
  const logs = [];
  const installs = [];
  try {
    await keepAlive(new Promise((resolve) => {
      watchForUpdates({
        pkg: installed,
        cachePath: join(dir, "update-check.json"),
        apply: true,
        firstMs: 1,
        log: (line) => logs.push(line),
        fetchImpl: async () => Response.json({ version: "0.4.0" }),
        install: (name) => {
          installs.push(name);
          return undefined;
        },
        onUpdated: (version) => {
          logs.push(`restart ${version}`);
          resolve();
        },
      });
    }));
    assert.deepEqual(installs, ["@cloudagentfleet/worker"]);
    assert.ok(logs.includes("restart 0.4.0"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a failed install keeps the service running and says why", async () => {
  const dir = mkdtempSync(join(tmpdir(), "caf-update-"));
  const logs = [];
  try {
    let stop;
    await keepAlive(new Promise((resolve) => {
      stop = watchForUpdates({
        pkg: installed,
        cachePath: join(dir, "update-check.json"),
        apply: true,
        firstMs: 1,
        intervalMs: 3_600_000,
        log: (line) => {
          logs.push(line);
          if (line.startsWith("Update failed")) resolve();
        },
        fetchImpl: async () => Response.json({ version: "0.4.0" }),
        install: () => "EACCES: permission denied",
        onUpdated: () => assert.fail("must not restart after a failed install"),
      });
    }));
    stop();
    assert.match(logs.join("\n"), /Update failed, staying on 0\.3\.4: EACCES/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("without apply, a newer release is only announced", async () => {
  const dir = mkdtempSync(join(tmpdir(), "caf-update-"));
  try {
    let stop;
    const line = await keepAlive(new Promise((resolve) => {
      stop = watchForUpdates({
        pkg: installed,
        cachePath: join(dir, "update-check.json"),
        apply: false,
        firstMs: 1,
        intervalMs: 3_600_000,
        log: resolve,
        fetchImpl: async () => Response.json({ version: "0.3.5" }),
        install: () => assert.fail("must not install"),
        onUpdated: () => assert.fail("must not restart"),
      });
    }));
    stop();
    assert.match(line, /Update available: 0\.3\.4 -> 0\.3\.5/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  assert.ok(compareVersions("0.3.4", "0.3.5") < 0);
});
