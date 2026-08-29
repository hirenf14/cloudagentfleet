import assert from "node:assert/strict";
import test from "node:test";
import { createControllerServer } from "./server.ts";
import type { ControlMessage, NodeRegistration } from "../../../packages/protocol/src/index.ts";

const registration: NodeRegistration = {
  nodeId: "worker-local",
  name: "Local worker",
  platform: "windows",
  capabilities: ["codeman", "preview-relay"],
  workspacePolicy: {
    mode: "folders",
    roots: ["C:/workspaces"],
  },
  workspaces: [
    {
      id: "workspace-app",
      name: "app",
      canonicalPath: "C:/workspaces/app",
      health: "ready",
      providers: {
        codeman: "ready",
      },
    },
  ],
};

async function json(response: Response): Promise<Record<string, any>> {
  return (await response.json()) as Record<string, any>;
}

async function listen(app: ReturnType<typeof createControllerServer>): Promise<string> {
  await new Promise<void>((resolve) => {
    app.server.listen(0, "127.0.0.1", resolve);
  });
  const address = app.server.address();
  if (!address || typeof address === "string") throw new Error("Server did not bind");
  return `http://127.0.0.1:${address.port}`;
}

test("enrolls, assigns, cancels, audits, and revokes a Worker", async () => {
  const app = createControllerServer();
  const baseUrl = await listen(app);
  const messages: ControlMessage[] = [];

  try {
    const enrolledResponse = await fetch(`${baseUrl}/api/workers`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(registration),
    });
    assert.equal(enrolledResponse.status, 201);
    const enrolled = await json(enrolledResponse);
    assert.equal(enrolled.worker.id, registration.nodeId);
    assert.equal(enrolled.worker.workspaces[0].id, "workspace-app");

    app.controlPlane.registerConnection({
      node: enrolled.worker,
      send: async (message) => {
        messages.push(message);
      },
      close: async () => undefined,
    });

    const heartbeatResponse = await fetch(
      `${baseUrl}/api/workers/${registration.nodeId}/heartbeat`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          nodeId: "ignored-by-route",
          sentAt: new Date().toISOString(),
          capabilities: registration.capabilities,
        }),
      },
    );
    assert.equal(heartbeatResponse.status, 200);

    const jobResponse = await fetch(`${baseUrl}/api/jobs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        provider: "codeman",
        nodeId: registration.nodeId,
        workspaceId: "workspace-app",
        prompt: "Run the local smoke test",
        idempotencyKey: "smoke-test-1",
      }),
    });
    assert.equal(jobResponse.status, 202);
    const created = await json(jobResponse);
    assert.equal(created.job.workspaceId, "workspace-app");
    assert.equal(created.job.status, "queued");
    assert.equal(messages[0].type, "job.assign");

    const duplicateResponse = await fetch(`${baseUrl}/api/jobs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        provider: "codeman",
        nodeId: registration.nodeId,
        workspaceId: "workspace-app",
        prompt: "This must not create a second job",
        idempotencyKey: "smoke-test-1",
      }),
    });
    const duplicate = await json(duplicateResponse);
    assert.equal(duplicate.job.id, created.job.id);
    assert.equal(messages.length, 1);

    const cancelResponse = await fetch(`${baseUrl}/api/jobs/${created.job.id}/cancel`, {
      method: "POST",
    });
    assert.equal(cancelResponse.status, 202);
    const cancelled = await json(cancelResponse);
    assert.equal(cancelled.job.status, "cancelled");
    assert.equal(messages[1].type, "job.cancel");

    const auditResponse = await fetch(`${baseUrl}/api/audit`);
    const audit = await json(auditResponse);
    assert.deepEqual(
      audit.events.map((event: { type: string }) => event.type),
      ["node.enrolled", "node.heartbeat", "job.created", "job.cancelled"],
    );

    app.controlPlane.revokeNode(registration.nodeId);
    const workersResponse = await fetch(`${baseUrl}/api/workers`);
    const workers = await json(workersResponse);
    assert.equal(workers.workers[0].status, "revoked");
  } finally {
    await new Promise<void>((resolve, reject) => {
      app.server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});
