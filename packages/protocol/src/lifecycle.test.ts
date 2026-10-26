import assert from "node:assert/strict";
import test from "node:test";
import { JobStore, NodeRegistry } from "./lifecycle.ts";

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

test("JobStore keeps the session, the answer and the failure reason", () => {
  const now = new Date("2026-01-01T00:00:00.000Z");
  const jobs = new JobStore(() => now);
  const request = { provider: "codeman" as const, workspaceId: "w", prompt: "p", idempotencyKey: "k1" };

  const job = jobs.create(request, "worker-1");
  assert.equal(job.sessionId, undefined);
  assert.equal(jobs.start(job.id, "session-1").sessionId, "session-1");
  const done = jobs.complete(job.id, "All good");
  assert.deepEqual([done.status, done.result, done.finishedAt], ["completed", "All good", now.toISOString()]);

  const followUp = jobs.create({ ...request, idempotencyKey: "k2", sessionId: "session-1" }, "worker-1");
  assert.equal(followUp.sessionId, "session-1", "a follow-up names the session it continues");
  assert.equal(jobs.create({ ...request, idempotencyKey: "k3", agent: "codex" }, "worker-1").agent, "codex");
  const failed = jobs.fail(followUp.id, "Codeman timed out");
  assert.deepEqual([failed.status, failed.error], ["failed", "Codeman timed out"]);
});

test("JobStore keeps the agent's progress while a job runs and ignores it afterwards", () => {
  const jobs = new JobStore();
  const job = jobs.create({ provider: "codeman", workspaceId: "w", prompt: "p", idempotencyKey: "kp" }, "worker-1");
  assert.equal(jobs.progress(job.id, "too early").progress, undefined, "a queued job has no progress yet");
  jobs.start(job.id);
  assert.equal(jobs.progress(job.id, "Checking...").progress, "Checking...");
  assert.equal(jobs.progress(job.id, "Checking...\n\nWriting.").progress, "Checking...\n\nWriting.", "it grows");
  jobs.complete(job.id, "Done");
  assert.equal(jobs.progress(job.id, "late").progress, "Checking...\n\nWriting.", "a finished job keeps its last progress");
});
