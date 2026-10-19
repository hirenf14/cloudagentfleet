import assert from "node:assert/strict";
import test from "node:test";
import type { HostInstance } from "../../../../packages/protocol/src/index.ts";
import { CptrLinkAdapter } from "./index.ts";

const instance: HostInstance = {
  id: "cptr-1",
  label: "Laptop cptr",
  backend: "cptr",
  connectionMode: "tailscale-url",
  endpoint: "https://laptop.tailnet.ts.net/",
  status: "offline",
  features: [],
  capabilities: ["cptr"],
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
