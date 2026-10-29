import type {
  CodemanConnectorRequest,
  CodemanConnectorResponse,
  ControlMessage,
  NodeMessage,
  NodeRegistration,
} from "../../../packages/protocol/src/index.ts";
import {
  isCodemanConnectorRequest,
  isTunnelMessage,
  type TunnelMessage,
} from "../../../packages/protocol/src/index.ts";
import type { NodeAgentConfig } from "./index.ts";

export interface ControllerTransportOptions extends NodeAgentConfig {
  authToken?: string;
  fetchImpl?: typeof fetch;
  heartbeatIntervalMs?: number;
  reconnect?: boolean;
  reconnectDelayMs?: number;
  /** Instances this Worker serves over the connector (Codeman, and its cptr driver). */
  connectorInstanceId?: string | readonly string[];
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
  private readonly reconnect: boolean;
  private readonly reconnectDelayMs: number;
  private readonly connectorInstanceIds?: ReadonlySet<string>;
  private readonly handledConnectorRequests = new Set<string>();
  private readonly abortController = new AbortController();
  private heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  /** Set when the Controller stops recognising this node (for example after it restarted). */
  private needsRegistration = false;

  constructor(options: ControllerTransportOptions) {
    this.config = options;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? 15_000;
    this.reconnect = options.reconnect ?? false;
    this.reconnectDelayMs = options.reconnectDelayMs ?? 1_000;
    this.connectorInstanceIds = options.connectorInstanceId === undefined
      ? undefined
      : new Set(typeof options.connectorInstanceId === "string" ? [options.connectorInstanceId] : options.connectorInstanceId);
  }

  async start(
    handle: (message: ControlMessage) => Promise<void>,
    connectorHandle?: (request: CodemanConnectorRequest) => Promise<unknown>,
    tunnelHandle?: (message: TunnelMessage) => void,
  ): Promise<void> {
    await this.register();
    this.heartbeatTimer = setInterval(() => {
      void this.heartbeatTick();
    }, this.heartbeatIntervalMs);

    let firstAttempt = true;
    try {
      do {
        try {
          // A Controller restart forgets enrolled nodes (its registry is in
          // memory), so every reconnect enrolls again before connecting.
          if (!firstAttempt) await this.register();
          firstAttempt = false;
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
          await readServerSentEvents(
            response.body,
            handle,
            this.abortController.signal,
            (request) => this.handleConnectorRequest(request, connectorHandle),
            tunnelHandle,
          );
        } catch (error) {
          if (!this.reconnect || this.abortController.signal.aborted) throw error;
        }
        if (!this.reconnect || this.abortController.signal.aborted) break;
        await delay(this.reconnectDelayMs, this.abortController.signal);
      } while (!this.abortController.signal.aborted);
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

  private async handleConnectorRequest(
    raw: Record<string, unknown>,
    connectorHandle?: (request: CodemanConnectorRequest) => Promise<unknown>,
  ): Promise<void> {
    // A request this Worker does not understand (an operation added after this
    // build) is answered with an error; throwing here would drop the stream.
    if (!isCodemanConnectorRequest(raw)) {
      const { requestId, instanceId } = raw;
      if (typeof requestId !== "string" || typeof instanceId !== "string" || !requestId || !instanceId) {
        console.error("Ignoring a connector request without a request or instance id");
        return;
      }
      const operation = typeof raw.operation === "string" ? raw.operation : "unknown";
      await this.send({
        type: "codeman.response",
        requestId,
        instanceId,
        success: false,
        error: `Connector operation is not supported by this Worker: ${operation}`,
        errorCode: "connector_operation_unsupported",
      });
      return;
    }
    const request = raw;
    const response: CodemanConnectorResponse = {
      type: "codeman.response",
      requestId: request.requestId,
      instanceId: request.instanceId,
      success: false,
      error: "Connector is not enabled",
      errorCode: "connector_disabled",
    };
    try {
      // usage.read is about the machine, not a connector instance, so it needs no instance match.
      if (request.operation !== "usage.read" && this.connectorInstanceIds && !this.connectorInstanceIds.has(request.instanceId)) {
        throw new Error("Connector instance authorization failed");
      }
      if (this.handledConnectorRequests.has(request.requestId)) {
        throw new Error("Duplicate connector request");
      }
      this.handledConnectorRequests.add(request.requestId);
      if (this.handledConnectorRequests.size > 1_000) {
        const oldest = this.handledConnectorRequests.values().next().value;
        if (typeof oldest === "string") this.handledConnectorRequests.delete(oldest);
      }
      if (!connectorHandle) throw new Error("Connector is not enabled");
      response.success = true;
      response.data = await connectorHandle(request);
      delete response.error;
      delete response.errorCode;
    } catch (error) {
      response.error = error instanceof Error ? error.message : "Connector request failed";
      response.errorCode = "connector_request_failed";
    }
    await this.send(response);
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
    this.needsRegistration = false;
  }

  /** Never throws: a failed heartbeat schedules re-enrollment instead of crashing the Worker. */
  private async heartbeatTick(): Promise<void> {
    try {
      if (this.needsRegistration) await this.register();
      await this.sendHeartbeat();
    } catch {
      if (!this.abortController.signal.aborted) this.needsRegistration = true;
    }
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
  handleConnectorRequest: (request: Record<string, unknown>) => Promise<void>,
  tunnelHandle?: (message: TunnelMessage) => void,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (!signal.aborted) {
    const result = await reader.read();
    if (result.done) return;
    buffer += decoder.decode(result.value, { stream: true });

    let boundary = sseBoundary(buffer);
    while (boundary) {
      const event = buffer.slice(0, boundary.index);
      buffer = buffer.slice(boundary.index + boundary.length);
      boundary = sseBoundary(buffer);

      const data = event
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n");
      if (!data) continue;

      const parsed = JSON.parse(data) as Partial<ControlMessage>;
      // Dispatch without awaiting: a long job or a slow connector request must
      // not stall the rest of the stream (tunnel bytes above all). Each request
      // is correlated by its own id, so ordering between them does not matter.
      if (isTunnelMessage(parsed)) {
        tunnelHandle?.(parsed);
      } else if (parsed.type === "codeman.request") {
        const request = parsed as Record<string, unknown>;
        void handleConnectorRequest(request).catch((error: unknown) => {
          console.error(`Connector request ${String(request.requestId)} failed: ${error instanceof Error ? error.message : error}`);
        });
      } else if (typeof parsed.type === "string") {
        void handle(parsed as ControlMessage).catch((error: unknown) => {
          console.error(`Controller message ${parsed.type} failed: ${error instanceof Error ? error.message : error}`);
        });
      }
    }
  }
}

function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, milliseconds);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(signal.reason ?? new Error("Operation aborted"));
    }, { once: true });
  });
}

function sseBoundary(value: string): { index: number; length: number } | undefined {
  const lineFeed = value.indexOf("\n\n");
  const carriageReturn = value.indexOf("\r\n\r\n");
  if (lineFeed < 0 && carriageReturn < 0) return undefined;
  if (lineFeed < 0) return { index: carriageReturn, length: 4 };
  if (carriageReturn < 0 || lineFeed < carriageReturn) {
    return { index: lineFeed, length: 2 };
  }
  return { index: carriageReturn, length: 4 };
}
