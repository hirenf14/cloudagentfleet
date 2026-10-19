import assert from "node:assert/strict";
import test from "node:test";
import type {
  BackendFeature,
  ConnectionMode,
  HostInstance,
} from "../../../packages/protocol/src/index.ts";
import type { HostAdapter } from "./contract.ts";
import { createAdapter, describeBackends, listBackends } from "./registry.ts";

/** Each feature is backed by exactly one facet. */
const FACETS: Partial<Record<BackendFeature, keyof HostAdapter>> = {
  sessions: "sessionControl",
  terminal: "terminalProxy",
  "native-ui-proxy": "nativeUi",
  "workspace-suggest": "pathSuggestions",
};

function fixture(
  backend: HostInstance["backend"],
  connectionMode: ConnectionMode,
  capabilities: string[] = [],
): HostInstance {
  return {
    id: `${backend}-${connectionMode}`,
    label: `${backend} ${connectionMode}`,
    backend,
    connectionMode,
    ...(connectionMode === "connector" ? { nodeId: "worker-1" } : {}),
    endpoint: connectionMode === "connector" ? null : "https://host.tailnet.ts.net",
    status: "offline",
    features: [],
    capabilities,
    agents: [],
    workspaces: [],
    lastSeenAt: null,
    createdAt: new Date(0).toISOString(),
  };
}

const connector = {
  request: async () => undefined,
  subscribeEvents: () => () => undefined,
};

/** Capability variants that select a different adapter shape. */
const VARIANTS: string[][] = [[], ["link"]];

for (const definition of listBackends()) {
  for (const connectionMode of definition.connectionModes) {
    for (const capabilities of VARIANTS) {
      test(`${definition.backend} (${connectionMode}, [${capabilities}]) advertises exactly the facets it implements`, () => {
        const adapter = createAdapter(fixture(definition.backend, connectionMode, capabilities), { connector });
        assert.ok(adapter.features.length > 0, "an adapter must advertise at least one feature");
        for (const feature of adapter.features) {
          assert.ok(
            definition.features(connectionMode).includes(feature),
            `${feature} is not declared by the backend definition`,
          );
        }
        for (const [feature, facet] of Object.entries(FACETS)) {
          assert.equal(
            adapter[facet] !== undefined,
            adapter.features.includes(feature as BackendFeature),
            `feature ${feature} and facet ${facet} must agree`,
          );
        }
        if (adapter.nativeUi) {
          assert.ok(Array.isArray(adapter.nativeUi.browserCookieNames));
        }
      });
    }
  }

  test(`${definition.backend} provides launchable default agents`, () => {
    for (const agent of definition.defaultAgents()) {
      assert.ok(agent.id && agent.name && agent.mode, `incomplete agent ${JSON.stringify(agent)}`);
    }
  });
}

test("createAdapter rejects a connection mode the backend does not support", () => {
  const instance = fixture("codeman", "tailscale-url");
  assert.throws(
    () => createAdapter({ ...instance, connectionMode: "bogus" as ConnectionMode }),
    /does not support connection mode/,
  );
});

test("describeBackends is serializable and lists every backend", () => {
  const summaries = JSON.parse(JSON.stringify(describeBackends())) as ReturnType<typeof describeBackends>;
  assert.deepEqual(
    summaries.map((summary) => summary.backend),
    listBackends().map((definition) => definition.backend),
  );
  assert.ok(summaries[0]?.features["tailscale-url"]?.includes("native-ui-proxy"));
});
