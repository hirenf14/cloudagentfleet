import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { resolve, dirname, join, sep } from "node:path";
import type { Socket } from "node:net";
import { ControlPlane, type NodeConnection } from "./index.ts";
import { CodemanHub } from "./hub.ts";
import { resolveUiAuth, type UiAuth, type UiAuthRequest } from "./auth.ts";
import type {
  CodemanInstanceRegistration,
  CreateJobRequest,
  NodeHeartbeat,
  NodeMessage,
  NodeRegistration,
} from "../../../packages/protocol/src/index.ts";

const MAX_BODY_BYTES = 1_048_576;
const CODEMAN_INSTANCE_COOKIE = "hosted_agents_codeman_instance";

function resolveDashboardRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [];
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

const DASHBOARD_ROOT = resolveDashboardRoot();

export interface ControllerServerOptions {
  host?: string;
  port?: number;
  authToken?: string;
  uiPassword?: string;
  uiPasswordHash?: string;
  uiSessionTtlMs?: number;
  uiCookieSecure?: boolean;
  codemanCredentials?: Record<string, { username: string; password: string }>;
  controlPlane?: ControlPlane;
  hub?: CodemanHub;
  statePath?: string;
}

export interface ControllerServer {
  server: Server;
  controlPlane: ControlPlane;
  host: string;
  port: number;
  hub: CodemanHub;
  /** Auto-generated Hub password still in bootstrap form (print on each start). */
  revealPassword?: string;
}

export function startControllerServer(
  options: ControllerServerOptions = {},
): ControllerServer {
  const controller = createControllerServer(options);
  controller.server.listen(controller.port, controller.host, () => {
    console.log(`Hosted Agents Controller listening on ${controller.host}:${controller.port}`);
    if (controller.revealPassword) {
      console.log(`Hub UI password: ${controller.revealPassword}`);
      console.log(
        "Shown on every start until you set HOSTED_AGENTS_UI_PASSWORD or HOSTED_AGENTS_UI_PASSWORD_HASH.",
      );
    }
  });
  return controller;
}

export function createControllerServer(
  options: ControllerServerOptions = {},
): ControllerServer {
  const host = options.host ?? process.env.HOSTED_AGENTS_HOST ?? "127.0.0.1";
  const port = options.port ?? Number(process.env.HOSTED_AGENTS_PORT ?? 8787);
  const authToken = options.authToken ?? process.env.HOSTED_AGENTS_AUTH_TOKEN;
  const statePath = options.statePath ?? process.env.HOSTED_AGENTS_DATA_PATH ?? "data/hub.json";
  const dataDir = statePath ? dirname(resolve(statePath)) : undefined;
  const resolvedAuth = resolveUiAuth({
    dataDir,
    password: options.uiPassword,
    passwordHash: options.uiPasswordHash,
    sessionTtlMs: options.uiSessionTtlMs,
    secureCookies: options.uiCookieSecure,
  });
  const uiAuth = resolvedAuth.auth;
  const controlPlane = options.controlPlane ?? new ControlPlane();
  const hub = options.hub ?? new CodemanHub({
    statePath,
    credentials: options.codemanCredentials ?? readCodemanCredentials(),
    connectorRequest: (nodeId, instanceId, operation, payload) =>
      controlPlane.requestConnector(nodeId, instanceId, operation, payload),
    connectorSubscribeEvents: (nodeId, instanceId, listener) =>
      controlPlane.subscribeConnectorEvents(nodeId, instanceId, listener),
  });

  if (!isLoopback(host) && !authToken) {
    throw new Error("A bearer token is required when the Controller binds beyond loopback");
  }

  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://controller.local");
      const auth = uiAuth.authenticate(request, authToken);
      const isHealthCheck = request.method === "GET" && url.pathname === "/healthz";
      const isLoginRoute = url.pathname === "/api/auth/login";
      const isSessionRoute = url.pathname === "/api/auth/session";
      const isLogoutRoute = url.pathname === "/api/auth/logout";
      if (!isHealthCheck && !isLoginRoute && !isSessionRoute && !auth.authenticated) {
        if (request.method === "GET" && !url.pathname.startsWith("/api/")) {
          sendLoginPage(response, uiAuth.enabled);
        } else {
          sendJson(response, 401, { error: "Authentication required" });
        }
        return;
      }
      if (isLogoutRoute && uiAuth.enabled && !auth.authenticated) {
        sendJson(response, 401, { error: "Unauthorized" });
        return;
      }
      const selectedForCsrf = selectedInstance(request);
      const proxiedCodemanMutation = Boolean(
        selectedForCsrf
        && request.method !== "GET"
        && request.method !== "HEAD"
        && isCodemanProxiedApiPath(url.pathname),
      );
      if (
        auth.authenticated
        && request.method !== "GET"
        && request.method !== "HEAD"
        && !proxiedCodemanMutation
        && !uiAuth.isCsrfValid(request, auth)
      ) {
        sendJson(response, 403, { error: "Cross-site request blocked" });
        return;
      }
      if (
        auth.authenticated
        && uiAuth.enabled
        && isWorkerOrJobRoute(url.pathname)
        && auth.method === "ui"
        && authToken
      ) {
        sendJson(response, 403, { error: "Worker credentials are required" });
        return;
      }

      await route(request, response, controlPlane, hub, uiAuth, auth);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Request failed";
      const status = error instanceof HttpError
        ? error.status
        : message.startsWith("Unknown Codeman instance") || message.startsWith("Unknown session")
          ? 404
          : message.startsWith("Codeman instance is not connected")
            ? 503
            : 400;
      sendJson(response, status, { error: message });
    }
  });
  server.on("upgrade", (request, socket, head) => {
    void handleTerminalUpgrade(request, socket, head, hub, uiAuth, authToken);
  });

  return { server, controlPlane, hub, host, port, revealPassword: resolvedAuth.revealPassword };
}

async function handleTerminalUpgrade(
  request: IncomingMessage,
  socket: Socket,
  head: Buffer,
  hub: CodemanHub,
  uiAuth: UiAuth,
  authToken: string | undefined,
): Promise<void> {
  const url = new URL(request.url ?? "/", "http://controller.local");
  const explicitMatch = url.pathname.match(
    /^\/ws\/instances\/([^/]+)\/sessions\/([^/]+)\/terminal$/,
  );
  const nativeMatch = url.pathname.match(/^\/ws\/sessions\/([^/]+)\/terminal$/);
  if (!explicitMatch && !nativeMatch) {
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
    rejectUpgrade(socket, 401, "Unauthorized");
    return;
  }
  const instanceId = explicitMatch
    ? decodeURIComponent(explicitMatch[1]!)
    : selectedInstance(request);
  const sessionId = explicitMatch
    ? decodeURIComponent(explicitMatch[2]!)
    : decodeURIComponent(nativeMatch![1]!);
  if (!instanceId) {
    rejectUpgrade(socket, 400, "A Codeman host must be selected");
    return;
  }
  try {
    await hub.proxyTerminal(instanceId, sessionId, request, socket, head);
  } catch (error) {
    rejectUpgrade(
      socket,
      502,
      error instanceof Error ? error.message : "Terminal proxy unavailable",
    );
  }
}

async function route(
  request: IncomingMessage,
  response: ServerResponse,
  controlPlane: ControlPlane,
  hub: CodemanHub,
  uiAuth: UiAuth,
  auth: UiAuthRequest,
): Promise<void> {
  const method = request.method ?? "GET";
  const url = new URL(request.url ?? "/", "http://controller.local");

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
      `${CODEMAN_INSTANCE_COOKIE}=; Path=/; Max-Age=0; SameSite=Lax${isSecureRequest(request) ? "; Secure" : ""}`,
    ]);
    sendJson(response, 204, {});
    return;
  }

  const selectedInstanceId = selectedInstance(request);
  const fleetSelectMatch = url.pathname.match(/^\/api\/fleet\/select\/([^/]+)$/);
  if (method === "GET" && fleetSelectMatch) {
    const instanceId = decodeURIComponent(fleetSelectMatch[1]!);
    const instance = hub.getInstance(instanceId);
    if (instance.connectionMode !== "tailscale-url" || !instance.endpoint) {
      throw new HttpError(400, "This instance is not available through the tailnet proxy");
    }
    try {
      await hub.prepareNativeUi(instanceId);
    } catch {
      // Selection still proceeds; Codeman UI can create cases manually if seeding fails.
    }
    response.setHeader(
      "set-cookie",
      `${CODEMAN_INSTANCE_COOKIE}=${encodeURIComponent(instanceId)}; Path=/; Max-Age=86400; SameSite=Lax${isSecureRequest(request) ? "; Secure" : ""}`,
    );
    response.writeHead(303, { location: "/" });
    response.end();
    return;
  }

  if (method === "GET" && url.pathname === "/api/fleet/clear") {
    response.setHeader(
      "set-cookie",
      `${CODEMAN_INSTANCE_COOKIE}=; Path=/; Max-Age=0; SameSite=Lax${isSecureRequest(request) ? "; Secure" : ""}`,
    );
    response.writeHead(303, { location: "/" });
    response.end();
    return;
  }

  if (method === "GET" && url.pathname === "/api/fleet/current") {
    sendJson(response, 200, {
      instanceId: selectedInstanceId,
      instance: selectedInstanceId ? publicInstance(hub.getInstance(selectedInstanceId)) : null,
    });
    return;
  }

  if (method === "GET" && url.pathname === "/fleet-host-switcher.js") {
    await serveDashboardAsset("/fleet-host-switcher.js", response);
    return;
  }

  if (method === "GET" && !url.pathname.startsWith("/api/")) {
    if (selectedInstanceId) {
      await hub.proxyCodemanRequest(selectedInstanceId, request, response);
      return;
    }
    await serveDashboardAsset(url.pathname, response);
    return;
  }

  if (method === "GET" && url.pathname === "/api/instances") {
    sendJson(response, 200, { instances: hub.listInstances().map(publicInstance) });
    return;
  }

  if (method === "POST" && url.pathname === "/api/instances") {
    const body = await readJson<CodemanInstanceRegistration & {
      credentials?: { username?: string; password?: string };
    }>(request);
    const credentials = body.credentials;
    const registration: CodemanInstanceRegistration = { ...body };
    delete (registration as CodemanInstanceRegistration & { credentials?: unknown }).credentials;
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
      throw new HttpError(400, "Codeman endpoint must be a Tailscale HTTPS hostname or loopback development URL");
    }
    if (registration.connectionMode === "connector") {
      const node = controlPlane.nodes.list().find((candidate) => candidate.id === registration.nodeId);
      if (!node) throw new HttpError(404, `Unknown node: ${registration.nodeId}`);
      if (node.status === "revoked") throw new HttpError(403, `Node is revoked: ${node.id}`);
      if (!node.capabilities.includes("codeman")) {
        throw new HttpError(400, `Node does not support Codeman: ${node.id}`);
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
    const agents = await hub.listCapabilities(instanceId);
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

  if (method === "GET" && url.pathname === "/api/sessions" && !selectedInstanceId) {
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
      hub.listCapabilities(instanceId),
      hub.syncSessions(instanceId),
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
    if (selectedInstanceId) {
      await hub.proxyCodemanRequest(selectedInstanceId, request, response);
      return;
    }
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

  if (selectedInstanceId) {
    await hub.proxyCodemanRequest(selectedInstanceId, request, response);
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

function authorize(request: IncomingMessage, authToken?: string): boolean {
  if (!authToken) return true;
  return request.headers.authorization === `Bearer ${authToken}`;
}

function isWorkerOrJobRoute(pathname: string): boolean {
  return pathname === "/api/workers"
    || pathname.startsWith("/api/workers/")
    || pathname === "/api/jobs"
    || pathname.startsWith("/api/jobs/");
}

/**
 * Hub-owned API prefixes stay under Hub CSRF. Everything else under /api is
 * treated as the selected host's native Codeman surface when a host cookie is set.
 */
function isCodemanProxiedApiPath(pathname: string): boolean {
  if (!pathname.startsWith("/api/")) return false;
  return !(
    pathname === "/api/auth"
    || pathname.startsWith("/api/auth/")
    || pathname === "/api/fleet"
    || pathname.startsWith("/api/fleet/")
    || pathname === "/api/instances"
    || pathname.startsWith("/api/instances/")
    || pathname === "/api/workers"
    || pathname.startsWith("/api/workers/")
    || pathname === "/api/jobs"
    || pathname.startsWith("/api/jobs/")
    || pathname === "/api/audit"
  );
}

function readCodemanCredentials(): Record<string, { username: string; password: string }> {
  const encoded = process.env.HOSTED_AGENTS_CODEMAN_CREDENTIALS;
  if (!encoded) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(encoded);
  } catch {
    throw new Error("HOSTED_AGENTS_CODEMAN_CREDENTIALS must be valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("HOSTED_AGENTS_CODEMAN_CREDENTIALS must be an object");
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

function selectedInstance(request: IncomingMessage): string | undefined {
  const cookie = request.headers.cookie;
  for (const item of cookie?.split(";") ?? []) {
    const separator = item.indexOf("=");
    if (separator < 1 || item.slice(0, separator).trim() !== CODEMAN_INSTANCE_COOKIE) continue;
    const value = item.slice(separator + 1).trim();
    try {
      return decodeURIComponent(value) || undefined;
    } catch {
      return value || undefined;
    }
  }
  return undefined;
}

function isSecureRequest(request: IncomingMessage): boolean {
  return request.headers["x-forwarded-proto"] === "https" || request.socket.encrypted === true;
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
  const [first, second] = parts.map(Number);
  return first === 100 && second >= 64 && second <= 127;
}

function publicInstance(instance: ReturnType<CodemanHub["getInstance"]>): ReturnType<CodemanHub["getInstance"]> {
  return { ...instance, endpoint: null };
}

function isLoopback(host: string): boolean {
  return host === "127.0.0.1" || host === "::1" || host === "localhost";
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  if (status === 204) {
    response.writeHead(status);
    response.end();
    return;
  }
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(body));
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
<title>Hosted Agents — Sign in</title>
<style>
body{margin:0;min-height:100vh;display:grid;place-items:center;background:#090c10;color:#d7dee7;font:16px system-ui,sans-serif}
main{width:min(360px,calc(100vw - 48px));padding:28px;border:1px solid #253044;border-radius:14px;background:#111722;box-shadow:0 20px 60px #0008}
h1{margin:0 0 8px;font-size:22px}p{color:#98a6ba;margin:0 0 22px}
label{display:grid;gap:8px;color:#b9c5d6}input{padding:12px;border:1px solid #3a465b;border-radius:8px;background:#090c10;color:inherit;font:inherit}
button{width:100%;margin-top:16px;padding:12px;border:0;border-radius:8px;background:#77e0af;color:#07110d;font:600 15px system-ui;cursor:pointer}
#error{min-height:20px;margin-top:12px;color:#ff8585}
</style></head>
<body><main><h1>Hosted Agents</h1><p>Sign in to the private fleet Hub.</p>
<form id="login"><label>Password<input id="password" type="password" autocomplete="current-password" required autofocus></label>
<button type="submit">Sign in</button><div id="error" role="alert"></div></form></main>
<script>
document.getElementById("login").addEventListener("submit",async function(event){
event.preventDefault();const error=document.getElementById("error");error.textContent="";
try{const response=await fetch("/api/auth/login",{method:"POST",credentials:"same-origin",headers:{"content-type":"application/json"},body:JSON.stringify({password:document.getElementById("password").value})});
if(!response.ok)throw new Error((await response.json().catch(function(){return {}})).error||"Sign in failed");
location.assign("/");}catch(cause){error.textContent=cause.message||"Sign in failed";}
});
</script></body></html>`);
}

function rejectUpgrade(
  socket: Socket,
  status: number,
  message: string,
): void {
  if (socket.destroyed) return;
  socket.write(
    `HTTP/1.1 ${status} ${message}\r\n`
    + "Connection: close\r\n"
    + "Content-Type: text/plain; charset=utf-8\r\n"
    + `Content-Length: ${Buffer.byteLength(message)}\r\n\r\n`
    + message,
  );
  socket.destroy();
}

class HttpError extends Error {
  readonly status: number;

  constructor(
    status: number,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
    this.status = status;
  }
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
