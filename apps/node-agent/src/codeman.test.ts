import { mkdtemp, mkdir, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
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

function fakeCodemanFetch(sessions: Array<Record<string, unknown>> = []) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  let responses = 0;
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    calls.push({ url, init });

    if (url.endsWith("/api/v1/sessions") && (!init?.method || init.method === "GET")) {
      return Response.json({ success: true, data: { sessions } });
    }

    if (url.endsWith("/api/v1/sessions") && init?.method === "POST") {
      return Response.json({ success: true, data: { session: { id: "session-1" } } });
    }
    if (url.endsWith("/api/v1/status")) {
      return Response.json({ success: true, data: { agents: [], capabilities: [] } });
    }
    if (url.includes("/terminal?tail=")) {
      return Response.json({ success: true, data: { terminalBuffer: "❯ ", status: "idle" } });
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
    if (url.includes("/last-response")) {
      return Response.json({
        success: true,
        // Each read is a newer response, so a follow-up never sees "the previous job's" one here.
        data: { text: "Codeman completed the task", timestamp: ++responses },
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
    clientId: "cloudagentfleet-connector",
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
    { id: "shell", name: "Shell (raw CLI)", mode: "shell", ready: true },
    { id: "cursor-agent", name: "Cursor Agent", mode: "shell", ready: false },
  ]);
});

test("CodemanWorkerRuntime always keeps Shell when mode is claude", async () => {
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
    mode: "claude",
    agentProfiles: [{
      id: "claude-code",
      name: "Claude Code CLI",
      mode: "shell",
      ready: true,
    }],
  });

  const profiles = await runtime.handleConnectorRequest({
    type: "codeman.request",
    requestId: "request-shell-kept",
    instanceId: "worker-1",
    operation: "capabilities",
    payload: {},
  });

  assert.deepEqual(profiles, [
    { id: "shell", name: "Shell (raw CLI)", mode: "shell", ready: true },
    { id: "claude", name: "Claude Code", mode: "claude", ready: true },
    { id: "claude-code", name: "Claude Code CLI", mode: "shell", ready: true },
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
    clientId: "cloudagentfleet-connector",
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
    send: async (message) => { messages.push(message); },
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
  const root = await mkdtemp(join(tmpdir(), "cloudagentfleet-suggest-"));
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
    // Suggestions are real paths (on macOS the tmp root is /var/..., really /private/var/...).
    assert.deepEqual(suggestions, [{ path: await realpath(join(root, "alpha")), name: "alpha" }]);
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

  await transport.start(async (message) => { received.push(message); });

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

test("ControllerTransport answers an operation it does not know and keeps the stream", async () => {
  const posted: NodeMessage[] = [];
  const events = [
    { type: "codeman.request", requestId: "request-1", instanceId: "codeman-1", operation: "future.operation" },
    { type: "codeman.request", requestId: "request-2", instanceId: "codeman-1", operation: "status" },
  ];
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
          for (const event of events) {
            controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`));
          }
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
    connectorInstanceId: "codeman-1",
    fetchImpl,
  });

  // Without reconnect, a thrown stream error would reject start().
  await transport.start(
    async () => undefined,
    async () => ({ version: "1.0.0" }),
  );
  await new Promise((resolve) => setTimeout(resolve, 20));

  const responses = posted.filter((message) => message.type === "codeman.response");
  assert.deepEqual(responses.map((message) => message.requestId).sort(), ["request-1", "request-2"]);
  const unknown = responses.find((message) => message.requestId === "request-1");
  assert.equal(unknown?.success, false);
  assert.equal(unknown?.errorCode, "connector_operation_unsupported");
  assert.equal(responses.find((message) => message.requestId === "request-2")?.success, true);
});

test("ControllerTransport survives a Controller restart and re-enrolls", async () => {
  let enrolled = false;
  let enrollments = 0;
  let restarted = false;
  let connectedAfterRestart = false;
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith("/api/workers") && init?.method === "POST") {
      enrollments += 1;
      enrolled = true;
      return Response.json({ worker: { id: "worker-1" } }, { status: 201 });
    }
    if (url.endsWith("/connect")) {
      if (!enrolled) return Response.json({ error: "Worker not found" }, { status: 404 });
      if (restarted) connectedAfterRestart = true;
      // The first stream ends as if the Controller went away; later ones stay open.
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          if (!restarted) {
            restarted = true;
            enrolled = false;
            controller.close();
            return;
          }
          // Like real fetch, an aborted request errors the open stream.
          init?.signal?.addEventListener("abort", () => controller.error(new DOMException("aborted", "AbortError")));
        },
      }), { status: 200 });
    }
    // Heartbeats and messages fail with 400 while this node is unknown.
    return enrolled
      ? Response.json({ accepted: true }, { status: 202 })
      : Response.json({ error: "Unknown node" }, { status: 400 });
  };
  const transport = new ControllerTransport({
    nodeId: "worker-1",
    name: "Worker",
    platform: "linux",
    capabilities: ["codeman"],
    controlPlaneUrl: "http://127.0.0.1:8787",
    fetchImpl,
    heartbeatIntervalMs: 5,
    reconnect: true,
    reconnectDelayMs: 5,
  });
  const running = transport.start(async () => undefined).catch((error: unknown) => error);
  await new Promise((resolve) => setTimeout(resolve, 150));
  transport.stop();
  const outcome = await running;
  assert.ok(enrollments >= 2, `re-enrolled after the restart (enrollments=${enrollments})`);
  assert.equal(connectedAfterRestart, true, "reconnected after re-enrolling");
  assert.ok(!(outcome instanceof Error) || outcome.name === "AbortError", "only a requested stop ends the loop");
});

test("CodemanWorkerRuntime continues an earlier job's session for a follow-up job", async () => {
  const fake = fakeCodemanFetch([
    { id: "session-1", name: "hosted-worker-1-job-1" },
    { id: "session-mine", name: "Claude Code · app" },
  ]);
  const messages: NodeMessage[] = [];
  const runtime = new CodemanWorkerRuntime({
    client: new CodemanClient({ baseUrl: "http://127.0.0.1:3000", fetchImpl: fake.fetchImpl }),
    nodeId: "worker-1",
    workspaces: [workspace],
    workspacePolicy: { mode: "folders", roots: ["C:/workspaces"] },
    send: async (message) => { messages.push(message); },
  });
  const job = (id: string, sessionId: string) => ({
    type: "job.assign" as const,
    job: {
      id, provider: "codeman" as const, nodeId: "worker-1", workspaceId: workspace.id, prompt: "Make it shorter",
      status: "queued" as const, idempotencyKey: id, createdAt: new Date().toISOString(), sessionId,
    },
  });

  await runtime.handle(job("job-2", "session-1"));
  const posts = fake.calls.filter((call) => call.init?.method === "POST").map((call) => call.url.replace("http://127.0.0.1:3000", ""));
  assert.deepEqual(posts, ["/api/v1/sessions/session-1/input"], "no new session, no restart: the prompt goes into the same session");
  const started = messages.find((message) => message.type === "job.event" && message.event === "started");
  assert.equal(started?.type === "job.event" ? started.sessionId : undefined, "session-1");
  const completed = messages.at(-1);
  assert.equal(completed?.type === "job.event" ? completed.data : undefined, "Codeman completed the task");

  await assert.rejects(runtime.handle(job("job-3", "session-mine")), /was not started by a job/);
  await assert.rejects(runtime.handle(job("job-4", "session-gone")), /Session not found/);
});

test("CodemanWorkerRuntime starts the agent a job asks for", async () => {
  const fake = fakeCodemanFetch();
  const runtime = new CodemanWorkerRuntime({
    client: new CodemanClient({ baseUrl: "http://127.0.0.1:3000", fetchImpl: fake.fetchImpl }),
    nodeId: "worker-1",
    workspaces: [workspace],
    workspacePolicy: { mode: "folders", roots: ["C:/workspaces"] },
    send: async () => {},
  });
  await runtime.handle({
    type: "job.assign",
    job: {
      id: "job-codex", provider: "codeman", nodeId: "worker-1", workspaceId: workspace.id, prompt: "Review the diff",
      status: "queued", idempotencyKey: "codex-1", createdAt: new Date().toISOString(), agent: "codex",
    },
  });
  const create = fake.calls.find((call) => call.url.endsWith("/api/v1/sessions") && call.init?.method === "POST");
  assert.equal(JSON.parse(String(create?.init?.body)).mode, "codex");
});

test("CodemanWorkerRuntime waits for a new session to settle and re-sends a dropped Enter", async () => {
  const fake = fakeCodemanFetch();
  let entered = false;
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.includes("/terminal?tail=")) {
      fake.calls.push({ url, init });
      // The agent took the text but not the Enter: the prompt sits in the input box until a bare Enter arrives.
      const buffer = entered ? "❯ Write the summary\nDone." : "\x1b[2m❯ \x1b[0mWrite   the summary";
      return Response.json({ success: true, data: { terminalBuffer: buffer, status: "idle" } });
    }
    if (url.endsWith("/input") && JSON.parse(String(init?.body)).input === "\r") entered = true;
    if (url.includes("/last-response")) {
      fake.calls.push({ url, init });
      return Response.json({ success: true, data: { text: entered ? "Done." : "", timestamp: Date.now() } });
    }
    return fake.fetchImpl(input, init);
  };
  const messages: NodeMessage[] = [];
  const runtime = new CodemanWorkerRuntime({
    client: new CodemanClient({ baseUrl: "http://127.0.0.1:3000", fetchImpl }),
    nodeId: "worker-1",
    workspaces: [workspace],
    workspacePolicy: { mode: "folders", roots: ["C:/workspaces"] },
    send: async (message) => { messages.push(message); },
    settleMs: 100,
  });
  await runtime.handle({
    type: "job.assign",
    job: {
      id: "job-enter", provider: "codeman", nodeId: "worker-1", workspaceId: workspace.id, prompt: "Write the summary",
      status: "queued", idempotencyKey: "enter-1", createdAt: new Date().toISOString(),
    },
  });

  const urls = fake.calls.map((call) => call.url.replace("http://127.0.0.1:3000/api/v1/sessions", ""));
  const firstInput = urls.indexOf("/session-1/input");
  assert.ok(urls.slice(urls.indexOf("/session-1/interactive"), firstInput).some((u) => u.includes("/terminal")), "the first prompt waits for the terminal to settle");
  assert.equal(urls.filter((u) => u === "/session-1/input").length, 2, "one prompt, one retried Enter");
  const completed = messages.at(-1);
  assert.equal(completed?.type === "job.event" ? completed.data : undefined, "Done.");
});

test("CodemanWorkerRuntime does not report the previous job's response for a follow-up", async () => {
  const fake = fakeCodemanFetch([{ id: "session-1", name: "hosted-worker-1-job-1" }]);
  let sent = false;
  let readsAfterSend = 0;
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith("/input")) sent = true;
    if (url.includes("/last-response")) {
      // The new answer lands a moment after the wait returns; until then the old one is served.
      const fresh = sent && ++readsAfterSend > 2;
      return Response.json({
        success: true,
        data: fresh ? { text: "kestrel", timestamp: "2026-10-24T08:36:43.316Z" } : { text: "first-ok", timestamp: "2026-10-24T08:36:31.000Z" },
      });
    }
    return fake.fetchImpl(input, init);
  };
  const messages: NodeMessage[] = [];
  const runtime = new CodemanWorkerRuntime({
    client: new CodemanClient({ baseUrl: "http://127.0.0.1:3000", fetchImpl }),
    nodeId: "worker-1",
    workspaces: [workspace],
    workspacePolicy: { mode: "folders", roots: ["C:/workspaces"] },
    send: async (message) => { messages.push(message); },
  });
  await runtime.handle({
    type: "job.assign",
    job: {
      id: "job-2", provider: "codeman", nodeId: "worker-1", workspaceId: workspace.id, prompt: "Which word?",
      status: "queued", idempotencyKey: "job-2", createdAt: new Date().toISOString(), sessionId: "session-1",
    },
  });
  const completed = messages.at(-1);
  assert.equal(completed?.type === "job.event" ? completed.data : undefined, "kestrel");
});

test("CodemanWorkerRuntime reports the final message when the transcript write trails the stop signal", async () => {
  const fake = fakeCodemanFetch();
  let sent = false;
  let readsAfterSend = 0;
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith("/input")) sent = true;
    if (url.includes("/last-response")) {
      // The interim "Checking..." line is on disk when the stop signal fires; the final answer lands a few reads later.
      readsAfterSend += sent ? 1 : 0;
      const data = readsAfterSend === 0
        ? { text: "", timestamp: "t0" }
        : readsAfterSend < 2
          ? { text: "Checking the login, then I'll write the plan.", timestamp: "t1" }
          : { text: "Plan written. Needs you: #28.", timestamp: "t2" };
      return Response.json({ success: true, data });
    }
    return fake.fetchImpl(input, init);
  };
  const messages: NodeMessage[] = [];
  const runtime = new CodemanWorkerRuntime({
    client: new CodemanClient({ baseUrl: "http://127.0.0.1:3000", fetchImpl }),
    nodeId: "worker-1",
    workspaces: [workspace],
    workspacePolicy: { mode: "folders", roots: ["C:/workspaces"] },
    send: async (message) => { messages.push(message); },
    settleMs: 60,
  });
  await runtime.handle({
    type: "job.assign",
    job: {
      id: "job-final", provider: "codeman", nodeId: "worker-1", workspaceId: workspace.id, prompt: "Run for today",
      status: "queued", idempotencyKey: "final-1", createdAt: new Date().toISOString(),
    },
  });
  const completed = messages.at(-1);
  assert.equal(completed?.type === "job.event" ? completed.data : undefined, "Plan written. Needs you: #28.");
});

test("CodemanWorkerRuntime reports the whole turn: progress notes and the final answer", async () => {
  const fake = fakeCodemanFetch();
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.includes("/last-response")) {
      const full = url.includes("context=full");
      const turn = "Checking the login, then I'll write the plan.\n\nPlan written. Needs you: #28.";
      return Response.json({
        success: true,
        data: full
          ? { text: "Plan written. Needs you: #28.", timestamp: "t2", messages: [{ role: "user", text: "Run for today" }, { role: "assistant", text: turn }] }
          : { text: "", timestamp: "t0" },
      });
    }
    return fake.fetchImpl(input, init);
  };
  const messages: NodeMessage[] = [];
  const runtime = new CodemanWorkerRuntime({
    client: new CodemanClient({ baseUrl: "http://127.0.0.1:3000", fetchImpl }),
    nodeId: "worker-1",
    workspaces: [workspace],
    workspacePolicy: { mode: "folders", roots: ["C:/workspaces"] },
    send: async (message) => { messages.push(message); },
    settleMs: 60,
  });
  await runtime.handle({
    type: "job.assign",
    job: {
      id: "job-turn", provider: "codeman", nodeId: "worker-1", workspaceId: workspace.id, prompt: "Run for today",
      status: "queued", idempotencyKey: "turn-1", createdAt: new Date().toISOString(),
    },
  });
  const completed = messages.at(-1);
  assert.equal(
    completed?.type === "job.event" ? completed.data : undefined,
    "Checking the login, then I'll write the plan.\n\nPlan written. Needs you: #28.",
  );
});

test("CodemanWorkerRuntime sends the reply so far to the Hub while a Claude job runs", async () => {
  const fake = fakeCodemanFetch();
  let sent = false;
  let reads = 0;
  const turns = ["Checking the login.", "Checking the login.\n\nWriting the plan.", "Checking the login.\n\nWriting the plan.\n\nDone: #28."];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith("/input")) {
      sent = true;
      return Response.json({ success: true, data: { delivered: true, wait: { timedOut: true } } });
    }
    if (url.includes("/wait")) {
      await new Promise((resolve) => setTimeout(resolve, 400)); // the agent works for a while
      return Response.json({ success: true, data: { wait: { signal: "stop" } } });
    }
    if (url.includes("/last-response")) {
      const turn = sent ? turns[Math.min(Math.floor(reads++ / 3), turns.length - 1)]! : "";
      return Response.json({
        success: true,
        data: { text: turn, timestamp: sent ? `t${turn.length}` : "t0", messages: turn ? [{ role: "assistant", text: turn }] : [] },
      });
    }
    return fake.fetchImpl(input, init);
  };
  const messages: NodeMessage[] = [];
  const runtime = new CodemanWorkerRuntime({
    client: new CodemanClient({ baseUrl: "http://127.0.0.1:3000", fetchImpl }),
    nodeId: "worker-1",
    workspaces: [workspace],
    workspacePolicy: { mode: "folders", roots: ["C:/workspaces"] },
    send: async (message) => { messages.push(message); },
    settleMs: 60,
    progressMs: 30,
  });
  await runtime.handle({
    type: "job.assign",
    job: {
      id: "job-live", provider: "codeman", nodeId: "worker-1", workspaceId: workspace.id, prompt: "Run for today",
      status: "queued", idempotencyKey: "live-1", createdAt: new Date().toISOString(),
    },
  });
  const events = messages.filter((m) => m.type === "job.event");
  const output = events.filter((m) => m.event === "output").map((m) => m.data);
  assert.ok(output.length >= 2, "progress arrives before the job ends");
  assert.equal(output[0], "Checking the login.");
  assert.ok(output.every((text, i) => i === 0 || text!.startsWith(output[i - 1]!)), "each update extends the last");
  assert.equal(events.at(-1)?.event, "completed", "the final result still closes the job");
});

test("CodemanWorkerRuntime ends a hookless agent's turn on a fresh reply and a still screen", async () => {
  const fake = fakeCodemanFetch();
  const inputs: string[] = [];
  let reads = 0;
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.includes("/wait")) throw new Error("Codex never fires stop/working; the Worker must not wait on them");
    if (url.endsWith("/input")) {
      inputs.push(JSON.parse(String(init?.body)).input);
      return Response.json({ success: true, data: { delivered: true } });
    }
    const entered = inputs.includes("\r");
    if (url.includes("/terminal?tail=")) {
      // Before the retried Enter the screen is still (prompt stuck in the box); after it the agent works for a few frames.
      const frame = entered ? `working ${Math.min(++reads, 5)}` : "› Review the diff";
      return Response.json({ success: true, data: { terminalBuffer: frame, status: "idle" } });
    }
    if (url.includes("/last-response")) {
      const done = entered && reads >= 5;
      return Response.json({ success: true, data: done ? { text: "LGTM", timestamp: "t2" } : { text: "", timestamp: "t0" } });
    }
    return fake.fetchImpl(input, init);
  };
  const messages: NodeMessage[] = [];
  const runtime = new CodemanWorkerRuntime({
    client: new CodemanClient({ baseUrl: "http://127.0.0.1:3000", fetchImpl }),
    nodeId: "worker-1",
    workspaces: [workspace],
    workspacePolicy: { mode: "folders", roots: ["C:/workspaces"] },
    send: async (message) => { messages.push(message); },
    settleMs: 60,
  });
  await runtime.handle({
    type: "job.assign",
    job: {
      id: "job-codex", provider: "codeman", nodeId: "worker-1", workspaceId: workspace.id, prompt: "Review the diff",
      status: "queued", idempotencyKey: "codex-2", createdAt: new Date().toISOString(), agent: "codex",
    },
  });
  assert.deepEqual(inputs, ["Review the diff\r", "\r"], "the prompt, then one Enter for the dropped one");
  const completed = messages.at(-1);
  assert.equal(completed?.type === "job.event" ? completed.event : undefined, "completed");
  assert.equal(completed?.type === "job.event" ? completed.data : undefined, "LGTM");
});

test("CodemanWorkerRuntime ignores a reply that was there before a new session's prompt", async () => {
  const fake = fakeCodemanFetch();
  let typed = false;
  let frames = 0;
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith("/input")) {
      typed = true;
      return Response.json({ success: true, data: { delivered: true } });
    }
    if (url.includes("/terminal?tail=")) {
      // The screen goes still early (frame 3) while only the other session's reply is available.
      if (typed) frames += 1;
      return Response.json({ success: true, data: { terminalBuffer: typed ? `frame ${Math.min(frames, 3)}` : "›", status: "idle" } });
    }
    if (url.includes("/last-response")) {
      // Until this session's own reply exists, Codeman serves another session's from the same folder.
      const own = typed && frames >= 12;
      return Response.json({ success: true, data: own ? { text: "first-ok", timestamp: "t9" } : { text: "long-ok", timestamp: "t1" } });
    }
    return fake.fetchImpl(input, init);
  };
  const messages: NodeMessage[] = [];
  const runtime = new CodemanWorkerRuntime({
    client: new CodemanClient({ baseUrl: "http://127.0.0.1:3000", fetchImpl }),
    nodeId: "worker-1",
    workspaces: [workspace],
    workspacePolicy: { mode: "folders", roots: ["C:/workspaces"] },
    send: async (message) => { messages.push(message); },
    settleMs: 60,
  });
  await runtime.handle({
    type: "job.assign",
    job: {
      id: "job-new-codex", provider: "codeman", nodeId: "worker-1", workspaceId: workspace.id, prompt: "Reply first-ok",
      status: "queued", idempotencyKey: "codex-3", createdAt: new Date().toISOString(), agent: "codex",
    },
  });
  const completed = messages.at(-1);
  assert.equal(completed?.type === "job.event" ? completed.data : undefined, "first-ok");
});

test("CodemanWorkerRuntime hands a long or multi-line prompt over as a file", async () => {
  const fake = fakeCodemanFetch();
  const promptDir = await mkdtemp(join(tmpdir(), "cloudagentfleet-prompts-"));
  const prompt = `# Your instructions (Skill: daily, ops nest)\n\n${"Check the pipeline. ".repeat(40)}\n\nWhat changed today?`;
  let seen = "";
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith("/input")) {
      const typed = JSON.parse(String(init?.body)).input as string;
      const file = typed.match(/Read the file (\S+) and do what it asks/)?.[1];
      seen = file ? await readFile(file, "utf8") : typed;
    }
    return fake.fetchImpl(input, init);
  };
  const messages: NodeMessage[] = [];
  const runtime = new CodemanWorkerRuntime({
    client: new CodemanClient({ baseUrl: "http://127.0.0.1:3000", fetchImpl }),
    nodeId: "worker-1",
    workspaces: [workspace],
    workspacePolicy: { mode: "folders", roots: ["C:/workspaces"] },
    send: async (message) => { messages.push(message); },
    settleMs: 60,
    promptDir,
  });
  await runtime.handle({
    type: "job.assign",
    job: {
      id: "job-long", provider: "codeman", nodeId: "worker-1", workspaceId: workspace.id, prompt,
      status: "queued", idempotencyKey: "long-1", createdAt: new Date().toISOString(),
    },
  });
  assert.equal(seen, prompt, "the agent reads the whole prompt, newlines included");
  assert.deepEqual(await readdir(promptDir), [], "the file is removed once the job ends");
  await rm(promptDir, { recursive: true, force: true });
});
