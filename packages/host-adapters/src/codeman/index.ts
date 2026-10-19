import {
  CODEMAN_AGENT_MODES,
  codemanAgentName,
} from "../../../../packages/protocol/src/index.ts";
import type { BackendDefinition } from "../contract.ts";
import {
  CODEMAN_CONNECTOR_FEATURES,
  CODEMAN_HTTP_FEATURES,
  CodemanConnectorAdapter,
  CodemanHttpAdapter,
} from "./adapters.ts";

export const codemanBackend: BackendDefinition = {
  backend: "codeman",
  label: "Codeman",
  connectionModes: ["tailscale-url", "connector"],
  features: (connectionMode) => connectionMode === "connector"
    ? CODEMAN_CONNECTOR_FEATURES
    : CODEMAN_HTTP_FEATURES,
  defaultAgents: () => CODEMAN_AGENT_MODES.map((mode) => ({
    id: mode,
    name: codemanAgentName(mode, mode),
    mode,
    ready: true,
  })),
  createAdapter(instance, { credentials, connector }) {
    if (instance.connectionMode === "connector") {
      if (!connector) throw new Error(`Connector is not configured: ${instance.id}`);
      return new CodemanConnectorAdapter({ instance, ...connector });
    }
    return new CodemanHttpAdapter({ instance, ...(credentials ?? {}) });
  },
};

export {
  CodemanConnectorAdapter,
  CodemanHttpAdapter,
  type CodemanConnectorAdapterOptions,
  type CodemanHttpAdapterOptions,
} from "./adapters.ts";
export * from "./wire.ts";
