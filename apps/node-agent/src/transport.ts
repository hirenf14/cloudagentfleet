import type {
  ControlMessage,
  NodeMessage,
  NodeRegistration,
} from "../../../packages/protocol/src/index.ts";
import type { NodeAgentConfig } from "./index.ts";

export interface ControllerTransportOptions extends NodeAgentConfig {
  authToken?: string;
  fetchImpl?: typeof fetch;
  heartbeatIntervalMs?: number;
}

/**
 * Outbound-only Worker transport.
 *
 * The Worker registers and posts messages over HTTP, then consumes Controller
 * assignments from an SSE stream. Client machines therefore need no inbound
 * firewall rule or public listener.
 */
export class ControllerTransport {
  private readonly config: ControllerTransportOptions;
  private readonly fetchImpl: typeof fetch;
  private readonly heartbeatIntervalMs: number;
  private readonly abortController = new AbortController();
  private heartbeatTimer: ReturnType<typeof setInterval> | undefined;

  constructor(options: ControllerTransportOptions) {
    this.config = options;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? 15_000;
  }

  async start(handle: (message: ControlMessage) => Promise<void>): Promise<void> {
    await this.register();
    this.heartbeatTimer = setInterval(() => {
      void this.sendHeartbeat();
    }, this.heartbeatIntervalMs);

    try {
      const response = await this.fetchImpl(
        `${this.baseUrl()}/api/workers/${encodeURIComponent(this.config.nodeId)}/connect`,
        {
          headers: this.headers(),
          signal: this.abortController.signal,
        },
      );
      if (!response.ok || !response.body) {
        throw new Error(`Controller connection failed with HTTP ${response.status}`);
      }
      await readServerSentEvents(response.body, handle, this.abortController.signal);
    } finally {
      this.stop();
    }
  }

  stop(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = undefined;
    this.abortController.abort();
  }

  async send(message: NodeMessage): Promise<void> {
    const response = await this.fetchImpl(
      `${this.baseUrl()}/api/workers/${encodeURIComponent(this.config.nodeId)}/messages`,
      {
        method: "POST",
        headers: { ...this.headers(), "content-type": "application/json" },
        body: JSON.stringify(message),
        signal: this.abortController.signal,
      },
    );
    if (!response.ok) throw new Error(`Controller message failed with HTTP ${response.status}`);
  }

  private async register(): Promise<void> {
    const registration: NodeRegistration = {
      nodeId: this.config.nodeId,
      name: this.config.name,
      platform: this.config.platform,
      capabilities: this.config.capabilities,
      labels: this.config.labels,
      workspacePolicy: this.config.workspacePolicy,
      workspaces: this.config.workspaces,
    };
    const response = await this.fetchImpl(`${this.baseUrl()}/api/workers`, {
      method: "POST",
      headers: { ...this.headers(), "content-type": "application/json" },
      body: JSON.stringify(registration),
      signal: this.abortController.signal,
    });
    if (!response.ok) throw new Error(`Controller enrollment failed with HTTP ${response.status}`);
  }

  private async sendHeartbeat(): Promise<void> {
    await this.send({
      type: "heartbeat",
      nodeId: this.config.nodeId,
      sentAt: new Date().toISOString(),
      capabilities: this.config.capabilities,
    });
  }

  private baseUrl(): string {
    return this.config.controlPlaneUrl.endsWith("/")
      ? this.config.controlPlaneUrl.slice(0, -1)
      : this.config.controlPlaneUrl;
  }

  private headers(): Record<string, string> {
    return this.config.authToken
      ? { accept: "text/event-stream, application/json", authorization: `Bearer ${this.config.authToken}` }
      : { accept: "text/event-stream, application/json" };
  }
}

async function readServerSentEvents(
  body: ReadableStream<Uint8Array>,
  handle: (message: ControlMessage) => Promise<void>,
  signal: AbortSignal,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (!signal.aborted) {
    const result = await reader.read();
    if (result.done) return;
    buffer += decoder.decode(result.value, { stream: true });

    let boundary = buffer.indexOf("\n\n");
    while (boundary >= 0) {
      const event = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      boundary = buffer.indexOf("\n\n");

      const data = event
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n");
      if (!data) continue;

      const parsed = JSON.parse(data) as Partial<ControlMessage>;
      if (typeof parsed.type === "string") {
        await handle(parsed as ControlMessage);
      }
    }
  }
}
