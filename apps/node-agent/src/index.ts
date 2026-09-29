import type {
  NodeRegistration,
} from "../../../packages/protocol/src/index.ts";

export interface NodeAgentConfig extends NodeRegistration {
  controlPlaneUrl: string;
  authToken?: string;
}

/**
 * Validates Worker config. The runtime opens no inbound listener; it only
 * dials the Controller outbound.
 */
export function validateConfig(config: NodeAgentConfig): NodeAgentConfig {
  if (!config.nodeId.trim()) {
    throw new Error("nodeId is required");
  }

  const controlPlane = new URL(config.controlPlaneUrl);
  const localHost = ["localhost", "127.0.0.1", "::1"].includes(controlPlane.hostname);
  if (controlPlane.protocol !== "https:" && !localHost) {
    throw new Error("controlPlaneUrl must use HTTPS outside local development");
  }

  return {
    ...config,
    capabilities: [...new Set(config.capabilities)],
  };
}
