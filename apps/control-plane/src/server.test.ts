import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { FleetHub } from "./hub.ts";
import { createControllerServer, defaultHubStatePath } from "./server.ts";
import type { HostAdapter } from "../../../packages/host-adapters/src/index.ts";
import type {
  AgentProfile,
  HostInstance,
  HostSession,
  HostSessionEvent,
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
    assert.match(await page.text(), /Cloud Agent Fleet/);

    const script = await fetch(`${baseUrl}/app.js`);
    assert.equal(script.status, 200);
    assert.match(script.headers.get("content-type") ?? "", /^application\/javascript/);
    assert.match(await script.text(), /\/api\/events/);

    const traversal = await fetch(`${baseUrl}/%2e%2e%2fpackage.json`);
    assert.equal(traversal.status, 404);

    const backends = await fetch(`${baseUrl}/api/backends`);
    assert.equal(backends.status, 200);
    const { backends: summaries } = await backends.json() as {
      backends: Array<{ backend: string; label: string; features: Record<string, string[]> }>;
    };
    assert.equal(summaries[0]?.backend, "codeman");
    assert.equal(summaries[0]?.label, "Codeman");
    assert.ok(summaries[0]?.features.connector?.includes("sessions"));
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
    assert.equal(messages[0]?.type, "job.assign");

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
    assert.equal(messages[1]?.type, "job.cancel");

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
  const agent: AgentProfile = {
    id: "claude",
    name: "Claude Code",
    mode: "claude",
    ready: true,
  };
  const sessions: HostSession[] = [];
  const hub = new FleetHub({
    adapterFactory: (instance: HostInstance) => {
      const createdAdapter: HostAdapter = {
        instance,
        features: ["sessions", "workspace-suggest"],
        listAgents: async () => [agent],
        listWorkspaces: async () => [workspace],
        pathSuggestions: {
          listWorkspacePathSuggestions: async () => [{ path: workspace.canonicalPath, name: workspace.name }],
        },
        subscribeEvents: (_listener: (event: HostSessionEvent) => void) => () => undefined,
        sessionControl: {
          listSessions: async () => sessions,
          createSession: async (
            selectedWorkspace,
            selectedAgent,
            title = "session",
          ) => {
            const now = new Date().toISOString();
            const session: HostSession = {
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
        },
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
  const received: HostSessionEvent[] = [];
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

    const event: HostSessionEvent = {
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
    const sessionCookie = cookieValue(setCookie, "cloudagentfleet_session");
    const csrfCookie = cookieValue(setCookie, "cloudagentfleet_csrf");
    assert.ok(sessionCookie);
    assert.ok(csrfCookie);
    const cookie = `cloudagentfleet_session=${sessionCookie}; cloudagentfleet_csrf=${csrfCookie}`;

    const page = await fetch(`${baseUrl}/`, {
      headers: { cookie },
    });
    assert.equal(page.status, 200);
    assert.match(await page.text(), /Cloud Agent Fleet/);

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
      /cloudagentfleet_instance=;/,
    );
  } finally {
    await new Promise<void>((resolve, reject) => {
      app.server.close((error) => (error ? reject(error) : resolve()));
    });
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

/** Binds the dashboard and host-UI listeners and pins their public origins. */
async function listenBoth(
  app: ReturnType<typeof createControllerServer>,
): Promise<{ baseUrl: string; hostUrl: string; close: () => Promise<void> }> {
  const baseUrl = await listen(app);
  await new Promise<void>((resolve) => app.hostServer.listen(0, "127.0.0.1", resolve));
  const address = app.hostServer.address();
  if (!address || typeof address === "string") throw new Error("Host UI server did not bind");
  const hostUrl = `http://127.0.0.1:${address.port}`;
  app.origins.hubUrl = baseUrl;
  app.origins.hostUrl = hostUrl;
  return {
    baseUrl,
    hostUrl,
    close: async () => {
      await Promise.all([app.server, app.hostServer].map((server) => new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      })));
    },
  };
}

function fakeUpstream(body: string, contentType = "text/html"): {
  server: ReturnType<typeof createServer>;
  requests: Array<{ method?: string; url?: string; cookie?: string }>;
} {
  const requests: Array<{ method?: string; url?: string; cookie?: string }> = [];
  const server = createServer((request, response) => {
    requests.push({ method: request.method, url: request.url, cookie: request.headers.cookie });
    if (request.url === "/api/health") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ status: "ok" }));
      return;
    }
    response.writeHead(200, {
      "content-type": contentType,
      "set-cookie": "cptr_session=jwt; HttpOnly; Path=/; SameSite=lax",
    });
    response.end(body);
  });
  return { server, requests };
}

test("serves host UIs on a separate origin and never on the dashboard origin", async () => {
  const upstream = fakeUpstream("<html><body>Native Codeman</body></html>");
  await listenHttp(upstream.server);
  const app = createControllerServer({ statePath: "" });
  const { baseUrl, hostUrl, close } = await listenBoth(app);
  try {
    const registered = await fetch(`${baseUrl}/_fleet/api/instances`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "codeman-proxy",
        label: "Proxy test",
        connectionMode: "tailscale-url",
        endpoint: `http://127.0.0.1:${(upstream.server.address() as { port: number }).port}`,
      }),
    });
    assert.equal(registered.status, 201);

    // The dashboard hands selection to the host-UI origin.
    const handoff = await fetch(`${baseUrl}/_fleet/api/fleet/select/codeman-proxy`, { redirect: "manual" });
    assert.equal(handoff.status, 303);
    assert.equal(handoff.headers.get("location"), `${hostUrl}/_fleet/select/codeman-proxy`);
    assert.deepEqual(await (await fetch(`${baseUrl}/_fleet/api/fleet/origins`)).json(), { hostUiOrigin: hostUrl });

    const selected = await fetch(`${hostUrl}/_fleet/select/codeman-proxy`, { redirect: "manual" });
    assert.equal(selected.status, 303);
    assert.equal(selected.headers.get("location"), "/");
    const hostCookie = (selected.headers.get("set-cookie") ?? "").split(";")[0]!;
    assert.match(hostCookie, /^cloudagentfleet_instance=codeman-proxy$/);

    const page = await fetch(`${hostUrl}/`, { headers: { cookie: `${hostCookie}; cloudagentfleet_session=x` } });
    assert.match(await page.text(), /\/_fleet\/fleet-host-switcher\.js/);
    assert.equal(upstream.requests.at(-1)?.cookie, undefined, "no cookies reach Codeman");

    // The cookie never turns the dashboard origin into a proxy: the Hub stays reachable.
    const dashboard = await fetch(`${baseUrl}/`, { headers: { cookie: hostCookie }, redirect: "manual" });
    assert.equal(dashboard.headers.get("location"), "/_fleet/");
    const legacy = await fetch(`${baseUrl}/api/instances`, { headers: { cookie: hostCookie } });
    assert.equal(((await legacy.json()) as { instances: unknown[] }).instances.length, 1);

    // The host-UI origin exposes only the switcher, not the Hub API.
    const switcher = await (await fetch(`${hostUrl}/_fleet/api/switcher`, { headers: { cookie: hostCookie } })).json();
    assert.deepEqual(switcher, {
      dashboardUrl: `${baseUrl}/_fleet/`,
      current: "codeman-proxy",
      hosts: [{ id: "codeman-proxy", label: "Proxy test", status: "offline" }],
    });
    assert.equal((await fetch(`${hostUrl}/_fleet/api/instances`, { headers: { cookie: hostCookie } })).status, 404);
  } finally {
    await close();
    await closeHttp(upstream.server);
  }
});

test("proxies cptr hosts on the host-UI origin and keeps link-mode hosts direct", async () => {
  const upstream = fakeUpstream(JSON.stringify({ ok: true }), "application/json");
  await listenHttp(upstream.server);
  const app = createControllerServer({ statePath: "" });
  const { baseUrl, hostUrl, close } = await listenBoth(app);
  const register = (body: Record<string, unknown>) => fetch(`${baseUrl}/_fleet/api/instances`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  try {
    assert.equal((await register({
      id: "laptop-cptr",
      label: "Laptop",
      backend: "cptr",
      connectionMode: "tailscale-url",
      endpoint: `http://127.0.0.1:${(upstream.server.address() as { port: number }).port}`,
    })).status, 201);
    assert.equal((await register({
      id: "desk-cptr",
      label: "Desk",
      backend: "cptr",
      connectionMode: "tailscale-url",
      endpoint: "https://desk.example.ts.net",
      capabilities: ["cptr", "link"],
    })).status, 201);

    const { instances } = await (await fetch(`${baseUrl}/_fleet/api/instances`)).json() as {
      instances: Array<{ id: string; endpoint: unknown; launchUrl?: string; features: string[] }>;
    };
    const laptop = instances.find((instance) => instance.id === "laptop-cptr");
    const desk = instances.find((instance) => instance.id === "desk-cptr");
    assert.deepEqual(laptop?.features, ["native-ui-proxy"]);
    assert.equal(laptop?.endpoint, null);
    assert.equal(laptop?.launchUrl, undefined);
    assert.deepEqual(desk?.features, ["native-ui-link"]);
    assert.equal(desk?.launchUrl, "https://desk.example.ts.net");
    assert.equal((await fetch(`${hostUrl}/_fleet/select/desk-cptr`, { redirect: "manual" })).status, 400);

    const selected = await fetch(`${hostUrl}/_fleet/select/laptop-cptr`, { redirect: "manual" });
    const hostCookie = (selected.headers.get("set-cookie") ?? "").split(";")[0]!;

    // cptr's own /api/auth is reachable on the host-UI origin.
    const proxied = await fetch(`${hostUrl}/api/auth`, {
      headers: { cookie: `${hostCookie}; cloudagentfleet_session=hub-secret; cf_laptop-cptr_cptr_session=old` },
    });
    assert.deepEqual(await proxied.json(), { ok: true });
    assert.match(proxied.headers.get("set-cookie") ?? "", /^cf_laptop-cptr_cptr_session=jwt;/);
    assert.deepEqual(upstream.requests.at(-1), { method: "GET", url: "/api/auth", cookie: "cptr_session=old" });

    // A removed host: the stale selection is cleared instead of breaking the origin.
    assert.equal((await fetch(`${baseUrl}/_fleet/api/instances/laptop-cptr`, { method: "DELETE" })).status, 204);
    const stale = await fetch(`${hostUrl}/`, { headers: { cookie: hostCookie } });
    assert.equal(stale.status, 404);
    assert.match(stale.headers.get("set-cookie") ?? "", /^cloudagentfleet_instance=; Path=\/; Max-Age=0/);
    assert.match(await stale.text(), /Back to the fleet dashboard/);
  } finally {
    await close();
    await closeHttp(upstream.server);
  }
});

test("host UIs cannot drive the Hub API, and the host-UI origin requires a Hub session", async () => {
  const upstream = fakeUpstream(JSON.stringify({ ok: true }), "application/json");
  await listenHttp(upstream.server);
  const app = createControllerServer({
    statePath: "",
    uiPassword: "correct horse battery staple",
    uiCookieSecure: false,
  });
  const { baseUrl, hostUrl, close } = await listenBoth(app);
  try {
    const login = await fetch(`${baseUrl}/_fleet/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: "correct horse battery staple" }),
    });
    const setCookie = login.headers.get("set-cookie") ?? "";
    const csrf = cookieValue(setCookie, "cloudagentfleet_csrf");
    const hubCookies = `cloudagentfleet_session=${cookieValue(setCookie, "cloudagentfleet_session")}; `
      + `cloudagentfleet_csrf=${csrf}`;
    assert.equal((await fetch(`${baseUrl}/_fleet/api/instances`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: hubCookies, origin: baseUrl },
      body: JSON.stringify({
        id: "laptop-cptr",
        label: "Laptop",
        backend: "cptr",
        connectionMode: "tailscale-url",
        endpoint: `http://127.0.0.1:${(upstream.server.address() as { port: number }).port}`,
      }),
    })).status, 201);
    const cookie = `${hubCookies}; cloudagentfleet_instance=laptop-cptr`;

    // A script running in a host UI (host-UI origin) cannot mutate the Hub,
    // even with the readable CSRF cookie value.
    const fromHostUi = await fetch(`${baseUrl}/_fleet/api/instances/laptop-cptr`, {
      method: "DELETE",
      headers: { cookie, origin: hostUrl, "x-csrf-token": csrf },
    });
    assert.equal(fromHostUi.status, 403);

    // The host-UI origin itself needs the Hub session and its own origin.
    const anonymous = await fetch(`${hostUrl}/api/chats`, { headers: { cookie: "cloudagentfleet_instance=laptop-cptr" } });
    assert.equal(anonymous.status, 401);
    assert.doesNotMatch(await anonymous.text(), /"ok"/);
    const crossSite = await fetch(`${hostUrl}/api/chats`, {
      method: "POST",
      headers: { cookie, origin: "https://evil.example" },
      body: "{}",
    });
    assert.equal(crossSite.status, 403);
    const sameOrigin = await fetch(`${hostUrl}/api/chats`, {
      method: "POST",
      headers: { cookie, origin: hostUrl },
      body: "{}",
    });
    assert.deepEqual(await sameOrigin.json(), { ok: true });

    const logout = await fetch(`${baseUrl}/_fleet/api/auth/logout`, {
      method: "POST",
      headers: { cookie, origin: baseUrl },
    });
    assert.match(logout.headers.get("set-cookie") ?? "", /cf_laptop-cptr_cptr_session=; Path=\/; Max-Age=0/);
  } finally {
    await close();
    await closeHttp(upstream.server);
  }
});

test("a durable Hub generates a Worker token and requires it", async () => {
  const directory = mkdtempSync(join(tmpdir(), "cloudagentfleet-token-"));
  const statePath = join(directory, "hub.json");
  try {
    const first = createControllerServer({ statePath, uiPassword: "correct horse battery staple" });
    assert.ok(first.workerTokenPath, "the Hub reports where it stored the token");
    const token = readFileSync(first.workerTokenPath!, "utf8").trim();
    assert.ok(token.length >= 32);
    const baseUrl = await listen(first);
    const registration = {
      nodeId: "worker-1",
      name: "Worker",
      platform: "linux",
      capabilities: ["codeman"],
    };
    const anonymous = await fetch(`${baseUrl}/api/workers`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(registration),
    });
    assert.equal(anonymous.status, 401);
    const enrolled = await fetch(`${baseUrl}/api/workers`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify(registration),
    });
    assert.equal(enrolled.status, 201);
    await new Promise<void>((resolve) => first.server.close(() => resolve()));

    const second = createControllerServer({ statePath, uiPassword: "correct horse battery staple" });
    assert.equal(readFileSync(second.workerTokenPath!, "utf8").trim(), token, "the token survives a restart");
    const configured = createControllerServer({ statePath, authToken: "explicit-token" });
    assert.equal(configured.workerTokenPath, undefined, "a configured token is used as is");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("only the dashboard may frame a host UI, and nothing may frame the dashboard", async () => {
  const upstream = createServer((request, response) => {
    if (request.url === "/api/health") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ status: "ok" }));
      return;
    }
    response.writeHead(200, {
      "content-type": "text/html",
      "x-frame-options": "DENY",
      "content-security-policy": "default-src 'self'; frame-ancestors 'none'",
    });
    response.end("<html></html>");
  });
  await listenHttp(upstream);
  const app = createControllerServer({ statePath: "", uiPassword: "correct horse battery staple", uiCookieSecure: false });
  const { baseUrl, hostUrl, close } = await listenBoth(app);
  try {
    const dashboard = await fetch(`${baseUrl}/_fleet/`);
    assert.equal(dashboard.headers.get("content-security-policy"), "frame-ancestors 'none'");
    assert.equal(dashboard.headers.get("x-frame-options"), "DENY");

    const login = await fetch(`${baseUrl}/_fleet/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: "correct horse battery staple" }),
    });
    const setCookie = login.headers.get("set-cookie") ?? "";
    const hubCookies = `cloudagentfleet_session=${cookieValue(setCookie, "cloudagentfleet_session")}; `
      + `cloudagentfleet_csrf=${cookieValue(setCookie, "cloudagentfleet_csrf")}`;
    assert.equal((await fetch(`${baseUrl}/_fleet/api/instances`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: hubCookies, origin: baseUrl },
      body: JSON.stringify({
        id: "laptop-cptr",
        label: "Laptop",
        backend: "cptr",
        connectionMode: "tailscale-url",
        endpoint: `http://127.0.0.1:${(upstream.address() as { port: number }).port}`,
      }),
    })).status, 201);
    const page = await fetch(`${hostUrl}/`, { headers: { cookie: `${hubCookies}; cloudagentfleet_instance=laptop-cptr` } });
    assert.equal(page.status, 200);
    assert.equal(page.headers.get("x-frame-options"), null, "the backend's own framing rule is replaced");
    assert.equal(page.headers.get("content-security-policy"), `default-src 'self'; frame-ancestors 'self' ${baseUrl}`);
    const notice = await fetch(`${hostUrl}/`);
    assert.equal(notice.headers.get("content-security-policy"), `frame-ancestors 'self' ${baseUrl}`);
  } finally {
    await close();
    await closeHttp(upstream);
  }
});

test("an installed Hub keeps its state in the user's folder, not where it starts", () => {
  assert.equal(defaultHubStatePath(true, () => false, "/home/op"), "data/hub.json");
  assert.equal(defaultHubStatePath(false, () => false, "/home/op"), join("/home/op", ".cloudagentfleet", "hub.json"));
  assert.equal(defaultHubStatePath(false, (path) => path === "data/hub.json", "/home/op"), "data/hub.json");
});
