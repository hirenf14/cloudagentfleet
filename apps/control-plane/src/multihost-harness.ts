import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { CodemanHub } from "./hub.ts";
import { createControllerServer } from "./server.ts";
import type {
  CodemanAgentProfile,
  CodemanInstanceRegistration,
  CodemanSessionEvent,
  WorkspaceDescriptor,
} from "../../../packages/protocol/src/index.ts";

type JsonRecord = Record<string, unknown>;

const agent: CodemanAgentProfile = {
  id: "claude",
  name: "Claude Code",
  mode: "claude",
  ready: true,
};

interface HarnessSession {
  id: string;
  name: string;
  workingDir: string;
  mode: string;
  status: "running" | "stopped";
  createdAt: string;
}

/**
 * A local Codeman-shaped HTTP/SSE server. It is intentionally isolated from
 * provider credentials and never starts a shell or agent process.
 */
class MockCodeman {
  readonly server: Server;
  readonly sessions = new Map<string, HarnessSession>();
  readonly eventResponses = new Set<ServerResponse>();
  readonly id: string;
  private sequence = 0;

  constructor(id: string) {
    this.id = id;
    this.server = createServer((request, response) => {
      void this.route(request, response);
    });
  }

  async listen(): Promise<string> {
    await listen(this.server);
    const address = this.server.address();
    assert.ok(address && typeof address !== "string");
    return `http://127.0.0.1:${(address as AddressInfo).port}`;
  }

  async close(): Promise<void> {
    for (const response of this.eventResponses) response.destroy();
    this.eventResponses.clear();
    await new Promise<void>((resolve, reject) => {
      this.server.close((error) => (error ? reject(error) : resolve()));
    });
  }

  private async route(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      const url = new URL(request.url ?? "/", "http://mock-codeman.local");
      if (request.method === "GET" && url.pathname === "/api/v1/status") {
        sendJson(response, 200, {
          success: true,
          data: {
            version: "mock-codeman-1.0.0",
            agents: [agent],
            sessions: this.sessions.size,
          },
        });
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/v1/events") {
        response.writeHead(200, {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache, no-store",
          connection: "keep-alive",
        });
        response.write(": mock Codeman event stream\n\n");
        this.eventResponses.add(response);
        request.on("close", () => this.eventResponses.delete(response));
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/v1/sessions") {
        sendJson(response, 200, {
          success: true,
          data: { sessions: [...this.sessions.values()] },
        });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/v1/sessions") {
        const body = await readJson(request);
        const session: HarnessSession = {
          id: `${this.id}-session-${++this.sequence}`,
          name: String(body.name ?? `${this.id} session`),
          workingDir: String(body.workingDir ?? ""),
          mode: String(body.mode ?? "claude"),
          status: "running",
          createdAt: new Date().toISOString(),
        };
        this.sessions.set(session.id, session);
        sendJson(response, 201, { success: true, data: { session } });
        return;
      }

      const sessionMatch = url.pathname.match(/^\/api\/v1\/sessions\/([^/]+)$/);
      if (sessionMatch && request.method === "DELETE") {
        const session = this.sessions.get(decodeURIComponent(sessionMatch[1]!));
        if (!session) {
          sendJson(response, 404, { success: false, error: "Session not found" });
          return;
        }
        session.status = "stopped";
        sendJson(response, 200, { success: true, data: {} });
        return;
      }

      const interactiveMatch = url.pathname.match(
        /^\/api\/v1\/sessions\/([^/]+)\/interactive$/,
      );
      if (interactiveMatch && request.method === "POST") {
        sendJson(response, 200, { success: true, data: {} });
        return;
      }

      const inputMatch = url.pathname.match(/^\/api\/v1\/sessions\/([^/]+)\/input$/);
      if (inputMatch && request.method === "POST") {
        const sessionId = decodeURIComponent(inputMatch[1]!);
        const session = this.sessions.get(sessionId);
        if (!session) {
          sendJson(response, 404, { success: false, error: "Session not found" });
          return;
        }
        const body = await readJson(request);
        const input = String(body.input ?? "").replace(/\r$/, "");
        this.emit(sessionId, "output", `${this.id} received: ${input}`);
        sendJson(response, 200, { success: true, data: { delivered: true } });
        return;
      }

      sendJson(response, 404, { success: false, error: "Not found" });
    } catch (error) {
      sendJson(response, 400, {
        success: false,
        error: error instanceof Error ? error.message : "Mock request failed",
      });
    }
  }

  private emit(sessionId: string, type: string, data: string): void {
    const payload = JSON.stringify({
      type,
      session_id: sessionId,
      data,
      createdAt: new Date().toISOString(),
    });
    for (const response of this.eventResponses) {
      if (!response.writableEnded) response.write(`event: ${type}\ndata: ${payload}\n\n`);
    }
  }
}

async function runMock(): Promise<void> {
  const mockA = new MockCodeman("mock-a");
  const mockB = new MockCodeman("mock-b");
  const endpointA = await mockA.listen();
  const endpointB = await mockB.listen();
  const workspaceA = workspace("workspace-a", "/mock/workspace-a");
  const workspaceB = workspace("workspace-b", "/mock/workspace-b");
  const hub = new CodemanHub({ statePath: "" });
  const controller = createController(hub);
  const controllerUrl = await listen(controller.server);
  const registrations = [
    registration("codeman-a", "Mock Codeman A", endpointA, workspaceA),
    registration("codeman-b", "Mock Codeman B", endpointB, workspaceB),
  ];

  try {
    await enrollAndHealth(controllerUrl, registrations);
    const instances = await getJson(controllerUrl, "/api/instances");
    assert.deepEqual(
      (instances.instances as JsonRecord[]).map((instance) => instance.id),
      ["codeman-a", "codeman-b"],
    );
    assert.ok(
      (instances.instances as JsonRecord[]).every((instance) => instance.status === "online"),
    );

    await waitFor(() => mockA.eventResponses.size === 1 && mockB.eventResponses.size === 1);
    const observed: CodemanSessionEvent[] = [];
    const unsubscribe = hub.subscribeEvents((event) => observed.push(event));
    try {
      const sessionA = await createSession(controllerUrl, "codeman-a", workspaceA);
      const sessionB = await createSession(controllerUrl, "codeman-b", workspaceB);
      await sendInput(controllerUrl, "codeman-a", sessionA.id, "hello-a");
      await sendInput(controllerUrl, "codeman-b", sessionB.id, "hello-b");
      await waitFor(() =>
        observed.some((event) => event.instanceId === "codeman-a" && event.data?.includes("hello-a"))
        && observed.some((event) => event.instanceId === "codeman-b" && event.data?.includes("hello-b")),
      );

      const sessions = await getJson(controllerUrl, "/api/sessions");
      const sessionList = sessions.sessions as JsonRecord[];
      assert.deepEqual(
        sessionList.map((session) => `${session.instanceId}/${session.id}`),
        [`codeman-a/${sessionA.id}`, `codeman-b/${sessionB.id}`],
      );
      const hubSessionA = sessionList.find((session) => session.instanceId === "codeman-a");
      const hubSessionB = sessionList.find((session) => session.instanceId === "codeman-b");
      assert.ok(String(hubSessionA?.terminalBuffer ?? "").includes("hello-a"));
      assert.ok(String(hubSessionB?.terminalBuffer ?? "").includes("hello-b"));

      await stopSession(controllerUrl, "codeman-a", sessionA.id);
      await stopSession(controllerUrl, "codeman-b", sessionB.id);
      const stoppedA = await getJson(controllerUrl, "/api/instances/codeman-a/sessions");
      const stoppedB = await getJson(controllerUrl, "/api/instances/codeman-b/sessions");
      assert.equal((stoppedA.sessions as JsonRecord[])[0]?.status, "stopped");
      assert.equal((stoppedB.sessions as JsonRecord[])[0]?.status, "stopped");
      assert.ok(observed.some((event) => event.instanceId === "codeman-a" && event.event === "output"));
      assert.ok(observed.some((event) => event.instanceId === "codeman-b" && event.event === "output"));
    } finally {
      unsubscribe();
    }

    console.log("[mock] one Hub URL listed both isolated Codeman instances");
    console.log("[mock] created, input, output-event, and stopped sessions on both hosts");
  } finally {
    await close(controller);
    await Promise.all([mockA.close(), mockB.close()]);
  }
}

async function runLive(): Promise<void> {
  const endpointA = required("CODEMAN_URL_A");
  const endpointB = required("CODEMAN_URL_B");
  const workspaceA = workspace("workspace-a", required("CODEMAN_WORKSPACE_A"));
  const workspaceB = workspace("workspace-b", required("CODEMAN_WORKSPACE_B"));
  const credentialsByInstance: Record<string, { username: string; password: string }> = {};
  const credentialsA = credentials("A");
  const credentialsB = credentials("B");
  if (credentialsA) credentialsByInstance["codeman-a"] = credentialsA;
  if (credentialsB) credentialsByInstance["codeman-b"] = credentialsB;
  const hub = new CodemanHub({
    statePath: "",
    credentials: credentialsByInstance,
  });
  const controller = createController(hub);
  const controllerUrl = await listen(controller.server);
  const registrations = [
    registration("codeman-a", "Live Codeman A", endpointA, workspaceA),
    registration("codeman-b", "Live Codeman B", endpointB, workspaceB),
  ];

  try {
    await enrollAndHealth(controllerUrl, registrations);
    const instances = await getJson(controllerUrl, "/api/instances");
    assert.deepEqual(
      (instances.instances as JsonRecord[]).map((instance) => instance.id),
      ["codeman-a", "codeman-b"],
    );
    console.log(`[live] Hub ${controllerUrl} listed both configured Codeman URLs`);

    const observed: CodemanSessionEvent[] = [];
    const unsubscribe = hub.subscribeEvents((event) => observed.push(event));
    try {
      const sessionA = await createSession(controllerUrl, "codeman-a", workspaceA);
      const sessionB = await createSession(controllerUrl, "codeman-b", workspaceB);
      await sendInput(controllerUrl, "codeman-a", sessionA.id, "hosted-agents-live-a");
      await sendInput(controllerUrl, "codeman-b", sessionB.id, "hosted-agents-live-b");
      await waitFor(() =>
        observed.some((event) => event.instanceId === "codeman-a" && event.event === "output")
        && observed.some((event) => event.instanceId === "codeman-b" && event.event === "output"),
        15_000,
      );
      await stopSession(controllerUrl, "codeman-a", sessionA.id);
      await stopSession(controllerUrl, "codeman-b", sessionB.id);
      console.log("[live] created, input, output-event, and stopped sessions on both hosts");
    } finally {
      unsubscribe();
    }
  } finally {
    await close(controller);
  }
}

function createController(hub: CodemanHub) {
  return createControllerServer({ host: "127.0.0.1", port: 0, hub, statePath: "" });
}

function registration(
  id: string,
  label: string,
  endpoint: string,
  selectedWorkspace: WorkspaceDescriptor,
): CodemanInstanceRegistration {
  return {
    id,
    label,
    connectionMode: "tailscale-url",
    endpoint,
    capabilities: ["codeman"],
    agents: [agent],
    workspaces: [selectedWorkspace],
  };
}

function workspace(id: string, canonicalPath: string): WorkspaceDescriptor {
  return {
    id,
    name: id,
    canonicalPath,
    health: "ready",
    providers: { codeman: "ready" },
  };
}

async function enrollAndHealth(
  controllerUrl: string,
  registrations: CodemanInstanceRegistration[],
): Promise<void> {
  for (const registration of registrations) {
    const created = await requestJson(controllerUrl, "/api/instances", {
      method: "POST",
      body: registration,
    });
    assert.equal(created.status, 201);
    const health = await requestJson(
      controllerUrl,
      `/api/instances/${encodeURIComponent(registration.id)}/health`,
      { method: "POST" },
    );
    assert.equal(health.status, 200);
    assert.equal((health.body.instance as JsonRecord).status, "online");
  }
}

async function createSession(
  controllerUrl: string,
  instanceId: string,
  selectedWorkspace: WorkspaceDescriptor,
): Promise<{ id: string }> {
  const result = await requestJson(
    controllerUrl,
    `/api/instances/${encodeURIComponent(instanceId)}/sessions`,
    {
      method: "POST",
      body: { workspaceId: selectedWorkspace.id, agentId: agent.id },
    },
  );
  assert.equal(result.status, 201);
  return result.body.session as { id: string };
}

async function sendInput(
  controllerUrl: string,
  instanceId: string,
  sessionId: string,
  input: string,
): Promise<void> {
  const result = await requestJson(
    controllerUrl,
    `/api/instances/${encodeURIComponent(instanceId)}/sessions/${encodeURIComponent(sessionId)}/input`,
    { method: "POST", body: { input } },
  );
  assert.equal(result.status, 202);
}

async function stopSession(
  controllerUrl: string,
  instanceId: string,
  sessionId: string,
): Promise<void> {
  const result = await requestJson(
    controllerUrl,
    `/api/instances/${encodeURIComponent(instanceId)}/sessions/${encodeURIComponent(sessionId)}/stop`,
    { method: "POST" },
  );
  assert.equal(result.status, 202);
}

async function getJson(controllerUrl: string, path: string): Promise<JsonRecord> {
  const result = await requestJson(controllerUrl, path, {});
  assert.equal(result.status, 200);
  return result.body;
}

async function requestJson(
  controllerUrl: string,
  path: string,
  options: { method?: string; body?: unknown },
): Promise<{ status: number; body: JsonRecord }> {
  const response = await fetch(`${controllerUrl}${path}`, {
    method: options.method ?? "GET",
    headers: options.body === undefined ? undefined : { "content-type": "application/json" },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) as JsonRecord : {} };
}

async function readJson(request: IncomingMessage): Promise<JsonRecord> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as JsonRecord;
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(body));
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return `http://127.0.0.1:${address.port}`;
}

async function close(controller: ReturnType<typeof createControllerServer>): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    controller.server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for the multi-host event");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(
      `${name} is required for live mode. Set both Codeman HTTPS URLs and workspace paths; `
      + "credentials remain optional unless Codeman Basic auth is enabled.",
    );
  }
  return value;
}

function credentials(suffix: string): { username: string; password: string } | undefined {
  const username = process.env[`CODEMAN_USERNAME_${suffix}`]?.trim();
  const password = process.env[`CODEMAN_PASSWORD_${suffix}`];
  if (!username && password === undefined) return undefined;
  if (!username || password === undefined) {
    throw new Error(`CODEMAN_USERNAME_${suffix} and CODEMAN_PASSWORD_${suffix} must be set together`);
  }
  return { username, password };
}

if (process.argv[1]?.endsWith("multihost-harness.ts")) {
  const mode = process.argv[2];
  const run = mode === "--mock" ? runMock : mode === "--live" ? runLive : undefined;
  if (!run) {
    console.error("Usage: node --experimental-strip-types src/multihost-harness.ts --mock|--live");
    process.exitCode = 2;
  } else {
    run().catch((error) => {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
    });
  }
}
