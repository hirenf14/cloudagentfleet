import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { CodemanConnectorAdapter, CodemanHttpAdapter } from "./index.ts";
import type {
  CodemanInstance,
  CodemanSessionEvent,
  WorkspaceDescriptor,
} from "../../../packages/protocol/src/index.ts";

const workspace: WorkspaceDescriptor = {
  id: "workspace-app",
  name: "app",
  canonicalPath: "/workspaces/app",
  health: "ready",
  providers: { codeman: "ready" },
};

const instance: CodemanInstance = {
  id: "codeman-1",
  label: "Codeman",
  connectionMode: "tailscale-url",
  endpoint: "https://codeman.example.ts.net",
  status: "offline",
  capabilities: ["codeman"],
  agents: [{ id: "claude", name: "Claude Code", mode: "claude", ready: true }],
  workspaces: [workspace],
  lastSeenAt: null,
  createdAt: "2026-08-29T00:00:00.000Z",
};

test("CodemanHttpAdapter discovers capabilities and controls namespaced sessions", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.endsWith("/api/v1/status")) {
      return Response.json({
        success: true,
        data: { version: "1.23.2", agents: [{ id: "claude", mode: "claude", available: true }] },
      });
    }
    if (url.endsWith("/api/v1/capabilities")) {
      return Response.json({
        success: true,
        data: { agents: [{ id: "claude", mode: "claude", available: true }] },
      });
    }
    if (url.endsWith("/api/v1/sessions") && init?.method === "GET") {
      return Response.json({
        success: true,
        data: { sessions: [{ id: "session-1", workingDir: workspace.canonicalPath, mode: "claude" }] },
      });
    }
    if (url.includes("/api/v1/sessions/session-1/terminal?tail=20000")) {
      return Response.json({
        success: true,
        data: { terminalBuffer: "\u001b[32mlive terminal output\u001b[0m\r\n", status: "busy" },
      });
    }
    if (url.endsWith("/api/v1/sessions") && init?.method === "POST") {
      return Response.json({ success: true, data: { session: { id: "session-1" } } });
    }
    if (url.endsWith("/interactive") || url.endsWith("/input")) {
      return Response.json({ success: true, data: {} });
    }
    if (url.endsWith("/session-1") && init?.method === "DELETE") {
      return Response.json({ success: true, data: {} });
    }
    return Response.json({ success: true, data: {} });
  };

  const adapter = new CodemanHttpAdapter({
    instance,
    username: "operator",
    password: "secret",
    fetchImpl,
  });
  const agents = await adapter.listCapabilities();
  const status = await adapter.getStatus();
  const sessions = await adapter.listSessions();
  const session = await adapter.createSession(workspace, agents[0]!);
  await adapter.sendInput(session.id, "line one\nline two");
  await adapter.sendInput(session.id, "\u001b[A", true);
  await adapter.resize(session.id, 120, 36);
  await adapter.stopSession(session.id);

  assert.equal(agents[0]?.ready, true);
  assert.equal(status.version, "1.23.2");
  assert.equal(sessions[0]?.instanceId, instance.id);
  assert.equal(sessions[0]?.workspaceId, workspace.id);
  assert.equal(sessions[0]?.terminalBuffer, "\u001b[32mlive terminal output\u001b[0m\r\n");
  assert.equal(sessions[0]?.status, "working");
  assert.equal(session.instanceId, instance.id);
  assert.equal(
    JSON.parse(String(calls.find((call) => call.url.endsWith("/input"))?.init?.body)).input,
    "line one line two\r",
  );
  assert.equal(
    JSON.parse(String(calls.find((call) => call.url.endsWith("/input"))?.init?.body)).useMux,
    true,
  );
  assert.equal(
    JSON.parse(String(calls.filter((call) => call.url.endsWith("/input")).at(-1)?.init?.body)).input,
    "\u001b[A",
  );
  assert.equal(
    JSON.parse(String(calls.filter((call) => call.url.endsWith("/input")).at(-1)?.init?.body)).useMux,
    false,
  );
  const resizeCall = calls.find((call) => call.url.endsWith("/resize"));
  assert.deepEqual(JSON.parse(String(resizeCall?.init?.body)), {
    cols: 120,
    rows: 36,
    viewportType: "desktop",
  });
  assert.match(
    String(calls[0]?.init?.headers && JSON.stringify(calls[0]?.init?.headers)),
    /Basic/,
  );
});

test("CodemanHttpAdapter maps provider SSE events", async () => {
  const received: unknown[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith("/api/v1/events")) {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(
            "event: output\r\n"
            + 'data: {"session_id":"session-1","data":"hello"}\r\n\r\n',
          ));
          controller.close();
        },
      });
      return new Response(stream, { status: 200 });
    }
    return Response.json({ success: true, data: {} });
  };
  const adapter = new CodemanHttpAdapter({ instance, fetchImpl });
  const unsubscribe = adapter.subscribeEvents((event) => received.push(event));
  await new Promise((resolve) => setTimeout(resolve, 10));
  unsubscribe();

  assert.deepEqual(received, [{
    instanceId: instance.id,
    sessionId: "session-1",
    event: "output",
    data: "hello",
    createdAt: (received[0] as { createdAt: string }).createdAt,
  }]);
});

test("CodemanHttpAdapter links Hub workspaces as Codeman cases for native Quick Start", async () => {
  const calls: Array<{ method?: string; url: string; body?: string }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? init.body : undefined;
    calls.push({ method, url, body });
    if (url.endsWith("/api/cases") && method === "GET") {
      return new Response(JSON.stringify({ success: true, data: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url.endsWith("/api/cases/link") && method === "POST") {
      return new Response(JSON.stringify({
        success: true,
        data: { case: { name: "app", path: "C:/workspaces/app" } },
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ success: false, error: "unexpected" }), { status: 500 });
  };
  const adapter = new CodemanHttpAdapter({
    instance: {
      ...instance,
      workspaces: [{
        id: "workspace-app",
        name: "app",
        canonicalPath: "C:/workspaces/app",
        health: "ready",
        providers: { codeman: "ready" },
      }],
    },
    fetchImpl,
  });
  await adapter.ensureNativeCases();
  assert.equal(calls.some((call) => call.url.endsWith("/api/cases") && call.method === "GET"), true);
  const link = calls.find((call) => call.url.endsWith("/api/cases/link"));
  assert.ok(link);
  assert.deepEqual(JSON.parse(link!.body ?? "{}"), {
    name: "app",
    path: "C:/workspaces/app",
  });
});

test("CodemanHttpAdapter proxies the native Codeman UI without forwarding Hub cookies", async () => {
  let upstreamAuthorization = "";
  let upstreamCookie: string | undefined;
  const upstream = createServer((request, response) => {
    upstreamAuthorization = request.headers.authorization ?? "";
    upstreamCookie = request.headers.cookie;
    response.writeHead(200, { "content-type": "text/html", "content-length": "33" });
    response.end("<html><body>Codeman</body></html>");
  });
  await listenServer(upstream);
  const upstreamAddress = upstream.address();
  if (!upstreamAddress || typeof upstreamAddress === "string") throw new Error("Upstream did not bind");

  const adapter = new CodemanHttpAdapter({
    instance: {
      ...instance,
      endpoint: `http://127.0.0.1:${upstreamAddress.port}`,
    },
    username: "admin",
    password: "secret",
  });
  const gateway = createServer((request, response) => {
    void adapter.proxyHttp!(request, response);
  });
  await listenServer(gateway);
  const gatewayAddress = gateway.address();
  if (!gatewayAddress || typeof gatewayAddress === "string") throw new Error("Gateway did not bind");

  try {
    const response = await fetch(`http://127.0.0.1:${gatewayAddress.port}/`);
    const html = await response.text();
    assert.equal(response.status, 200);
    assert.match(html, /fleet-host-switcher\.js/);
    assert.match(upstreamAuthorization, /^Basic /);
    assert.equal(upstreamCookie, undefined);
    assert.equal(response.headers.get("content-length"), null);
  } finally {
    await closeServer(gateway);
    await closeServer(upstream);
  }
});

test("CodemanHttpAdapter rejects non-TLS remote endpoints", () => {
  assert.throws(
    () => new CodemanHttpAdapter({
      instance: { ...instance, endpoint: "http://codeman.example.ts.net" },
    }),
    /Invalid Codeman instance/,
  );
});

async function listenServer(server: ReturnType<typeof createServer>): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => resolve());
    server.once("error", reject);
  });
}

async function closeServer(server: ReturnType<typeof createServer>): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

test("CodemanConnectorAdapter uses allowlisted operations and forwards events", async () => {
  const connectorInstance: CodemanInstance = {
    ...instance,
    connectionMode: "connector",
    nodeId: "worker-1",
    endpoint: null,
  };
  const operations: string[] = [];
  let emit: ((event: CodemanSessionEvent) => void) | undefined;
  const adapter = new CodemanConnectorAdapter({
    instance: connectorInstance,
    request: async (operation, payload) => {
      operations.push(`${operation}:${JSON.stringify(payload ?? {})}`);
      if (operation === "capabilities") {
        return [{ id: "claude", mode: "claude", available: true }];
      }
      if (operation === "sessions.list") {
        return [{ id: "session-1", workingDir: workspace.canonicalPath, mode: "claude" }];
      }
      return { id: "session-1", workingDir: workspace.canonicalPath, mode: "claude" };
    },
    subscribeEvents: (listener) => {
      emit = listener;
      return () => {
        emit = undefined;
      };
    },
  });
  const events: unknown[] = [];
  const unsubscribe = adapter.subscribeEvents((event) => events.push(event));
  const capabilities = await adapter.listCapabilities();
  const sessions = await adapter.listSessions();
  await adapter.createSession(
    { ...workspace, id: workspace.canonicalPath, canonicalPath: "/workspaces/new-project" },
    capabilities[0]!,
  );
  await adapter.sendInput("session-1", "hello");
  unsubscribe();

  assert.equal(capabilities[0]?.id, "claude");
  assert.equal(sessions[0]?.instanceId, connectorInstance.id);
  assert.deepEqual(operations.map((operation) => operation.split(":")[0]), [
    "capabilities",
    "sessions.list",
    "sessions.create",
    "sessions.input",
  ]);
  const createPayload = JSON.parse(
    operations.find((operation) => operation.startsWith("sessions.create:"))!.slice("sessions.create:".length),
  );
  assert.equal(createPayload.workspacePath, "/workspaces/new-project");
  assert.equal(createPayload.workspaceId, undefined);
  assert.equal(emit, undefined);
});
