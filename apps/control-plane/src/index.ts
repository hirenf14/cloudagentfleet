import { AuditLog, JobStore, NodeRegistry } from "../../../packages/protocol/src/lifecycle.ts";
import type {
  AgentJob,
  ControlMessage,
  CodemanConnectorOperation,
  CodemanConnectorRequest,
  CodemanConnectorSessionEvent,
  CodemanConnectorResponse,
  CodemanSessionEvent,
  CreateJobRequest,
  HostedNode,
  NodeMessage,
  NodeHeartbeat,
  NodeRegistration,
} from "../../../packages/protocol/src/index.ts";
import {
  validateCodemanConnectorResponse,
  validateCodemanConnectorSessionEvent,
} from "../../../packages/protocol/src/index.ts";

export interface NodeConnection {
  node: HostedNode;
  send(message: ControlMessage): Promise<void>;
  close(): Promise<void>;
}

interface PendingConnectorRequest {
  nodeId: string;
  instanceId: string;
  timer: ReturnType<typeof setTimeout>;
  resolve: (data: unknown) => void;
  reject: (error: Error) => void;
}

export class ControlPlane {
  readonly nodes: NodeRegistry;
  readonly jobs: JobStore;
  readonly audit: AuditLog;
  private readonly connections = new Map<string, NodeConnection>();
  private readonly connectorRequests = new Map<string, PendingConnectorRequest>();
  private readonly connectorEventListeners = new Map<
    string,
    Set<(event: CodemanSessionEvent) => void>
  >();

  constructor() {
    this.nodes = new NodeRegistry();
    this.jobs = new JobStore();
    this.audit = new AuditLog();
  }

  enrollNode(registration: NodeRegistration): HostedNode {
    const node = this.nodes.enroll(registration);
    this.audit.append("node.enrolled", "node", node.id, { name: node.name });
    return node;
  }

  heartbeatNode(heartbeat: NodeHeartbeat): HostedNode {
    const node = this.nodes.heartbeat(heartbeat);
    this.audit.append("node.heartbeat", "node", node.id);
    return node;
  }

  registerConnection(connection: NodeConnection): void {
    if (connection.node.status === "revoked") {
      throw new Error(`Cannot register revoked node: ${connection.node.id}`);
    }
    const existing = this.connections.get(connection.node.id);
    void existing?.close();
    if (existing) this.rejectConnectorRequests(connection.node.id, "Worker connection replaced");
    this.connections.set(connection.node.id, connection);
  }

  removeConnection(nodeId: string, connection?: NodeConnection): void {
    if (connection && this.connections.get(nodeId) !== connection) return;
    this.connections.delete(nodeId);
    this.rejectConnectorRequests(nodeId, `Worker connection closed: ${nodeId}`);
  }

  receiveNodeMessage(nodeId: string, message: NodeMessage): void {
    if (message.type === "codeman.response") {
      this.receiveConnectorResponse(nodeId, message);
      return;
    }
    if (message.type === "codeman.session.event") {
      this.receiveConnectorEvent(nodeId, message);
      return;
    }
    if (message.type === "heartbeat") {
      this.heartbeatNode({ ...message, nodeId });
      return;
    }

    if (message.type !== "job.accept" && message.type !== "job.event") return;
    const jobId = message.jobId;

    const job = this.jobs.get(jobId);
    if (!job) throw new Error(`Unknown job: ${jobId}`);
    if (job.nodeId !== nodeId) {
      throw new Error(`Job ${jobId} is assigned to a different node`);
    }

    if (message.type === "job.accept") {
      this.jobs.start(jobId);
      return;
    }

    if (message.event === "started") {
      this.jobs.start(jobId);
      this.audit.append("job.started", "node", jobId, { nodeId });
    } else if (message.event === "completed") {
      this.jobs.complete(jobId);
      this.audit.append("job.completed", "node", jobId, { nodeId });
    } else if (message.event === "failed") {
      this.jobs.fail(jobId);
      this.audit.append("job.failed", "node", jobId, { nodeId });
    } else if (message.event === "cancelled") {
      if (job.status !== "cancelled") this.jobs.cancel(jobId);
      this.audit.append("job.cancelled", "node", jobId, { nodeId });
    }
  }

  async requestConnector(
    nodeId: string,
    instanceId: string,
    operation: CodemanConnectorOperation,
    payload?: Record<string, unknown>,
    timeoutMs = 15_000,
  ): Promise<unknown> {
    const connection = this.connections.get(nodeId);
    if (!connection) throw new Error(`Node has no active connection: ${nodeId}`);
    if (connection.node.status === "revoked") {
      throw new Error(`Node is revoked: ${nodeId}`);
    }
    const requestId = crypto.randomUUID();
    const request: CodemanConnectorRequest = {
      type: "codeman.request",
      requestId,
      instanceId,
      operation,
      ...(payload === undefined ? {} : { payload }),
    };
    const result = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.connectorRequests.delete(requestId);
        reject(new Error(`Connector request timed out: ${operation}`));
      }, timeoutMs);
      this.connectorRequests.set(requestId, {
        nodeId,
        instanceId,
        timer,
        resolve,
        reject,
      });
    });
    try {
      await connection.send(request);
    } catch (error) {
      const pending = this.connectorRequests.get(requestId);
      if (pending) {
        clearTimeout(pending.timer);
        this.connectorRequests.delete(requestId);
        pending.reject(error instanceof Error ? error : new Error("Connector request failed"));
      }
    }
    return result;
  }

  subscribeConnectorEvents(
    nodeId: string,
    instanceId: string,
    listener: (event: CodemanSessionEvent) => void,
  ): () => void {
    const key = connectorKey(nodeId, instanceId);
    const listeners = this.connectorEventListeners.get(key) ?? new Set();
    listeners.add(listener);
    this.connectorEventListeners.set(key, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.connectorEventListeners.delete(key);
    };
  }

  private receiveConnectorResponse(
    nodeId: string,
    message: CodemanConnectorResponse,
  ): void {
    validateCodemanConnectorResponse(message);
    const pending = this.connectorRequests.get(message.requestId);
    if (!pending) throw new Error(`Unknown connector request: ${message.requestId}`);
    if (pending.nodeId !== nodeId || pending.instanceId !== message.instanceId) {
      throw new Error("Connector response authorization failed");
    }
    clearTimeout(pending.timer);
    this.connectorRequests.delete(message.requestId);
    if (message.success) {
      pending.resolve(message.data);
    } else {
      pending.reject(new Error(message.error ?? "Connector request failed"));
    }
  }

  private receiveConnectorEvent(
    nodeId: string,
    message: CodemanConnectorSessionEvent,
  ): void {
    validateCodemanConnectorSessionEvent(message);
    const listeners = this.connectorEventListeners.get(connectorKey(nodeId, message.instanceId));
    if (!listeners) return;
    for (const listener of listeners) listener(message.event);
  }

  private rejectConnectorRequests(nodeId: string, reason: string): void {
    for (const [requestId, pending] of this.connectorRequests) {
      if (pending.nodeId !== nodeId) continue;
      clearTimeout(pending.timer);
      pending.reject(new Error(reason));
      this.connectorRequests.delete(requestId);
    }
  }

  async createJob(request: CreateJobRequest): Promise<AgentJob> {
    const existing = this.jobs.getByIdempotencyKey(request.idempotencyKey);
    if (existing) return existing;

    const node = this.nodes.select(request.provider, request.nodeId);
    this.nodes.selectWorkspace(node.id, request.workspaceId, request.provider);
    const connection = this.connections.get(node.id);
    if (!connection) throw new Error(`Node has no active connection: ${node.id}`);

    const job = this.jobs.create(request, node.id);
    this.audit.append("job.created", "operator", job.id, {
      nodeId: node.id,
      provider: job.provider,
    });
    await connection.send({ type: "job.assign", job });
    return job;
  }

  async cancelJob(jobId: string): Promise<void> {
    const job = this.jobs.cancel(jobId);
    const connection = job.nodeId ? this.connections.get(job.nodeId) : undefined;
    if (connection) await connection.send({ type: "job.cancel", jobId });
    this.audit.append("job.cancelled", "operator", jobId);
  }

  revokeNode(nodeId: string): HostedNode {
    const node = this.nodes.revoke(nodeId);
    this.audit.append("node.revoked", "operator", nodeId);
    void this.connections.get(nodeId)?.close();
    this.connections.delete(nodeId);
    return node;
  }
}

function connectorKey(nodeId: string, instanceId: string): string {
  return `${nodeId}\u0000${instanceId}`;
}
