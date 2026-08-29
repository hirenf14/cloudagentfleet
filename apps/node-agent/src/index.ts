import type {
  ControlMessage,
  NodeMessage,
  NodeRegistration,
} from "../../../packages/protocol/src/index.ts";

export interface NodeAgentConfig extends NodeRegistration {
  controlPlaneUrl: string;
}

/**
 * The node agent will maintain the outbound connection and host the
 * capability-scoped executors. No listener is opened by this bootstrap.
 */
export function validateConfig(config: NodeAgentConfig): NodeAgentConfig {
  if (!config.nodeId.trim()) {
    throw new Error("nodeId is required");
  }

  const controlPlane = new URL(config.controlPlaneUrl);
  if (controlPlane.protocol !== "https:" && controlPlane.hostname !== "localhost") {
    throw new Error("controlPlaneUrl must use HTTPS outside local development");
  }

  return {
    ...config,
    capabilities: [...new Set(config.capabilities)],
  };
}

export type SendNodeMessage = (message: NodeMessage) => Promise<void>;
export type HandleControlMessage = (message: ControlMessage) => Promise<void>;

export class NodeAgent {
  readonly config: NodeAgentConfig;
  private connected = false;
  private revoked = false;

  constructor(config: NodeAgentConfig) {
    this.config = config;
    validateConfig(config);
  }

  connect(send: SendNodeMessage): void {
    if (this.revoked) throw new Error("Node identity has been revoked");
    this.connected = true;
    this.send = send;
  }

  disconnect(): void {
    this.connected = false;
    this.send = undefined;
  }

  revoke(): void {
    this.revoked = true;
    this.disconnect();
  }

  async heartbeat(): Promise<void> {
    if (!this.connected || !this.send) {
      throw new Error("Node is not connected");
    }
    await this.send({
      type: "heartbeat",
      nodeId: this.config.nodeId,
      sentAt: new Date().toISOString(),
      capabilities: this.config.capabilities,
    });
  }

  async receive(message: ControlMessage, handle: HandleControlMessage): Promise<void> {
    if (this.revoked) throw new Error("Node identity has been revoked");
    await handle(message);
  }

  private send: SendNodeMessage | undefined;
}
