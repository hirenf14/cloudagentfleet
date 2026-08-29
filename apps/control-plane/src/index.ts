import { AuditLog, JobStore, NodeRegistry } from "../../../packages/protocol/src/lifecycle.ts";
import type {
  AgentJob,
  ControlMessage,
  CreateJobRequest,
  HostedNode,
  NodeMessage,
  NodeHeartbeat,
  NodeRegistration,
} from "../../../packages/protocol/src/index.ts";

export interface NodeConnection {
  node: HostedNode;
  send(message: ControlMessage): Promise<void>;
  close(): Promise<void>;
}

export class ControlPlane {
  readonly nodes: NodeRegistry;
  readonly jobs: JobStore;
  readonly audit: AuditLog;
  private readonly connections = new Map<string, NodeConnection>();

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
    void this.connections.get(connection.node.id)?.close();
    this.connections.set(connection.node.id, connection);
  }

  removeConnection(nodeId: string): void {
    this.connections.delete(nodeId);
  }

  receiveNodeMessage(nodeId: string, message: NodeMessage): void {
    if (message.type === "heartbeat") {
      this.heartbeatNode({ ...message, nodeId });
      return;
    }

    const jobId = message.type === "job.accept" || message.type === "job.event"
      ? message.jobId
      : undefined;
    if (!jobId) return;

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

  markOffline(): void {
    this.nodes.markOffline();
  }
}
