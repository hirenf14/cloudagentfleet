import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { resolve, dirname, join, sep } from "node:path";
import type { Duplex } from "node:stream";
import { ControlPlane, type NodeConnection } from "./index.ts";
import { FleetHub } from "./hub.ts";
import { resolveUiAuth, type UiAuth, type UiAuthRequest } from "./auth.ts";
import { HttpError } from "./errors.ts";
import { createHostUiServer } from "./host-ui.ts";
import {
  INSTANCE_COOKIE,
  instanceCookie,
  isSecureRequest,
  originFor,
  selectedInstance,
  sendJson,
  type OriginPlan,
} from "./http-helpers.ts";
import {
  FLEET_PATH_PREFIX,
  backendDefinition,
  describeBackends,
  rejectSocket,
} from "../../../packages/host-adapters/src/index.ts";
import { isHostBackend } from "../../../packages/protocol/src/index.ts";
import type {
  HostInstance,
  HostInstanceRegistration,
  NodeCapability,
  CreateJobRequest,
  NodeHeartbeat,
  NodeMessage,
  NodeRegistration,
} from "../../../packages/protocol/src/index.ts";

const MAX_BODY_BYTES = 1_048_576;

function resolveDashboardRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [];
  // Running from source (strip-types): serve the editable UI, not a stale build.
  if (import.meta.url.endsWith(".ts")) candidates.push(resolve(here, "../../dashboard/public"));
  // A release Hub (npm package or standalone archive) ships its UI beside it.
  candidates.push(join(here, "public"));
  try {
    const require = createRequire(import.meta.url);
    const packageRoot = dirname(require.resolve("@cloudagentfleet/ui/package.json"));
    candidates.push(join(packageRoot, "dist", "public"), join(packageRoot, "public"));
  } catch {
    // Fall through to monorepo paths for local strip-types runs.
  }
  candidates.push(
    resolve(here, "../../dashboard/dist/public"),
    resolve(here, "../../dashboard/public"),
  );
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error("Unable to resolve @cloudagentfleet/ui public assets");
}

/**
 * Where the Hub keeps its state when CLOUDAGENTFLEET_DATA_PATH is unset: the
 * user's ~/.cloudagentfleet for an installed Hub, so it does not depend on the
 * folder it starts in. Source runs keep ./data, and an installed Hub that
 * already has ./data/hub.json keeps using it.
 */
export function defaultHubStatePath(
  runningFromSource = import.meta.url.endsWith(".ts"),
  pathExists: (path: string) => boolean = existsSync,
  home: string = homedir(),
): string {
  const local = "data/hub.json";
  if (runningFromSource || pathExists(local)) return local;
  return join(home, ".cloudagentfleet", "hub.json");
}

const DASHBOARD_ROOT = resolveDashboardRoot();

export interface ControllerServerOptions {
  host?: string;
  port?: number;
  /** Host-UI origin listener (proxied backend UIs); defaults to port + 1. */
  hostPort?: number;
  /** Public dashboard / host-UI origins when the defaults can't be inferred. */
  publicUrl?: string;
  hostUiUrl?: string;
  authToken?: string;
  uiPassword?: string;
  uiPasswordHash?: string;
  uiSessionTtlMs?: number;
  uiCookieSecure?: boolean;
  codemanCredentials?: Record<string, { username: string; password: string }>;
  controlPlane?: ControlPlane;
  hub?: FleetHub;
  statePath?: string;
}

export interface ControllerServer {
  server: Server;
  /** Serves proxied backend UIs on their own origin, isolated from the Hub API. */
  hostServer: Server;
  controlPlane: ControlPlane;
  host: string;
  port: number;
  hostPort: number;
  /** Read per request; tests and embedders may set explicit public URLs after binding. */
  origins: OriginPlan;
  hub: FleetHub;
  /** Auto-generated Hub password still in bootstrap form (print on each start). */
  revealPassword?: string;
  /** Where the generated Worker token is stored, when the Hub generated one. */
  workerTokenPath?: string;
}

export function startControllerServer(
  options: ControllerServerOptions = {},
): ControllerServer {
  const controller = createControllerServer(options);
  controller.hostServer.listen(controller.hostPort, controller.host, () => {
    console.log(`Host UIs listening on ${controller.host}:${controller.hostPort}`);
  });
  controller.server.listen(controller.port, controller.host, () => {
    console.log(`Cloud Agent Fleet Hub listening on ${controller.host}:${controller.port}`);
    if (controller.revealPassword) {
      console.log(`Hub UI password: ${controller.revealPassword}`);
      console.log(
        "Shown on every start until you set CLOUDAGENTFLEET_UI_PASSWORD or CLOUDAGENTFLEET_UI_PASSWORD_HASH.",
      );
    }
    if (controller.workerTokenPath) {
      console.log(
        `Worker token: ${controller.workerTokenPath} (give it to \`cloudagentfleet setup\`, or set CLOUDAGENTFLEET_AUTH_TOKEN)`,
      );
    }
  });
  return controller;
}

export function createControllerServer(
  options: ControllerServerOptions = {},
): ControllerServer {
  const host = options.host ?? process.env.CLOUDAGENTFLEET_HOST ?? "127.0.0.1";
  const port = options.port ?? Number(process.env.CLOUDAGENTFLEET_PORT ?? 8787);
  const hostPort = options.hostPort ?? Number(process.env.CLOUDAGENTFLEET_HOST_PORT ?? port + 1);
  const origins: OriginPlan = {
    hubPort: port,
    hostPort,
    hubUrl: options.publicUrl ?? process.env.CLOUDAGENTFLEET_PUBLIC_URL,
    hostUrl: options.hostUiUrl ?? process.env.CLOUDAGENTFLEET_HOST_UI_URL,
  };
  const statePath = options.statePath ?? process.env.CLOUDAGENTFLEET_DATA_PATH ?? defaultHubStatePath();
  const dataDir = statePath ? dirname(resolve(statePath)) : undefined;
  // With a UI password on, Workers must present a token. Without a configured
  // one, a durable Hub generates and keeps its own, like the UI password.
  const configuredToken = options.authToken ?? process.env.CLOUDAGENTFLEET_AUTH_TOKEN;
  const workerTokenPath = !configuredToken && dataDir ? join(dataDir, "hub-worker-token") : undefined;
  const authToken = configuredToken ?? (workerTokenPath ? readOrCreateWorkerToken(workerTokenPath) : undefined);
  const resolvedAuth = resolveUiAuth({
    dataDir,
    password: options.uiPassword,
    passwordHash: options.uiPasswordHash,
    sessionTtlMs: options.uiSessionTtlMs,
    secureCookies: options.uiCookieSecure,
  });
  const uiAuth = resolvedAuth.auth;
  const controlPlane = options.controlPlane ?? new ControlPlane();
  const hub = options.hub ?? new FleetHub({
    statePath,
    credentials: options.codemanCredentials ?? readCodemanCredentials(),
    connectorRequest: (nodeId, instanceId, operation, payload) =>
      controlPlane.requestConnector(nodeId, instanceId, operation, payload),
    connectorSubscribeEvents: (nodeId, instanceId, listener) =>
      controlPlane.subscribeConnectorEvents(nodeId, instanceId, listener),
    connectorOpenStream: (nodeId, instanceId) => controlPlane.openTunnel(nodeId, instanceId),
  });

  if (!isLoopback(host) && !authToken) {
    throw new Error("A bearer token is required when the Controller binds beyond loopback");
  }

  const server = createServer(async (request, response) => {
    // The dashboard is never framed: it holds the Hub session.
    response.setHeader("content-security-policy", "frame-ancestors 'none'");
    response.setHeader("x-frame-options", "DENY");
    try {
      const target = resolveHubUrl(request);
      const hubPath = target.url.pathname;
      const auth = uiAuth.authenticate(request, authToken);
      const isPublicHubRoute = (
        (request.method === "GET" && hubPath === "/healthz")
        || hubPath === "/api/auth/login"
        || hubPath === "/api/auth/session"
      );
      if (!isPublicHubRoute && !auth.authenticated) {
        if (request.method === "GET" && !hubPath.startsWith("/api/")) {
          sendLoginPage(response, uiAuth.enabled);
        } else {
          sendJson(response, 401, { error: "Authentication required" });
        }
        return;
      }
      if (hubPath === "/api/auth/logout" && uiAuth.enabled && !auth.authenticated) {
        sendJson(response, 401, { error: "Unauthorized" });
        return;
      }
      // Mutations must come from the dashboard origin. Backend UIs run on the
      // separate host-UI origin, so their requests are rejected here.
      if (
        auth.authenticated
        && request.method !== "GET"
        && request.method !== "HEAD"
        && !uiAuth.isCsrfValid(request, auth)
      ) {
        sendJson(response, 403, { error: "Cross-site request blocked" });
        return;
      }
      if (
        auth.authenticated
        && uiAuth.enabled
        && isWorkerOrJobRoute(hubPath)
        && auth.method === "ui"
        && authToken
      ) {
        sendJson(response, 403, { error: "Worker credentials are required" });
        return;
      }

      if (request.method === "GET" && target.url.pathname === "/" && !target.prefixed) {
        response.writeHead(303, { location: `${FLEET_PATH_PREFIX}/` });
        response.end();
        return;
      }
      await route(request, response, target.url, controlPlane, hub, uiAuth, auth, origins, { workerTokenPath });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Request failed";
      const status = error instanceof HttpError ? error.status : 400;
      sendJson(response, status, { error: message });
    }
  });
  server.on("upgrade", (request, socket, head) => {
    void handleUpgrade(request, socket, head, hub, uiAuth, authToken);
  });
  const hostServer = createHostUiServer({ hub, uiAuth, origins, serveAsset: serveDashboardAsset });

  return {
    server,
    hostServer,
    controlPlane,
    hub,
    host,
    port,
    hostPort,
    origins,
    revealPassword: resolvedAuth.revealPassword,
    ...(workerTokenPath ? { workerTokenPath } : {}),
  };
}

/**
 * Dashboard-origin routing: `/_fleet/...` is canonical; unprefixed `/api`,
 * `/ws`, and `/healthz` stay as legacy aliases for installed Workers and
 * CLIs. Backend UIs never run on this origin (see host-ui.ts).
 */
function resolveHubUrl(request: IncomingMessage): { url: URL; prefixed: boolean } {
  const url = new URL(request.url ?? "/", "http://controller.local");
  if (url.pathname === FLEET_PATH_PREFIX || url.pathname.startsWith(`${FLEET_PATH_PREFIX}/`)) {
    const hubUrl = new URL(url);
    hubUrl.pathname = url.pathname.slice(FLEET_PATH_PREFIX.length) || "/";
    return { url: hubUrl, prefixed: true };
  }
  return { url, prefixed: false };
}

async function handleUpgrade(
  request: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  hub: FleetHub,
  uiAuth: UiAuth,
  authToken: string | undefined,
): Promise<void> {
  const terminalMatch = resolveHubUrl(request).url.pathname
    .match(/^\/ws\/instances\/([^/]+)\/sessions\/([^/]+)\/terminal$/);
  if (!terminalMatch) {
    socket.destroy();
    return;
  }
  const auth = uiAuth.authenticate(request, authToken);
  if (
    !auth.authenticated
    || !uiAuth.isOriginValid(request)
    || typeof request.headers.upgrade !== "string"
    || request.headers.upgrade.toLowerCase() !== "websocket"
  ) {
    rejectSocket(socket, 401, "Unauthorized");
    return;
  }
  try {
    await hub.proxyTerminal(
      decodeURIComponent(terminalMatch[1]!),
      decodeURIComponent(terminalMatch[2]!),
      request,
      socket,
      head,
    );
  } catch (error) {
    rejectSocket(
      socket,
      502,
      error instanceof Error ? error.message : "WebSocket proxy unavailable",
    );
  }
}

async function route(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  controlPlane: ControlPlane,
  hub: FleetHub,
  uiAuth: UiAuth,
  auth: UiAuthRequest,
  origins: OriginPlan,
  setup: { workerTokenPath?: string } = {},
): Promise<void> {
  const method = request.method ?? "GET";

  if (method === "GET" && url.pathname === "/healthz") {
    sendJson(response, 200, {
      ok: true,
      role: "controller",
      execution: "codeman-native-proxy-with-worker-fallback",
    });
    return;
  }

  if (method === "GET" && url.pathname === "/api/auth/session") {
    sendJson(response, 200, {
      enabled: uiAuth.enabled,
      authenticated: auth.authenticated,
      ...(uiAuth.getCsrfToken(request, auth)
        ? { csrfToken: uiAuth.getCsrfToken(request, auth) }
        : {}),
    });
    return;
  }

  if (method === "POST" && url.pathname === "/api/auth/login") {
    const body = await readJson<{ password?: string }>(request);
    const clientKey = clientAddress(request);
    if (!uiAuth.enabled) {
      sendJson(response, 400, { error: "UI password authentication is disabled" });
      return;
    }
    if (typeof body.password !== "string" || !uiAuth.verifyPassword(clientKey, body.password)) {
      sendJson(response, 401, { error: "Invalid password" });
      return;
    }
    const session = uiAuth.createSession();
    response.setHeader("set-cookie", [
      uiAuth.sessionCookie(session.token, request),
      uiAuth.csrfCookie(session.csrfToken, request),
    ]);
    sendJson(response, 200, {
      authenticated: true,
      expiresAt: new Date(session.expiresAt).toISOString(),
    });
    return;
  }

  if (method === "POST" && url.pathname === "/api/auth/logout") {
    uiAuth.revoke(request);
    response.setHeader("set-cookie", [
      ...uiAuth.clearCookies(request),
      ...[INSTANCE_COOKIE, ...hub.browserCookieNames()].map(
        (name) => `${name}=; Path=/; Max-Age=0; SameSite=Lax${isSecureRequest(request) ? "; Secure" : ""}`,
      ),
    ]);
    sendJson(response, 204, {});
    return;
  }

  const selectedInstanceId = selectedInstance(request);
  const fleetSelectMatch = url.pathname.match(/^\/api\/fleet\/select\/([^/]+)$/);
  if (method === "GET" && fleetSelectMatch) {
    const instanceId = decodeURIComponent(fleetSelectMatch[1]!);
    const instance = hub.getInstance(instanceId);
    if (!hub.supportsFeature(instance.id, "native-ui-proxy")) {
      throw new HttpError(400, "This instance's UI is not available through the Hub proxy");
    }
    // Backend UIs live on the host-UI origin, never on the dashboard origin.
    response.writeHead(303, {
      location: `${originFor(request, "host", origins)}/_fleet/select/${encodeURIComponent(instanceId)}`,
    });
    response.end();
    return;
  }

  if (method === "GET" && url.pathname === "/api/fleet/clear") {
    response.setHeader("set-cookie", instanceCookie(request));
    response.writeHead(303, { location: `${FLEET_PATH_PREFIX}/` });
    response.end();
    return;
  }

  // What the dashboard's onboarding shows: where Workers connect and how to get
  // a token. The token itself never leaves the Hub machine.
  if (method === "GET" && url.pathname === "/api/fleet/onboarding") {
    const hubUrl = originFor(request, "hub", origins);
    const hostname = new URL(hubUrl).hostname;
    sendJson(response, 200, {
      hubUrl,
      dashboardUrl: `${hubUrl}${FLEET_PATH_PREFIX}/`,
      reachableBeyondThisMachine: !["127.0.0.1", "localhost", "[::1]", "::1"].includes(hostname),
      workerTokenPath: setup.workerTokenPath ?? null,
      workers: controlPlane.nodes.list().length,
    });
    return;
  }

  if (method === "GET" && url.pathname === "/api/fleet/origins") {
    sendJson(response, 200, { hostUiOrigin: originFor(request, "host", origins) });
    return;
  }

  if (method === "GET" && url.pathname === "/api/fleet/current") {
    sendJson(response, 200, {
      instanceId: selectedInstanceId,
      instance: selectedInstanceId ? publicInstance(hub.getInstance(selectedInstanceId)) : null,
    });
    return;
  }

  if (method === "GET" && !url.pathname.startsWith("/api/")) {
    await serveDashboardAsset(url.pathname, response);
    return;
  }

  if (method === "GET" && url.pathname === "/api/backends") {
    sendJson(response, 200, { backends: describeBackends() });
    return;
  }

  if (method === "GET" && url.pathname === "/api/instances") {
    sendJson(response, 200, { instances: hub.listInstances().map(publicInstance) });
    return;
  }

  if (method === "POST" && url.pathname === "/api/instances") {
    const body = await readJson<HostInstanceRegistration & {
      credentials?: { username?: string; password?: string };
    }>(request);
    const credentials = body.credentials;
    const registration: HostInstanceRegistration = { ...body };
    delete (registration as HostInstanceRegistration & { credentials?: unknown }).credentials;
    if (
      credentials !== undefined
      && (
        typeof credentials.username !== "string"
        || credentials.username.length === 0
        || typeof credentials.password !== "string"
      )
    ) {
      throw new HttpError(400, "Codeman credentials must include a username and password");
    }
    if (
      registration.connectionMode === "tailscale-url"
      && (
        !registration.endpoint
        || (
          !isTailnetEndpoint(registration.endpoint)
          && !isLoopbackEndpoint(registration.endpoint)
        )
      )
    ) {
      throw new HttpError(400, "Instance endpoint must be a Tailscale HTTPS hostname or loopback development URL");
    }
    const backend = registration.backend ?? "codeman";
    if (!isHostBackend(backend)) throw new HttpError(400, `Unknown backend: ${String(backend)}`);
    const definition = backendDefinition(backend);
    if (!definition.connectionModes.includes(registration.connectionMode)) {
      throw new HttpError(
        400,
        `${definition.label} supports only: ${definition.connectionModes.join(", ")}`,
      );
    }
    if (registration.connectionMode === "connector") {
      const node = controlPlane.nodes.list().find((candidate) => candidate.id === registration.nodeId);
      if (!node) throw new HttpError(404, `Unknown node: ${registration.nodeId}`);
      if (node.status === "revoked") throw new HttpError(403, `Node is revoked: ${node.id}`);
      if (!node.capabilities.includes(backend as NodeCapability)) {
        throw new HttpError(400, `Node does not support ${backend}: ${node.id}`);
      }
    }
    const instance = hub.registerInstance(
      registration,
      credentials
        ? { username: credentials.username!, password: credentials.password! }
        : undefined,
    );
    sendJson(response, 201, { instance: publicInstance(instance) });
    return;
  }

  const instanceMatch = url.pathname.match(/^\/api\/instances\/([^/]+)$/);
  if (method === "GET" && instanceMatch) {
    const instance = hub.getInstance(decodeURIComponent(instanceMatch[1]!));
    sendJson(response, 200, { instance: publicInstance(instance) });
    return;
  }

  const instanceCapabilitiesMatch = url.pathname.match(
    /^\/api\/instances\/([^/]+)\/capabilities$/,
  );
  if (method === "GET" && instanceCapabilitiesMatch) {
    const instanceId = decodeURIComponent(instanceCapabilitiesMatch[1]!);
    const agents = await hub.listAgents(instanceId);
    sendJson(response, 200, { agents });
    return;
  }

  const instanceHealthMatch = url.pathname.match(/^\/api\/instances\/([^/]+)\/health$/);
  if (method === "POST" && instanceHealthMatch) {
    const instanceId = decodeURIComponent(instanceHealthMatch[1]!);
    const instance = await hub.checkInstance(instanceId);
    sendJson(response, 200, { instance: publicInstance(instance) });
    return;
  }

  if (method === "DELETE" && instanceMatch) {
    const instanceId = decodeURIComponent(instanceMatch[1]!);
    hub.removeInstance(instanceId);
    sendJson(response, 204, {});
    return;
  }

  if (method === "GET" && url.pathname === "/api/sessions") {
    const instanceId = url.searchParams.get("instanceId");
    if (instanceId) hub.getInstance(instanceId);
    sendJson(response, 200, {
      sessions: instanceId
        ? hub.listSessions().filter((session) => session.instanceId === instanceId)
        : hub.listSessions(),
    });
    return;
  }

  const instanceWorkspaceMatch = url.pathname.match(/^\/api\/instances\/([^/]+)\/workspaces$/);
  const instanceWorkspaceSuggestionMatch = url.pathname.match(
    /^\/api\/instances\/([^/]+)\/workspaces\/suggestions$/,
  );
  if (method === "GET" && instanceWorkspaceSuggestionMatch) {
    const instanceId = decodeURIComponent(instanceWorkspaceSuggestionMatch[1]!);
    const suggestions = await hub.suggestWorkspacePaths(
      instanceId,
      url.searchParams.get("path") ?? "",
    );
    sendJson(response, 200, { suggestions });
    return;
  }
  if (method === "GET" && instanceWorkspaceMatch) {
    const instance = hub.getInstance(decodeURIComponent(instanceWorkspaceMatch[1]!));
    sendJson(response, 200, { workspaces: instance.workspaces });
    return;
  }

  const instanceSessionsMatch = url.pathname.match(/^\/api\/instances\/([^/]+)\/sessions$/);
  if (method === "GET" && instanceSessionsMatch) {
    const instanceId = decodeURIComponent(instanceSessionsMatch[1]!);
    await Promise.all([
      hub.listAgents(instanceId),
      hub.supportsFeature(instanceId, "sessions") ? hub.syncSessions(instanceId) : undefined,
    ]);
    sendJson(response, 200, {
      sessions: hub.listSessions().filter((session) => session.instanceId === instanceId),
    });
    return;
  }

  if (method === "POST" && instanceSessionsMatch) {
    const instanceId = decodeURIComponent(instanceSessionsMatch[1]!);
    const body = await readJson<{
      workspaceId?: string;
      workspacePath?: string;
      agentId: string;
      title?: string;
    }>(request);
    const session = await hub.createSession(
      instanceId,
      body.workspaceId,
      body.agentId,
      body.title,
      body.workspacePath,
    );
    sendJson(response, 201, { session });
    return;
  }

  const sessionRemoveMatch = url.pathname.match(
    /^\/api\/instances\/([^/]+)\/sessions\/([^/]+)$/,
  );
  if (method === "DELETE" && sessionRemoveMatch) {
    hub.removeSession(
      decodeURIComponent(sessionRemoveMatch[1]!),
      decodeURIComponent(sessionRemoveMatch[2]!),
    );
    sendJson(response, 204, {});
    return;
  }

  const sessionInputMatch = url.pathname.match(
    /^\/api\/instances\/([^/]+)\/sessions\/([^/]+)\/input$/,
  );
  if (method === "POST" && sessionInputMatch) {
    const body = await readJson<{ input: string; raw?: boolean }>(request);
    await hub.sendInput(
      decodeURIComponent(sessionInputMatch[1]!),
      decodeURIComponent(sessionInputMatch[2]!),
      body.input,
      body.raw === true,
    );
    sendJson(response, 202, { accepted: true });
    return;
  }

  const sessionResizeMatch = url.pathname.match(
    /^\/api\/instances\/([^/]+)\/sessions\/([^/]+)\/resize$/,
  );
  if (method === "POST" && sessionResizeMatch) {
    const body = await readJson<{ cols: number; rows: number }>(request);
    if (!Number.isInteger(body.cols) || !Number.isInteger(body.rows)
      || body.cols < 1 || body.cols > 500 || body.rows < 1 || body.rows > 500) {
      throw new HttpError(400, "Terminal size must be between 1 and 500 columns and rows");
    }
    await hub.resizeSession(
      decodeURIComponent(sessionResizeMatch[1]!),
      decodeURIComponent(sessionResizeMatch[2]!),
      body.cols,
      body.rows,
    );
    sendJson(response, 202, { accepted: true });
    return;
  }

  const sessionStopMatch = url.pathname.match(
    /^\/api\/instances\/([^/]+)\/sessions\/([^/]+)\/stop$/,
  );
  if (method === "POST" && sessionStopMatch) {
    const instanceId = decodeURIComponent(sessionStopMatch[1]!);
    const sessionId = decodeURIComponent(sessionStopMatch[2]!);
    await hub.stopSession(instanceId, sessionId);
    sendJson(response, 202, { accepted: true });
    return;
  }

  if (method === "GET" && url.pathname === "/api/events") {
    const instanceId = url.searchParams.get("instanceId");
    if (instanceId) hub.getInstance(instanceId);
    response.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-store",
      connection: "keep-alive",
    });
    response.write(`event: snapshot\ndata: ${JSON.stringify({
      instances: instanceId
        ? hub.listInstances().filter((instance) => instance.id === instanceId)
        : hub.listInstances(),
      sessions: instanceId
        ? hub.listSessions().filter((session) => session.instanceId === instanceId)
        : hub.listSessions(),
    })}\n\n`);
    const unsubscribe = hub.subscribeEvents((event) => {
      if (
        !response.writableEnded
        && (!instanceId || event.instanceId === instanceId)
      ) {
        response.write(`event: session\ndata: ${JSON.stringify(event)}\n\n`);
      }
    });
    const keepAlive = setInterval(() => {
      if (!response.writableEnded) response.write(": keep-alive\n\n");
    }, 15_000);
    response.on("close", () => {
      clearInterval(keepAlive);
      unsubscribe();
    });
    return;
  }

  if (method === "GET" && url.pathname === "/api/workers") {
    sendJson(response, 200, { workers: controlPlane.nodes.list() });
    return;
  }

  if (method === "POST" && url.pathname === "/api/workers") {
    const registration = await readJson<NodeRegistration>(request);
    const worker = controlPlane.enrollNode(registration);
    sendJson(response, 201, { worker });
    return;
  }

  // Ask one Worker for its agents' usage limits; the Worker runs the checks itself and answers.
  const usageMatch = url.pathname.match(/^\/api\/workers\/([^/]+)\/usage$/);
  if (method === "POST" && usageMatch) {
    const nodeId = decodeURIComponent(usageMatch[1]!);
    const instance = hub.listInstances().find((candidate) => candidate.nodeId === nodeId && candidate.backend === "codeman");
    if (!instance) {
      sendJson(response, 404, { error: "No connector instance for this Worker" });
      return;
    }
    try {
      const usage = await controlPlane.requestConnector(nodeId, instance.id, "usage.read", undefined, 45_000);
      sendJson(response, 200, { nodeId, usage });
    } catch (error) {
      sendJson(response, 502, { error: error instanceof Error ? error.message : "Usage request failed" });
    }
    return;
  }

  const connectMatch = url.pathname.match(/^\/api\/workers\/([^/]+)\/connect$/);
  if (method === "GET" && connectMatch) {
    const nodeId = decodeURIComponent(connectMatch[1]!);
    const node = controlPlane.nodes.list().find((candidate) => candidate.id === nodeId);
    if (!node) {
      sendJson(response, 404, { error: "Worker not found" });
      return;
    }

    response.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-store",
      connection: "keep-alive",
    });
    response.write(`event: connected\ndata: ${JSON.stringify({ nodeId })}\n\n`);
    const connection: NodeConnection = {
      node,
      send: async (message) => {
        if (!response.writableEnded) {
          response.write(`data: ${JSON.stringify(message)}\n\n`);
        }
      },
      close: async () => {
        if (!response.writableEnded) response.end();
      },
    };
    controlPlane.registerConnection(connection);
    response.on("close", () => controlPlane.removeConnection(nodeId, connection));
    return;
  }

  const messageMatch = url.pathname.match(/^\/api\/workers\/([^/]+)\/messages$/);
  if (method === "POST" && messageMatch) {
    const message = await readJson<NodeMessage>(request);
    controlPlane.receiveNodeMessage(decodeURIComponent(messageMatch[1]!), message);
    sendJson(response, 202, { accepted: true });
    return;
  }

  const heartbeatMatch = url.pathname.match(/^\/api\/workers\/([^/]+)\/heartbeat$/);
  if (method === "POST" && heartbeatMatch) {
    const heartbeat = await readJson<NodeHeartbeat>(request);
    const worker = controlPlane.heartbeatNode({
      ...heartbeat,
      nodeId: heartbeatMatch[1]!,
    });
    sendJson(response, 200, { worker });
    return;
  }

  if (method === "POST" && url.pathname === "/api/jobs") {
    const jobRequest = await readJson<CreateJobRequest>(request);
    const job = await controlPlane.createJob(jobRequest);
    sendJson(response, 202, { job });
    return;
  }

  const jobMatch = url.pathname.match(/^\/api\/jobs\/([^/]+)$/);
  if (method === "GET" && jobMatch) {
    const job = controlPlane.jobs.get(jobMatch[1]!);
    if (!job) {
      sendJson(response, 404, { error: "Job not found" });
      return;
    }
    sendJson(response, 200, { job });
    return;
  }

  const cancelMatch = url.pathname.match(/^\/api\/jobs\/([^/]+)\/cancel$/);
  if (method === "POST" && cancelMatch) {
    await controlPlane.cancelJob(cancelMatch[1]!);
    sendJson(response, 202, { job: controlPlane.jobs.get(cancelMatch[1]!) });
    return;
  }

  if (method === "GET" && url.pathname === "/api/audit") {
    sendJson(response, 200, {
      events: [...controlPlane.audit.list(), ...hub.listAudit()],
    });
    return;
  }

  sendJson(response, 404, { error: "Not found" });
}

async function serveDashboardAsset(pathname: string, response: ServerResponse): Promise<void> {
  let relativePath: string;
  try {
    relativePath = pathname === "/" ? "index.html" : decodeURIComponent(pathname.slice(1));
  } catch {
    sendJson(response, 400, { error: "Invalid asset path" });
    return;
  }
  const filePath = resolve(DASHBOARD_ROOT, relativePath);
  if (filePath !== DASHBOARD_ROOT && !filePath.startsWith(`${DASHBOARD_ROOT}${sep}`)) {
    sendJson(response, 404, { error: "Not found" });
    return;
  }
  try {
    const body = await readFile(filePath);
    response.writeHead(200, {
      "content-type": contentType(filePath),
      "cache-control": "no-cache",
    });
    response.end(body);
  } catch {
    sendJson(response, 404, { error: "Not found" });
  }
}

function contentType(filePath: string): string {
  if (filePath.endsWith(".html")) return "text/html; charset=utf-8";
  if (filePath.endsWith(".js")) return "application/javascript; charset=utf-8";
  if (filePath.endsWith(".css")) return "text/css; charset=utf-8";
  return "application/octet-stream";
}

/** Reads the Hub-generated Worker token, creating it (owner-only) on first use. */
function readOrCreateWorkerToken(path: string): string {
  if (existsSync(path)) {
    const stored = readFileSync(path, "utf8").trim();
    if (stored) return stored;
  }
  const token = randomBytes(32).toString("base64url");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${token}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
  return token;
}

function isWorkerOrJobRoute(pathname: string): boolean {
  return pathname === "/api/workers"
    || pathname.startsWith("/api/workers/")
    || pathname === "/api/jobs"
    || pathname.startsWith("/api/jobs/");
}

function readCodemanCredentials(): Record<string, { username: string; password: string }> {
  const encoded = process.env.CLOUDAGENTFLEET_CODEMAN_CREDENTIALS;
  if (!encoded) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(encoded);
  } catch {
    throw new Error("CLOUDAGENTFLEET_CODEMAN_CREDENTIALS must be valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("CLOUDAGENTFLEET_CODEMAN_CREDENTIALS must be an object");
  }
  const credentials: Record<string, { username: string; password: string }> = {};
  for (const [instanceId, value] of Object.entries(parsed)) {
    if (
      typeof value !== "object"
      || value === null
      || Array.isArray(value)
      || typeof (value as { username?: unknown }).username !== "string"
      || typeof (value as { password?: unknown }).password !== "string"
    ) {
      throw new Error(`Invalid Codeman credentials for instance ${instanceId}`);
    }
    credentials[instanceId] = {
      username: (value as { username: string }).username,
      password: (value as { password: string }).password,
    };
  }
  return credentials;
}

function clientAddress(request: IncomingMessage): string {
  const forwarded = request.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.trim()) {
    return forwarded.split(",")[0]!.trim();
  }
  return request.socket.remoteAddress ?? "unknown";
}

function isTailnetEndpoint(value: string): boolean {
  try {
    const endpoint = new URL(value);
    return endpoint.protocol === "https:"
      && (
        endpoint.hostname.endsWith(".ts.net")
        || endpoint.hostname.endsWith(".ts.net.")
        || isTailscaleIpv4(endpoint.hostname)
      );
  } catch {
    return false;
  }
}

function isLoopbackEndpoint(value: string): boolean {
  try {
    const endpoint = new URL(value);
    return (
      endpoint.hostname === "localhost"
      || endpoint.hostname === "127.0.0.1"
      || endpoint.hostname === "::1"
      || endpoint.hostname === "[::1]"
    );
  } catch {
    return false;
  }
}

function isTailscaleIpv4(hostname: string): boolean {
  const parts = hostname.split(".");
  if (parts.length !== 4 || parts.some((part) => !/^\d+$/.test(part))) return false;
  const first = Number(parts[0]);
  const second = Number(parts[1]);
  return first === 100 && second >= 64 && second <= 127;
}

/**
 * Endpoints stay server-side, except for link-mode hosts: the browser opens
 * those directly, so their tailnet URL is returned as `launchUrl`.
 */
function publicInstance(
  instance: HostInstance,
): HostInstance & { launchUrl?: string } {
  return {
    ...instance,
    endpoint: null,
    ...(instance.features.includes("native-ui-link") && instance.endpoint
      ? { launchUrl: instance.endpoint }
      : {}),
  };
}

function isLoopback(host: string): boolean {
  return host === "127.0.0.1" || host === "::1" || host === "localhost";
}

function sendLoginPage(response: ServerResponse, authEnabled: boolean): void {
  if (!authEnabled) {
    sendJson(response, 401, { error: "Unauthorized" });
    return;
  }
  response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  response.end(`<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Cloud Agent Fleet — Sign in</title>
<style>
body{margin:0;min-height:100vh;display:grid;place-items:center;background:#000;color:#d4d4d4;font:12px/16px Inter,-apple-system,BlinkMacSystemFont,ui-sans-serif,system-ui,"Segoe UI",sans-serif}
main{width:min(300px,calc(100vw - 48px))}
h1{margin:0;color:#f5f5f5;font-size:18px;font-weight:500;line-height:28px}p{margin:2px 0 24px;color:#8a8a8a}
label{display:grid;gap:6px;color:#8a8a8a;font-size:11px}input{height:32px;padding:0 10px;border:1px solid rgb(255 255 255/11%);border-radius:8px;outline:0;background:#000;color:#d4d4d4;font:inherit}
input:focus{border-color:rgb(255 255 255/28%)}
button{width:100%;height:32px;margin-top:12px;border:0;border-radius:8px;background:#d4d4d4;color:#000;font:500 12px/16px inherit;font-family:inherit;cursor:pointer}
button:hover{background:#fff}
#error{min-height:16px;margin-top:10px;color:#f87171}
</style></head>
<body><main><h1>Cloud Agent Fleet</h1><p>Sign in to the private fleet Hub.</p>
<form id="login"><label>Password<input id="password" type="password" autocomplete="current-password" required autofocus></label>
<button type="submit">Sign in</button><div id="error" role="alert"></div></form></main>
<script>
document.getElementById("login").addEventListener("submit",async function(event){
event.preventDefault();const error=document.getElementById("error");error.textContent="";
try{const response=await fetch("/_fleet/api/auth/login",{method:"POST",credentials:"same-origin",headers:{"content-type":"application/json"},body:JSON.stringify({password:document.getElementById("password").value})});
if(!response.ok)throw new Error((await response.json().catch(function(){return {}})).error||"Sign in failed");
location.reload();}catch(cause){error.textContent=cause.message||"Sign in failed";}
});
</script></body></html>`);
}

async function readJson<T>(request: IncomingMessage): Promise<T> {
  const chunks: string[] = [];
  const decoder = new TextDecoder();
  let size = 0;

  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new Error("Request body is too large");
    chunks.push(decoder.decode(buffer, { stream: true }));
  }

  if (chunks.length === 0) throw new Error("Request body is required");
  chunks.push(decoder.decode());
  return JSON.parse(chunks.join("")) as T;
}

function isDirectHubEntrypoint(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  const normalized = entry.replaceAll("\\", "/");
  return (
    normalized.endsWith("/server.ts")
    || normalized.endsWith("/server.mjs")
    || normalized.endsWith("/cloudagentfleet-hub.mjs")
  );
}

if (isDirectHubEntrypoint()) {
  startControllerServer();
}
