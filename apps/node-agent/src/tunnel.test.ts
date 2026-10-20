import assert from "node:assert/strict";
import { createServer, request as httpRequest, type IncomingMessage } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import test from "node:test";
import type { ControlMessage, NodeMessage } from "../../../packages/protocol/src/index.ts";
import { isTunnelMessage } from "../../../packages/protocol/src/index.ts";
import { TunnelBroker } from "../../control-plane/src/tunnel.ts";
import { WorkerTunnels } from "./tunnel.ts";

/** Wires a Hub broker to a Worker endpoint the way the connector transport does. */
function wire(targetPort: number, instanceId = "box-cptr") {
  const broker = new TunnelBroker();
  const workerMessages: NodeMessage[] = [];
  const worker = new WorkerTunnels({
    targets: new Map([[instanceId, { host: "127.0.0.1", port: targetPort }]]),
    send: async (message) => {
      workerMessages.push(message);
      await new Promise((resolve) => setImmediate(resolve));
      if (isTunnelMessage(message)) broker.receive("node-1", message);
    },
  });
  const hubSend = async (message: ControlMessage) => {
    await new Promise((resolve) => setImmediate(resolve));
    if (isTunnelMessage(message)) worker.handle(message);
  };
  return { broker, worker, workerMessages, open: (id = instanceId) => broker.open("node-1", id, hubSend) };
}

function get(connect: () => ReturnType<TunnelBroker["open"]>, path: string, body?: string) {
  return new Promise<{ status: number; text: string }>((resolve, reject) => {
    const request = httpRequest({
      host: "cptr.connector",
      path,
      method: body ? "POST" : "GET",
      headers: { connection: "close", ...(body ? { "content-type": "text/plain" } : {}) },
      createConnection: connect,
    }, (response: IncomingMessage) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => resolve({ status: response.statusCode ?? 0, text: Buffer.concat(chunks).toString() }));
    });
    request.on("error", reject);
    request.end(body);
  });
}

test("HTTP requests and large bodies cross the Worker tunnel intact", async () => {
  const big = "x".repeat(700 * 1024);
  const upstream = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const received = Buffer.concat(chunks).toString();
      response.writeHead(200, { "content-type": "text/plain" });
      response.end(request.url === "/big" ? big : `${request.method} ${request.url} ${received.length}`);
    });
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const { open } = wire((upstream.address() as AddressInfo).port);
  try {
    assert.deepEqual(await get(() => open(), "/api/health"), { status: 200, text: "GET /api/health 0" });
    assert.deepEqual(await get(() => open(), "/upload", big), { status: 200, text: `POST /upload ${big.length}` });
    const download = await get(() => open(), "/big");
    assert.equal(download.text.length, big.length, "a response larger than one tunnel chunk arrives whole");
  } finally {
    upstream.close();
  }
});

test("WebSocket upgrades relay raw bytes through the tunnel", async () => {
  const sockets: Socket[] = [];
  const upstream = createServer();
  upstream.on("upgrade", (_request, socket: Socket) => {
    sockets.push(socket);
    socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n");
    socket.on("data", (chunk) => socket.write(Buffer.concat([Buffer.from("echo:"), chunk])));
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const { open } = wire((upstream.address() as AddressInfo).port);
  try {
    const echoed = await new Promise<string>((resolve, reject) => {
      const request = httpRequest({
        host: "cptr.connector",
        path: "/socket.io/?EIO=4&transport=websocket",
        headers: { connection: "Upgrade", upgrade: "websocket" },
        createConnection: () => open(),
      });
      request.on("upgrade", (response, socket) => {
        assert.equal(response.statusCode, 101);
        socket.once("data", (chunk: Buffer) => {
          resolve(chunk.toString());
          socket.destroy();
        });
        socket.write("frame-bytes");
      });
      request.on("error", reject);
      request.end();
    });
    assert.equal(echoed, "echo:frame-bytes");
  } finally {
    for (const socket of sockets) socket.destroy();
    upstream.close();
  }
});

test("the Hub cannot tunnel to anything but the configured instance", async () => {
  const { open } = wire(9);
  await assert.rejects(() => get(() => open("other-instance"), "/"), /No tunnel target for connector instance other-instance/);
});
