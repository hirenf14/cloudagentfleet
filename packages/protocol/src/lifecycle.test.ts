import assert from "node:assert/strict";
import test from "node:test";
import { NodeRegistry } from "./lifecycle.ts";

test("NodeRegistry marks a node offline once its heartbeat times out", () => {
  let now = new Date("2026-01-01T00:00:00.000Z");
  const registry = new NodeRegistry(() => now, 45_000);
  registry.enroll({
    nodeId: "worker-1",
    name: "Worker 1",
    platform: "linux",
    capabilities: ["codeman"],
  });
  assert.equal(registry.list()[0]?.status, "online");

  now = new Date("2026-01-01T00:00:46.000Z");
  assert.equal(registry.list()[0]?.status, "offline");
  assert.throws(() => registry.select("codeman"), /No online node supports provider/);

  registry.heartbeat({ nodeId: "worker-1", sentAt: now.toISOString(), capabilities: ["codeman"] });
  assert.equal(registry.list()[0]?.status, "online");
});
