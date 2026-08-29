import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { ControlPlane } from "./index.ts";
import type {
  CreateJobRequest,
  NodeHeartbeat,
  NodeMessage,
  NodeRegistration,
} from "../../../packages/protocol/src/index.ts";

const MAX_BODY_BYTES = 1_048_576;

export interface ControllerServerOptions {
  host?: string;
  port?: number;
  authToken?: string;
  controlPlane?: ControlPlane;
}

export interface ControllerServer {
  server: Server;
  controlPlane: ControlPlane;
  host: string;
  port: number;
}

export function startControllerServer(
  options: ControllerServerOptions = {},
): ControllerServer {
  const controller = createControllerServer(options);
  controller.server.listen(controller.port, controller.host, () => {
    console.log(`Hosted Agents Controller listening on ${controller.host}:${controller.port}`);
  });
  return controller;
}

export function createControllerServer(
  options: ControllerServerOptions = {},
): ControllerServer {
  const host = options.host ?? process.env.HOSTED_AGENTS_HOST ?? "127.0.0.1";
  const port = options.port ?? Number(process.env.HOSTED_AGENTS_PORT ?? 8787);
  const authToken = options.authToken ?? process.env.HOSTED_AGENTS_AUTH_TOKEN;
  const controlPlane = options.controlPlane ?? new ControlPlane();

  if (!isLoopback(host) && !authToken) {
    throw new Error("A bearer token is required when the Controller binds beyond loopback");
  }

  const server = createServer(async (request, response) => {
    try {
      if (!authorize(request, authToken)) {
        sendJson(response, 401, { error: "Unauthorized" });
        return;
      }

      await route(request, response, controlPlane);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Request failed";
      sendJson(response, 400, { error: message });
    }
  });

  return { server, controlPlane, host, port };
}

async function route(
  request: IncomingMessage,
  response: ServerResponse,
  controlPlane: ControlPlane,
): Promise<void> {
  const method = request.method ?? "GET";
  const url = new URL(request.url ?? "/", "http://controller.local");

  if (method === "GET" && url.pathname === "/healthz") {
    sendJson(response, 200, {
      ok: true,
      role: "controller",
      execution: "workers-only",
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
    controlPlane.registerConnection({
      node,
      send: async (message) => {
        if (!response.writableEnded) {
          response.write(`data: ${JSON.stringify(message)}\n\n`);
        }
      },
      close: async () => {
        if (!response.writableEnded) response.end();
      },
    });
    response.on("close", () => controlPlane.removeConnection(nodeId));
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
    sendJson(response, 200, { events: controlPlane.audit.list() });
    return;
  }

  sendJson(response, 404, { error: "Not found" });
}

function authorize(request: IncomingMessage, authToken?: string): boolean {
  if (!authToken) return true;
  return request.headers.authorization === `Bearer ${authToken}`;
}

function isLoopback(host: string): boolean {
  return host === "127.0.0.1" || host === "::1" || host === "localhost";
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(body));
}

async function readJson<T>(request: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  let size = 0;

  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new Error("Request body is too large");
    chunks.push(buffer);
  }

  if (chunks.length === 0) throw new Error("Request body is required");
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as T;
}

if (process.argv[1]?.endsWith("/server.ts") || process.argv[1]?.endsWith("\\server.ts")) {
  startControllerServer();
}
