import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
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
    if (url.endsWith("/api/v1/status")) {
      return Response.json({ success: true, data: { agents: [], capabilities: [] } });
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

test("CodemanClient sends raw terminal input through the direct PTY path", async () => {
  const fake = fakeCodemanFetch();
  const client = new CodemanClient({
    baseUrl: "http://127.0.0.1:3000",
    fetchImpl: fake.fetchImpl,
  });

  await client.sendInput("session-1", "\u001b[31m", true);

  const body = JSON.parse(String(fake.calls.at(-1)?.init?.body));
  assert.equal(body.input, "\u001b[31m");
  assert.equal(body.useMux, false);
});

test("CodemanWorkerRuntime launches Cursor Agent inside a persistent Codeman session", async () => {
  const fake = fakeCodemanFetch();
  const runtime = new CodemanWorkerRuntime({
    client: new CodemanClient({
      baseUrl: "http://127.0.0.1:3000",
      fetchImpl: fake.fetchImpl,
    }),
    nodeId: "worker-1",
    workspaces: [workspace],
    workspacePolicy: { mode: "folders", roots: ["C:/workspaces"] },
    send: async () => undefined,
    cursorCommand: "agent",
    agentProfiles: [{
      id: "cursor-agent",
      name: "Cursor Agent",
      mode: "shell",
      ready: true,
    }],
  });

  await runtime.handleConnectorRequest({
    type: "codeman.request",
    requestId: "request-1",
    instanceId: "worker-1",
    operation: "sessions.create",
    payload: {
      workspaceId: workspace.id,
      agent: {
        id: "cursor-agent",
        name: "Cursor Agent",
        mode: "shell",
        ready: true,
      },
    },
  });

  const inputCalls = fake.calls.filter((call) => call.url.endsWith("/input"));
  assert.equal(inputCalls.length, 1);
  assert.deepEqual(JSON.parse(String(inputCalls[0]?.init?.body)), {
    input: "agent\r",
    useMux: false,
    clientId: "hosted-agents-connector",
    seq: JSON.parse(String(inputCalls[0]?.init?.body)).seq,
  });
});

test("CodemanWorkerRuntime reports configured and locally detected profiles", async () => {
  const fake = fakeCodemanFetch();
  const runtime = new CodemanWorkerRuntime({
    client: new CodemanClient({
      baseUrl: "http://127.0.0.1:3000",
      fetchImpl: fake.fetchImpl,
    }),
    nodeId: "worker-1",
    workspaces: [workspace],
    workspacePolicy: { mode: "folders", roots: ["C:/workspaces"] },
    send: async () => undefined,
    mode: "shell",
    agentProfiles: [{
      id: "cursor-agent",
      name: "Cursor Agent",
      mode: "shell",
      ready: false,
    }],
  });

  const profiles = await runtime.handleConnectorRequest({
    type: "codeman.request",
    requestId: "request-2",
    instanceId: "worker-1",
    operation: "capabilities",
    payload: {},
  });

  assert.deepEqual(profiles, [
    { id: "shell", name: "shell", mode: "shell", ready: true },
    { id: "cursor-agent", name: "Cursor Agent", mode: "shell", ready: false },
  ]);
});

test("CodemanWorkerRuntime forwards Enter and whitespace-only terminal input", async () => {
  const fake = fakeCodemanFetch();
  const runtime = new CodemanWorkerRuntime({
    client: new CodemanClient({
      baseUrl: "http://127.0.0.1:3000",
      fetchImpl: fake.fetchImpl,
    }),
    nodeId: "worker-1",
    workspaces: [workspace],
    workspacePolicy: { mode: "folders", roots: ["C:/workspaces"] },
    send: async () => undefined,
  });

  await runtime.handleConnectorRequest({
    type: "codeman.request",
    requestId: "request-3",
    instanceId: "worker-1",
    operation: "sessions.input",
    payload: { sessionId: "session-1", input: "\r", raw: false },
  });

  const inputCall = fake.calls.find((call) => call.url.endsWith("/input"));
  assert.deepEqual(JSON.parse(String(inputCall?.init?.body)), {
    input: "\r",
    useMux: true,
    clientId: "hosted-agents-connector",
    seq: JSON.parse(String(inputCall?.init?.body)).seq,
  });
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

test("CodemanWorkerRuntime suggests only policy-approved real directories", async () => {
  const root = await mkdtemp(join(tmpdir(), "hosted-agents-suggest-"));
  try {
    await mkdir(join(root, "alpha"));
    await mkdir(join(root, "beta"));
    await writeFile(join(root, "alpha.txt"), "not a directory");
    try {
      await symlink(join(root, "alpha"), join(root, "link"), "junction");
    } catch {
      // Junction creation may require elevated permissions on Windows.
    }
    const runtime = new CodemanWorkerRuntime({
      client: new CodemanClient({
        baseUrl: "http://127.0.0.1:3000",
        fetchImpl: fakeCodemanFetch().fetchImpl,
      }),
      nodeId: "worker-1",
      workspaces: [],
      workspacePolicy: { mode: "folders", roots: [root] },
      send: async () => undefined,
    });

    const suggestions = await runtime.handleConnectorRequest({
      type: "codeman.request",
      requestId: "suggest-1",
      instanceId: "worker-1",
      operation: "workspaces.suggest",
      payload: { prefix: join(root, "a") },
    });
    assert.deepEqual(suggestions, [{ path: join(root, "alpha"), name: "alpha" }]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
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

test("ControllerTransport correlates connector requests and rejects another instance", async () => {
  const posted: NodeMessage[] = [];
  const request: ControlMessage = {
    type: "codeman.request",
    requestId: "request-1",
    instanceId: "codeman-1",
    operation: "status",
  };
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith("/api/workers") && init?.method === "POST") {
      return Response.json({ worker: { id: "worker-1" } }, { status: 201 });
    }
    if (url.endsWith("/messages") && init?.method === "POST") {
      posted.push(JSON.parse(String(init.body)) as NodeMessage);
      return Response.json({ accepted: true }, { status: 202 });
    }
    if (url.endsWith("/connect")) {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(request)}\n\n`));
          controller.close();
        },
      });
      return new Response(stream, { status: 200 });
    }
    return Response.json({ accepted: true }, { status: 202 });
  };
  const transport = new ControllerTransport({
    nodeId: "worker-1",
    name: "Worker",
    platform: "windows",
    capabilities: ["codeman"],
    controlPlaneUrl: "http://127.0.0.1:8787",
    connectorInstanceId: "codeman-2",
    fetchImpl,
  });

  await transport.start(
    async () => undefined,
    async () => ({ version: "1.0.0" }),
  );

  assert.equal(posted.length, 1);
  assert.deepEqual(posted[0], {
    type: "codeman.response",
    requestId: "request-1",
    instanceId: "codeman-1",
    success: false,
    error: "Connector instance authorization failed",
    errorCode: "connector_request_failed",
  });
});
