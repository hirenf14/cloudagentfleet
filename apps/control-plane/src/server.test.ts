import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { CodemanHub } from "./hub.ts";
import { createControllerServer } from "./server.ts";
import type { CodemanInstanceAdapter } from "../../../packages/codeman-bridge/src/index.ts";
import type {
  CodemanAgentProfile,
  CodemanInstance,
  CodemanSession,
  CodemanSessionEvent,
  CodemanStatus,
  ControlMessage,
  NodeRegistration,
  WorkspaceDescriptor,
} from "../../../packages/protocol/src/index.ts";

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

test("serves the single-origin dashboard assets without exposing provider endpoints", async () => {
  const app = createControllerServer({ statePath: "" });
  const baseUrl = await listen(app);

  try {
    const page = await fetch(`${baseUrl}/`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get("content-type") ?? "", /^text\/html/);
    assert.match(await page.text(), /Codeman Fleet/);

    const script = await fetch(`${baseUrl}/app.js`);
    assert.equal(script.status, 200);
    assert.match(script.headers.get("content-type") ?? "", /^application\/javascript/);
    assert.match(await script.text(), /\/api\/events/);

    const traversal = await fetch(`${baseUrl}/%2e%2e%2fpackage.json`);
    assert.equal(traversal.status, 404);
  } finally {
    await new Promise<void>((resolve, reject) => {
      app.server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});

test("enrolls, assigns, cancels, audits, and revokes a Worker", async () => {
  const app = createControllerServer({ statePath: "" });
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

    const completedJobResponse = await fetch(`${baseUrl}/api/jobs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        provider: "codeman",
        nodeId: registration.nodeId,
        workspaceId: "workspace-app",
        prompt: "Report completion through the Worker transport",
        idempotencyKey: "smoke-test-2",
      }),
    });
    const completedJob = await json(completedJobResponse);
    for (const message of [
      {
        type: "job.accept",
        jobId: completedJob.job.id,
        idempotencyKey: "smoke-test-2",
      },
      {
        type: "job.event",
        jobId: completedJob.job.id,
        event: "completed",
        data: "done",
      },
    ]) {
      const messageResponse = await fetch(
        `${baseUrl}/api/workers/${registration.nodeId}/messages`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(message),
        },
      );
      assert.equal(messageResponse.status, 202);
    }
    const completedState = await json(
      await fetch(`${baseUrl}/api/jobs/${completedJob.job.id}`),
    );
    assert.equal(completedState.job.status, "completed");

    const auditResponse = await fetch(`${baseUrl}/api/audit`);
    const audit = await json(auditResponse);
    assert.deepEqual(
      audit.events.map((event: { type: string }) => event.type),
      [
        "node.enrolled",
        "node.heartbeat",
        "job.created",
        "job.cancelled",
        "job.created",
        "job.completed",
      ],
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

test("routes the Hub instance, workspace, and session APIs", async () => {
  const workspace: WorkspaceDescriptor = {
    id: "workspace-codeman",
    name: "Codeman workspace",
    canonicalPath: "/workspaces/codeman",
    health: "ready",
    providers: { codeman: "ready" },
  };
  const agent: CodemanAgentProfile = {
    id: "claude",
    name: "Claude Code",
    mode: "claude",
    ready: true,
  };
  const sessions: CodemanSession[] = [];
  const hub = new CodemanHub({
    adapterFactory: (instance: CodemanInstance) => {
      const createdAdapter: CodemanInstanceAdapter = {
        instance,
        getStatus: async (): Promise<CodemanStatus> => ({ version: "test" }),
        listCapabilities: async () => [agent],
        listWorkspaces: async () => [workspace],
        listWorkspacePathSuggestions: async () => [{ path: workspace.canonicalPath, name: workspace.name }],
        listSessions: async () => sessions,
        createSession: async (
          selectedWorkspace,
          selectedAgent,
          title = "session",
        ) => {
          const now = new Date().toISOString();
          const session: CodemanSession = {
            id: "session-route",
            instanceId: instance.id,
            workspaceId: selectedWorkspace.id,
            agent: selectedAgent,
            title,
            status: "starting",
            terminalBuffer: "",
            needsInput: false,
            previewAvailable: false,
            browserAvailable: false,
            createdAt: now,
            lastEventAt: now,
          };
          sessions.push(session);
          return session;
        },
        sendInput: async () => undefined,
        resize: async () => undefined,
        stopSession: async () => undefined,
        subscribeEvents: (_listener: (event: CodemanSessionEvent) => void) => () => undefined,
      };
      return createdAdapter;
    },
  });
  const app = createControllerServer({ hub, statePath: "" });
  const baseUrl = await listen(app);

  try {
    const registered = await fetch(`${baseUrl}/api/instances`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "codeman-route",
        label: "Route test",
        connectionMode: "tailscale-url",
        endpoint: "https://codeman-route.tailnet.ts.net",
        agents: [agent],
        workspaces: [workspace],
      }),
    });
    assert.equal(registered.status, 201);

    const detail = await json(
      await fetch(`${baseUrl}/api/instances/codeman-route`),
    );
    assert.equal(detail.instance.id, "codeman-route");

    const workspaces = await json(
      await fetch(`${baseUrl}/api/instances/codeman-route/workspaces`),
    );
    assert.equal(workspaces.workspaces[0].id, workspace.id);

    const suggestions = await json(
      await fetch(`${baseUrl}/api/instances/codeman-route/workspaces/suggestions?path=%2Fworkspaces%2Fc`),
    );
    assert.deepEqual(suggestions.suggestions, [{
      path: workspace.canonicalPath,
      name: workspace.name,
    }]);

    const created = await json(
      await fetch(`${baseUrl}/api/instances/codeman-route/sessions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workspaceId: workspace.id, agentId: agent.id }),
      }),
    );
    assert.equal(created.session.instanceId, "codeman-route");

    const listed = await json(
      await fetch(`${baseUrl}/api/instances/codeman-route/sessions`),
    );
    assert.equal(listed.sessions[0].id, "session-route");

    const stopped = await fetch(
      `${baseUrl}/api/instances/codeman-route/sessions/session-route/stop`,
      { method: "POST" },
    );
    assert.equal(stopped.status, 202);
    const removed = await fetch(
      `${baseUrl}/api/instances/codeman-route/sessions/session-route`,
      { method: "DELETE" },
    );
    assert.equal(removed.status, 204);
    const afterRemoval = await json(
      await fetch(`${baseUrl}/api/sessions`),
    );
    assert.equal(afterRemoval.sessions.length, 0);
  } finally {
    await new Promise<void>((resolve, reject) => {
      app.server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});

test("routes connector RPCs through the enrolled Worker and forwards session events", async () => {
  const app = createControllerServer({ statePath: "" });
  const baseUrl = await listen(app);
  let connectorRequest: ControlMessage | undefined;
  const received: CodemanSessionEvent[] = [];
  const unsubscribe = app.hub.subscribeEvents((event) => received.push(event));
  app.controlPlane.enrollNode(registration);
  app.controlPlane.registerConnection({
    node: app.controlPlane.nodes.list()[0]!,
    send: async (message) => {
      connectorRequest = message;
    },
    close: async () => undefined,
  });

  try {
    const registered = await fetch(`${baseUrl}/api/instances`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "codeman-connector",
        label: "Connector",
        connectionMode: "connector",
        nodeId: registration.nodeId,
        agents: [],
        workspaces: registration.workspaces,
      }),
    });
    assert.equal(registered.status, 201);

    const capabilitiesPromise = fetch(
      `${baseUrl}/api/instances/codeman-connector/capabilities`,
    );
    for (let attempt = 0; attempt < 10 && !connectorRequest; attempt += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    assert.equal(connectorRequest?.type, "codeman.request");
    if (connectorRequest?.type !== "codeman.request") throw new Error("Connector request missing");
    assert.equal(connectorRequest.instanceId, "codeman-connector");
    assert.equal(connectorRequest.operation, "capabilities");
    app.controlPlane.receiveNodeMessage(registration.nodeId, {
      type: "codeman.response",
      requestId: connectorRequest.requestId,
      instanceId: "codeman-connector",
      success: true,
      data: [{ id: "claude", mode: "claude", available: true }],
    });
    const capabilities = await json(await capabilitiesPromise);
    assert.equal(capabilities.agents[0].id, "claude");

    const event: CodemanSessionEvent = {
      instanceId: "codeman-connector",
      sessionId: "session-connector",
      event: "output",
      data: "hello",
      createdAt: new Date().toISOString(),
    };
    app.controlPlane.receiveNodeMessage(registration.nodeId, {
      type: "codeman.session.event",
      instanceId: "codeman-connector",
      event,
    });
    assert.deepEqual(received, [event]);
  } finally {
    unsubscribe();
    await new Promise<void>((resolve, reject) => {
      app.server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});

test("protects the Hub UI with a password session and same-origin state changes", async () => {
  const app = createControllerServer({
    statePath: "",
    uiPassword: "correct horse battery staple",
    uiCookieSecure: false,
  });
  const baseUrl = await listen(app);

  try {
    const unauthenticated = await fetch(`${baseUrl}/api/auth/session`);
    assert.deepEqual(await json(unauthenticated), {
      enabled: true,
      authenticated: false,
    });

    const rejected = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: "wrong" }),
    });
    assert.equal(rejected.status, 401);

    const login = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: "correct horse battery staple" }),
    });
    assert.equal(login.status, 200);
    const setCookie = login.headers.get("set-cookie") ?? "";
    const sessionCookie = cookieValue(setCookie, "hosted_agents_session");
    const csrfCookie = cookieValue(setCookie, "hosted_agents_csrf");
    assert.ok(sessionCookie);
    assert.ok(csrfCookie);
    const cookie = `hosted_agents_session=${sessionCookie}; hosted_agents_csrf=${csrfCookie}`;

    const page = await fetch(`${baseUrl}/`, {
      headers: { cookie },
    });
    assert.equal(page.status, 200);
    assert.match(await page.text(), /Codeman Fleet/);

    const blocked = await fetch(`${baseUrl}/api/instances`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(blocked.status, 403);

    const logout = await fetch(`${baseUrl}/api/auth/logout`, {
      method: "POST",
      headers: { cookie, "x-csrf-token": csrfCookie },
    });
    assert.equal(logout.status, 204);

    const afterLogout = await fetch(`${baseUrl}/api/auth/session`, {
      headers: { cookie },
    });
    assert.deepEqual(await json(afterLogout), {
      enabled: true,
      authenticated: false,
    });
  } finally {
    await new Promise<void>((resolve, reject) => {
      app.server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});

test("clears the selected Codeman host and returns to the Hub dashboard", async () => {
  const app = createControllerServer({ statePath: "" });
  const baseUrl = await listen(app);

  try {
    const cleared = await fetch(`${baseUrl}/api/fleet/clear`, { redirect: "manual" });
    assert.equal(cleared.status, 303);
    assert.match(cleared.headers.get("location") ?? "", /\/$/);
    assert.match(
      cleared.headers.get("set-cookie") ?? "",
      /hosted_agents_codeman_instance=;/,
    );
  } finally {
    await new Promise<void>((resolve, reject) => {
      app.server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});

test("selects a Tailscale Codeman host for the native UI proxy", async () => {
  const app = createControllerServer({ statePath: "" });
  const baseUrl = await listen(app);

  try {
    const registration = await fetch(`${baseUrl}/api/instances`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "codeman-tailnet",
        label: "Tailnet Codeman",
        connectionMode: "tailscale-url",
        endpoint: "https://codeman-tailnet.example.ts.net",
      }),
    });
    assert.equal(registration.status, 201);

    const selected = await fetch(
      `${baseUrl}/api/fleet/select/codeman-tailnet`,
      { redirect: "manual" },
    );
    assert.equal(selected.status, 303);
    assert.match(selected.headers.get("location") ?? "", /\/$/);
    assert.match(
      selected.headers.get("set-cookie") ?? "",
      /hosted_agents_codeman_instance=codeman-tailnet/,
    );
  } finally {
    await new Promise<void>((resolve, reject) => {
      app.server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});

test("proxies the selected host's native HTML through the single Hub origin", async () => {
  let upstreamCookie: string | undefined;
  const upstream = createServer((request, response) => {
    upstreamCookie = request.headers.cookie;
    response.writeHead(200, { "content-type": "text/html" });
    response.end("<html><body>Native Codeman</body></html>");
  });
  await listenHttp(upstream);
  const upstreamAddress = upstream.address();
  if (!upstreamAddress || typeof upstreamAddress === "string") throw new Error("Upstream did not bind");

  const app = createControllerServer({ statePath: "" });
  const baseUrl = await listen(app);
  try {
    const registered = await fetch(`${baseUrl}/api/instances`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "codeman-proxy",
        label: "Proxy test",
        connectionMode: "tailscale-url",
        endpoint: `http://127.0.0.1:${upstreamAddress.port}`,
      }),
    });
    assert.equal(registered.status, 201);
    const selected = await fetch(`${baseUrl}/api/fleet/select/codeman-proxy`, {
      redirect: "manual",
    });
    const cookie = cookieValue(
      selected.headers.get("set-cookie") ?? "",
      "hosted_agents_codeman_instance",
    );
    const page = await fetch(`${baseUrl}/`, {
      headers: { cookie: `hosted_agents_codeman_instance=${cookie}` },
    });
    assert.equal(page.status, 200);
    assert.match(await page.text(), /fleet-host-switcher\.js/);
    assert.equal(upstreamCookie, undefined);
  } finally {
    await new Promise<void>((resolve, reject) => {
      app.server.close((error) => (error ? reject(error) : resolve()));
    });
    await closeHttp(upstream);
  }
});

function cookieValue(header: string, name: string): string {
  const match = header.match(new RegExp(`${name}=([^;]+)`));
  return match?.[1] ?? "";
}

async function listenHttp(server: ReturnType<typeof createServer>): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.listen(0, "127.0.0.1", resolve);
    server.once("error", reject);
  });
}

async function closeHttp(server: ReturnType<typeof createServer>): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}
