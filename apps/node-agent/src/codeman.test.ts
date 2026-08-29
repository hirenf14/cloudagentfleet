import assert from "node:assert/strict";
import test from "node:test";
import { CodemanClient, CodemanWorkerRuntime } from "./codeman.ts";
import { ControllerTransport } from "./transport.ts";
import type {
  ControlMessage,
  NodeMessage,
  WorkspaceDescriptor,
} from "../../../packages/protocol/src/index.ts";

const workspace: WorkspaceDescriptor = {
  id: "workspace-app",
  name: "app",
  canonicalPath: "C:/workspaces/app",
  health: "ready",
  providers: { codeman: "ready" },
};

function fakeCodemanFetch() {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    calls.push({ url, init });

    if (url.endsWith("/api/v1/sessions") && init?.method === "POST") {
      return Response.json({ success: true, data: { session: { id: "session-1" } } });
    }
    if (url.endsWith("/interactive") && init?.method === "POST") {
      return Response.json({ success: true, data: {} });
    }
    if (url.endsWith("/input") && init?.method === "POST") {
      return Response.json({
        success: true,
        data: { delivered: true, wait: { signal: "stop" } },
      });
    }
    if (url.endsWith("/last-response")) {
      return Response.json({
        success: true,
        data: { text: "Codeman completed the task", timestamp: Date.now() },
      });
    }
    if (url.endsWith("/session-1") && init?.method === "DELETE") {
      return Response.json({ success: true, data: {} });
    }
    return Response.json({ success: false, error: "unexpected request" }, { status: 500 });
  };
  return { calls, fetchImpl };
}

test("CodemanClient submits a prompt through the supported API", async () => {
  const fake = fakeCodemanFetch();
  const client = new CodemanClient({
    baseUrl: "http://127.0.0.1:3000/",
    username: "admin",
    password: "secret",
    fetchImpl: fake.fetchImpl,
  });

  const session = await client.createSession({
    workingDir: workspace.canonicalPath,
    mode: "claude",
    name: "hosted-worker-job",
  });
  await client.startInteractive(session.id);
  const result = await client.sendPrompt(session.id, "Fix\r\nthese files", "worker-1", 1);
  const response = await client.lastResponse(session.id);

  assert.equal(session.id, "session-1");
  assert.equal(result.wait?.signal, "stop");
  assert.equal(response.text, "Codeman completed the task");
  assert.equal(fake.calls.length, 4);
  assert.equal(JSON.parse(String(fake.calls[2]?.init?.body)).input, "Fix these files\r");
  assert.match(
    String(fake.calls[0]?.init?.headers && JSON.stringify(fake.calls[0]?.init?.headers)),
    /Basic/,
  );
});

test("CodemanWorkerRuntime executes an assigned job and reports lifecycle events", async () => {
  const fake = fakeCodemanFetch();
  const messages: NodeMessage[] = [];
  const runtime = new CodemanWorkerRuntime({
    client: new CodemanClient({
      baseUrl: "http://127.0.0.1:3000",
      fetchImpl: fake.fetchImpl,
    }),
    nodeId: "worker-1",
    workspaces: [workspace],
    workspacePolicy: { mode: "folders", roots: ["C:/workspaces"] },
    send: async (message) => messages.push(message),
  });

  const assignment: ControlMessage = {
    type: "job.assign",
    job: {
      id: "job-1",
      provider: "codeman",
      nodeId: "worker-1",
      workspaceId: workspace.id,
      prompt: "Run the smoke test",
      status: "queued",
      idempotencyKey: "smoke-1",
      createdAt: new Date().toISOString(),
    },
  };

  await runtime.handle(assignment);

  assert.deepEqual(
    messages.map((message) => message.type),
    ["job.accept", "job.event", "job.event"],
  );
  assert.equal(messages[1]?.type, "job.event");
  assert.equal(messages[2]?.type, "job.event");
  if (messages[2]?.type === "job.event") {
    assert.equal(messages[2].event, "completed");
    assert.equal(messages[2].data, "Codeman completed the task");
  }
});

test("CodemanWorkerRuntime rejects workspaces outside the approved roots", async () => {
  const fake = fakeCodemanFetch();
  const runtime = new CodemanWorkerRuntime({
    client: new CodemanClient({
      baseUrl: "http://127.0.0.1:3000",
      fetchImpl: fake.fetchImpl,
    }),
    nodeId: "worker-1",
    workspaces: [{ ...workspace, canonicalPath: "C:/secrets" }],
    workspacePolicy: { mode: "folders", roots: ["C:/workspaces"] },
    send: async () => undefined,
  });

  await assert.rejects(
    runtime.handle({
      type: "job.assign",
      job: {
        id: "job-2",
        provider: "codeman",
        nodeId: "worker-1",
        workspaceId: workspace.id,
        prompt: "Do not run",
        status: "queued",
        idempotencyKey: "blocked-1",
        createdAt: new Date().toISOString(),
      },
    }),
    /outside the worker policy/,
  );
  assert.equal(fake.calls.length, 0);
});

test("ControllerTransport enrolls and consumes outbound Controller assignments", async () => {
  const requests: string[] = [];
  const assignment: ControlMessage = {
    type: "job.cancel",
    jobId: "job-1",
  };
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    requests.push(`${init?.method ?? "GET"} ${url}`);
    if (url.endsWith("/api/workers") && init?.method === "POST") {
      return Response.json({ worker: { id: "worker-1" } }, { status: 201 });
    }
    if (url.endsWith("/connect")) {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode(`data: ${JSON.stringify(assignment)}\n\n`),
          );
          controller.close();
        },
      });
      return new Response(stream, { status: 200 });
    }
    return Response.json({ accepted: true }, { status: 202 });
  };
  const received: ControlMessage[] = [];
  const transport = new ControllerTransport({
    nodeId: "worker-1",
    name: "Worker",
    platform: "windows",
    capabilities: ["codeman"],
    controlPlaneUrl: "http://127.0.0.1:8787",
    fetchImpl,
  });

  await transport.start(async (message) => received.push(message));

  assert.deepEqual(received, [assignment]);
  assert.deepEqual(requests.slice(0, 2).map((request) => request.split(" ")[0]), ["POST", "GET"]);
});
