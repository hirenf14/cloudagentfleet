import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { createHash, randomBytes } from "node:crypto";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import type { CookieBridge } from "./cookies.ts";
import { verifyUpstreamTls } from "./tls.ts";

export interface ProxyWebSocketOptions {
  endpoint: URL;
  /** Upstream path including any query string. */
  path: string;
  authorization?: string;
  /** Upstream product name used in rejection messages. */
  label: string;
  /** Allowlisted backend session cookies to forward on the upgrade. */
  cookies?: CookieBridge;
  /** Upstream connection override (a Worker tunnel stream) instead of dialing `endpoint`. */
  connect?: () => Duplex;
}

/**
 * Completes the browser's WebSocket upgrade against an upstream endpoint and
 * relays frames byte-for-byte. Frames are never parsed or rewritten.
 */
export async function proxyWebSocket(
  request: IncomingMessage,
  clientSocket: Duplex,
  head: Buffer,
  options: ProxyWebSocketOptions,
): Promise<void> {
  const { endpoint, label } = options;
  const transport = endpoint.protocol === "https:" && !options.connect ? httpsRequest : httpRequest;
  const browserKey = request.headers["sec-websocket-key"];
  if (typeof browserKey !== "string") {
    rejectSocket(clientSocket, 400, "Missing WebSocket key");
    return;
  }
  const headers: Record<string, string> = {
    connection: "Upgrade",
    upgrade: "websocket",
    "sec-websocket-version": "13",
    "sec-websocket-key": randomBytes(16).toString("base64"),
  };
  if (options.authorization) headers.authorization = options.authorization;
  const protocol = request.headers["sec-websocket-protocol"];
  if (typeof protocol === "string") headers["sec-websocket-protocol"] = protocol;
  const upstreamCookie = options.cookies?.toUpstream(request.headers.cookie);
  if (upstreamCookie) headers.cookie = upstreamCookie;
  const upstreamRequest = transport({
    hostname: endpoint.hostname,
    port: endpoint.port || undefined,
    path: options.path,
    method: "GET",
    headers,
    rejectUnauthorized: verifyUpstreamTls(endpoint),
    ...(options.connect ? { createConnection: options.connect } : {}),
  });
  upstreamRequest.once("upgrade", (response, upstreamSocket, upstreamHead) => {
    if (response.statusCode !== 101) {
      upstreamSocket.destroy();
      rejectSocket(clientSocket, response.statusCode ?? 502, `${label} WebSocket rejected`);
      return;
    }
    const accept = createHash("sha1")
      .update(`${browserKey}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest("base64");
    const acceptedProtocol = response.headers["sec-websocket-protocol"];
    clientSocket.write(
      "HTTP/1.1 101 Switching Protocols\r\n"
      + "Upgrade: websocket\r\n"
      + "Connection: Upgrade\r\n"
      + (typeof acceptedProtocol === "string" ? `Sec-WebSocket-Protocol: ${acceptedProtocol}\r\n` : "")
      + `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    if (head.length > 0) upstreamSocket.write(head);
    if (upstreamHead.length > 0) clientSocket.write(upstreamHead);
    relaySockets(clientSocket, upstreamSocket);
  });
  upstreamRequest.once("response", (response) => {
    response.resume();
    rejectSocket(clientSocket, response.statusCode ?? 502, `${label} WebSocket unavailable`);
  });
  upstreamRequest.once("error", () => rejectSocket(clientSocket, 502, `${label} WebSocket unavailable`));
  upstreamRequest.end();
}

/** Writes a plain HTTP error on a socket that has not been upgraded, then closes it. */
export function rejectSocket(socket: Duplex, status: number, message: string): void {
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

function relaySockets(clientSocket: Duplex, upstreamSocket: Duplex): void {
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    clientSocket.destroy();
    upstreamSocket.destroy();
  };
  clientSocket.on("data", (chunk: Buffer) => {
    if (!upstreamSocket.destroyed) upstreamSocket.write(chunk);
  });
  upstreamSocket.on("data", (chunk: Buffer) => {
    if (!clientSocket.destroyed) clientSocket.write(chunk);
  });
  clientSocket.on("error", close);
  clientSocket.on("close", close);
  upstreamSocket.on("error", close);
  upstreamSocket.on("close", close);
}
