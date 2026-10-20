import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import type { HostInstance } from "../../../../packages/protocol/src/index.ts";
import { CptrLinkAdapter, CptrProxyAdapter } from "./index.ts";

const instance: HostInstance = {
  id: "cptr-1",
  label: "Laptop cptr",
  backend: "cptr",
  connectionMode: "tailscale-url",
  endpoint: "https://laptop.tailnet.ts.net/",
  status: "offline",
  features: [],
  capabilities: ["cptr", "link"],
  agents: [],
  workspaces: [],
  lastSeenAt: null,
  createdAt: new Date(0).toISOString(),
};

test("CptrLinkAdapter probes the unauthenticated health endpoint", async () => {
  const requested: string[] = [];
  const adapter = new CptrLinkAdapter({
    instance,
    fetchImpl: async (url) => {
      requested.push(String(url));
      return Response.json({ status: "ok", uptime_seconds: 3, pid: 1 });
    },
  });
  assert.deepEqual(await adapter.listAgents(), []);
  assert.deepEqual(requested, ["https://laptop.tailnet.ts.net/api/health"]);
  assert.deepEqual([...adapter.features], ["native-ui-link"]);
});

test("CptrLinkAdapter reports an unhealthy instance", async () => {
  const down = new CptrLinkAdapter({
    instance,
    fetchImpl: async () => new Response("bad gateway", { status: 502 }),
  });
  await assert.rejects(() => down.listAgents(), /HTTP 502/);

  const wrong = new CptrLinkAdapter({
    instance,
    fetchImpl: async () => Response.json({ hello: "world" }),
  });
  await assert.rejects(() => wrong.listAgents(), /unexpected body/);
});

test("CptrProxyAdapter bridges only cptr's session cookie and never alters its pages", async () => {
  const seen: { cookie?: string; referer?: string; authorization?: string } = {};
  const upstream = createServer((request, response) => {
    seen.cookie = request.headers.cookie;
    seen.referer = request.headers.referer;
    seen.authorization = request.headers.authorization;
    response.writeHead(200, {
      "content-type": "text/html",
      "set-cookie": ["cptr_session=new-jwt; HttpOnly; Path=/; SameSite=lax", "other=1; Path=/"],
    });
    response.end("<html><body>Open WebUI Computer</body></html>");
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", () => resolve()));
  const port = (upstream.address() as AddressInfo).port;
  const adapter = new CptrProxyAdapter({
    instance: { ...instance, endpoint: `http://127.0.0.1:${port}` },
  });
  const hub = createServer((request, response) => void adapter.proxyHttp(request, response));
  await new Promise<void>((resolve) => hub.listen(0, "127.0.0.1", () => resolve()));
  const hubPort = (hub.address() as AddressInfo).port;
  try {
    const [browserCookie] = adapter.browserCookieNames;
    const response = await fetch(`http://127.0.0.1:${hubPort}/`, {
      headers: {
        cookie: `cloudagentfleet_session=hub-secret; ${browserCookie}=old-jwt`,
        referer: `http://127.0.0.1:${hubPort}/api/browser/frame/1/https/example.com/`,
        authorization: "Bearer hub-token",
      },
    });
    assert.equal(await response.text(), "<html><body>Open WebUI Computer</body></html>");
    assert.equal(seen.cookie, "cptr_session=old-jwt");
    assert.match(seen.referer ?? "", /\/api\/browser\/frame\//);
    assert.equal(seen.authorization, undefined);
    assert.deepEqual(response.headers.getSetCookie(), [
      `${browserCookie}=new-jwt; HttpOnly; Path=/; SameSite=lax`,
    ]);
    // A page cached while signed in must not be reused after Hub logout.
    assert.equal(response.headers.get("vary"), "Cookie");
    assert.equal(response.headers.get("cache-control"), "private, no-cache");
  } finally {
    hub.close();
    upstream.close();
  }
});

test("CptrProxyAdapter signs a Hub browser in to cptr with a session from the Worker", async () => {
  const upstreamCookies: Array<string | undefined> = [];
  const upstream = createServer((request, response) => {
    upstreamCookies.push(request.headers.cookie);
    response.writeHead(200, { "content-type": "text/html" });
    response.end("ok");
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", () => resolve()));
  const port = (upstream.address() as AddressInfo).port;
  let now = 1_000_000;
  let signIns = 0;
  let answer: unknown = { token: "aaa.bbb.ccc", expiresAt: now + 3_600_000 };
  const adapter = new CptrProxyAdapter({
    instance: { ...instance, endpoint: `http://127.0.0.1:${port}` },
    signIn: async () => {
      signIns += 1;
      if (answer instanceof Error) throw answer;
      return answer;
    },
    now: () => now,
  });
  const hub = createServer((request, response) => void adapter.proxyHttp(request, response));
  await new Promise<void>((resolve) => hub.listen(0, "127.0.0.1", () => resolve()));
  const url = `http://127.0.0.1:${(hub.address() as AddressInfo).port}/`;
  const [browserCookie] = adapter.browserCookieNames;
  try {
    const first = await fetch(url);
    assert.equal(upstreamCookies.at(-1), "cptr_session=aaa.bbb.ccc");
    assert.deepEqual(first.headers.getSetCookie(), [
      `${browserCookie}=aaa.bbb.ccc; HttpOnly; Path=/; SameSite=Lax; Max-Age=3600`,
    ]);

    // A browser that has its cptr cookie keeps using it; another reuses the cached session.
    const second = await fetch(url, { headers: { cookie: `${browserCookie}=own.jwt.x` } });
    assert.equal(upstreamCookies.at(-1), "cptr_session=own.jwt.x");
    assert.deepEqual(second.headers.getSetCookie(), []);
    await fetch(url);
    assert.equal(signIns, 1);

    // A failed or malformed sign-in shows cptr's own login, and is not retried at once.
    now += 3_600_000;
    answer = { token: "bad; Domain=evil.example", expiresAt: now + 3_600_000 };
    const refused = await fetch(url);
    assert.equal(upstreamCookies.at(-1), undefined);
    assert.deepEqual(refused.headers.getSetCookie(), []);
    answer = new Error("Worker has no credentials");
    await fetch(url);
    assert.equal(signIns, 2, "no retry within the back-off window");
    now += 61_000;
    answer = { token: "ddd.eee.fff", expiresAt: now + 3_600_000 };
    await fetch(url);
    assert.equal(upstreamCookies.at(-1), "cptr_session=ddd.eee.fff");
  } finally {
    hub.close();
    upstream.close();
  }
});
