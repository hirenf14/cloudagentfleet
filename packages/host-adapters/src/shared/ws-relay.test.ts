import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import test from "node:test";
import { namespacedCookieBridge } from "./cookies.ts";
import { proxyWebSocket } from "./ws-relay.ts";

test("proxyWebSocket forwards subprotocol and bridged cookies, then relays bytes", async () => {
  const seen: { path?: string; cookie?: string; protocol?: string } = {};
  const sockets: Socket[] = [];
  const upstream = createServer();
  upstream.on("upgrade", (request, socket: Socket) => {
    sockets.push(socket);
    seen.path = request.url;
    seen.cookie = request.headers.cookie;
    seen.protocol = request.headers["sec-websocket-protocol"] as string | undefined;
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
      + "Sec-WebSocket-Protocol: binary\r\nSec-WebSocket-Accept: ignored\r\n\r\n",
    );
    socket.on("data", (chunk) => socket.write(Buffer.concat([Buffer.from("echo:"), chunk])));
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", () => resolve()));
  const bridge = namespacedCookieBridge("box", ["cptr_session"]);

  const hub = createServer();
  hub.on("upgrade", (request, socket, head) => {
    sockets.push(socket as Socket);
    void proxyWebSocket(request, socket, head, {
      endpoint: new URL(`http://127.0.0.1:${(upstream.address() as AddressInfo).port}`),
      path: request.url ?? "/",
      label: "Test",
      cookies: bridge,
    });
  });
  await new Promise<void>((resolve) => hub.listen(0, "127.0.0.1", () => resolve()));

  try {
    const { response, socket } = await new Promise<{ response: { statusCode?: number; headers: Record<string, unknown> }; socket: Socket }>((resolve, reject) => {
      const client = httpRequest({
        hostname: "127.0.0.1",
        port: (hub.address() as AddressInfo).port,
        path: "/socket.io/?EIO=4&transport=websocket",
        headers: {
          connection: "Upgrade",
          upgrade: "websocket",
          "sec-websocket-version": "13",
          "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
          "sec-websocket-protocol": "binary",
          cookie: "cloudagentfleet_session=hub-secret; cf_box_cptr_session=jwt",
        },
      });
      client.once("upgrade", (upgradeResponse, upgradedSocket) => resolve({ response: upgradeResponse, socket: upgradedSocket }));
      client.once("error", reject);
      client.end();
    });
    assert.equal(response.statusCode, 101);
    assert.equal(response.headers["sec-websocket-protocol"], "binary");
    assert.equal(
      response.headers["sec-websocket-accept"],
      "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=",
      "the accept key must answer the browser's key, not the upstream's",
    );
    assert.equal(seen.path, "/socket.io/?EIO=4&transport=websocket");
    assert.equal(seen.cookie, "cptr_session=jwt");
    assert.equal(seen.protocol, "binary");

    const echoed = await new Promise<string>((resolve) => {
      socket.once("data", (chunk: Buffer) => resolve(chunk.toString()));
      socket.write("ping");
    });
    assert.equal(echoed, "echo:ping");
    sockets.push(socket);
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => hub.close(() => resolve()));
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  }
});
