import assert from "node:assert/strict";
import test from "node:test";
import { NodeRegistry } from "./lifecycle.ts";
import { compareVersions, fetchLatestVersion, sanitizeVersion } from "./version.ts";

test("compareVersions orders releases and puts a prerelease before its release", () => {
  assert.ok(compareVersions("0.3.4", "0.3.10") < 0);
  assert.ok(compareVersions("1.0.0", "0.9.9") > 0);
  assert.equal(compareVersions("v1.2.0", "1.2"), 0);
  assert.ok(compareVersions("1.0.0-beta.1", "1.0.0") < 0);
});

test("sanitizeVersion only accepts version-shaped text", () => {
  assert.equal(sanitizeVersion("0.3.4"), "0.3.4");
  assert.equal(sanitizeVersion("0.3.4-rc.1+build"), "0.3.4-rc.1+build");
  assert.equal(sanitizeVersion("<script>"), undefined);
  assert.equal(sanitizeVersion("9".repeat(100)), undefined);
  assert.equal(sanitizeVersion(12), undefined);
});

test("fetchLatestVersion reads the npm registry and gives up quietly", async () => {
  let requested = "";
  const found = await fetchLatestVersion("@cloudagentfleet/worker", async (url) => {
    requested = String(url);
    return Response.json({ version: "0.4.0" });
  });
  assert.equal(found, "0.4.0");
  assert.equal(requested, "https://registry.npmjs.org/@cloudagentfleet%2fworker/latest");
  assert.equal(await fetchLatestVersion("x", async () => new Response("no", { status: 404 })), undefined);
  assert.equal(await fetchLatestVersion("x", async () => { throw new Error("offline"); }), undefined);
});

test("a Worker's reported version is kept across heartbeats and cleaned on the way in", () => {
  const registry = new NodeRegistry();
  registry.enroll({ nodeId: "a", name: "A", platform: "linux", capabilities: ["codeman"], version: "0.3.4" });
  registry.enroll({ nodeId: "b", name: "B", platform: "linux", capabilities: ["codeman"], version: "<b>" });
  registry.heartbeat({ nodeId: "a", sentAt: new Date().toISOString(), capabilities: ["codeman"] });
  const byId = new Map(registry.list().map((node) => [node.id, node]));
  assert.equal(byId.get("a")?.version, "0.3.4");
  assert.equal(byId.get("b")?.version, undefined);
});
