import {
  DEFAULT_HEARTBEAT_TIMEOUT_MS,
  type AgentJob,
  type AuditEvent,
  type CreateJobRequest,
  type HostedNode,
  type NodeHeartbeat,
  type NodeRegistration,
  type Provider,
  type WorkspaceDescriptor,
} from "./index.ts";

type Clock = () => Date;

const defaultClock: Clock = () => new Date();

function id(prefix: string): string {
  return `${prefix}_${crypto.randomUUID()}`;
}

function providerCapability(provider: Provider): HostedNode["capabilities"][number] {
  if (provider === "codeman") return "codeman";
  if (provider === "cursor") return "cursor-worker";
  return "claude-runner";
}

export class NodeRegistry {
  private readonly nodes = new Map<string, HostedNode>();
  private readonly clock: Clock;
  private readonly heartbeatTimeoutMs: number;

  constructor(clock: Clock = defaultClock, heartbeatTimeoutMs = DEFAULT_HEARTBEAT_TIMEOUT_MS) {
    this.clock = clock;
    this.heartbeatTimeoutMs = heartbeatTimeoutMs;
  }

  enroll(registration: NodeRegistration): HostedNode {
    const now = this.clock().toISOString();
    const existing = this.nodes.get(registration.nodeId);

    if (existing?.status === "revoked") {
      throw new Error(`Node is revoked: ${registration.nodeId}`);
    }

    const node: HostedNode = {
      id: registration.nodeId,
      name: registration.name,
      platform: registration.platform,
      status: "online",
      capabilities: [...new Set(registration.capabilities)],
      labels: { ...registration.labels },
      workspacePolicy: registration.workspacePolicy ?? { mode: "folders", roots: [] },
      workspaces: [...(registration.workspaces ?? [])],
      lastSeenAt: now,
    };

    this.nodes.set(node.id, node);
    return node;
  }

  heartbeat(heartbeat: NodeHeartbeat): HostedNode {
    const node = this.nodes.get(heartbeat.nodeId);
    if (!node) throw new Error(`Unknown node: ${heartbeat.nodeId}`);
    if (node.status === "revoked") throw new Error(`Node is revoked: ${node.id}`);

    const updated: HostedNode = {
      ...node,
      status: "online",
      capabilities: [...new Set(heartbeat.capabilities)],
      lastSeenAt: heartbeat.sentAt,
    };
    this.nodes.set(updated.id, updated);
    return updated;
  }

  markOffline(now = this.clock()): void {
    for (const node of this.nodes.values()) {
      if (node.status !== "online" || !node.lastSeenAt) continue;
      const age = now.getTime() - Date.parse(node.lastSeenAt);
      if (age > this.heartbeatTimeoutMs) {
        this.nodes.set(node.id, { ...node, status: "offline" });
      }
    }
  }

  revoke(nodeId: string): HostedNode {
    const node = this.require(nodeId);
    const revoked = { ...node, status: "revoked" as const };
    this.nodes.set(nodeId, revoked);
    return revoked;
  }

  select(provider: Provider, requestedNodeId?: string): HostedNode {
    if (requestedNodeId) {
      const node = this.require(requestedNodeId);
      this.assertSchedulable(node, provider);
      return node;
    }

    const capability = providerCapability(provider);
    const node = [...this.nodes.values()].find(
      (candidate) =>
        candidate.status === "online" && candidate.capabilities.includes(capability),
    );
    if (!node) throw new Error(`No online node supports provider: ${provider}`);
    return node;
  }

  selectWorkspace(
    nodeId: string,
    workspaceId: string,
    provider: Provider,
  ): WorkspaceDescriptor {
    const node = this.require(nodeId);
    this.assertSchedulable(node, provider);
    const workspace = node.workspaces.find((candidate) => candidate.id === workspaceId);
    if (!workspace) throw new Error(`Unknown workspace: ${workspaceId}`);
    if (workspace.health !== "ready") {
      throw new Error(`Workspace is not ready: ${workspaceId}`);
    }
    if (workspace.providers[provider] !== "ready") {
      throw new Error(`Provider is not ready for workspace: ${provider}`);
    }
    return workspace;
  }

  list(): HostedNode[] {
    return [...this.nodes.values()].map((node) => ({
      ...node,
      capabilities: [...node.capabilities],
      labels: { ...node.labels },
      workspacePolicy: { ...node.workspacePolicy, roots: [...node.workspacePolicy.roots] },
      workspaces: node.workspaces.map((workspace) => ({
        ...workspace,
        providers: { ...workspace.providers },
      })),
    }));
  }

  private require(nodeId: string): HostedNode {
    const node = this.nodes.get(nodeId);
    if (!node) throw new Error(`Unknown node: ${nodeId}`);
    return node;
  }

  private assertSchedulable(node: HostedNode, provider: Provider): void {
    if (node.status !== "online") throw new Error(`Node is not online: ${node.id}`);
    if (!node.capabilities.includes(providerCapability(provider))) {
      throw new Error(`Node does not support provider: ${provider}`);
    }
  }
}

export class JobStore {
  private readonly jobs = new Map<string, AgentJob>();
  private readonly byIdempotencyKey = new Map<string, string>();
  private readonly clock: Clock;

  constructor(clock: Clock = defaultClock) {
    this.clock = clock;
  }

  create(request: CreateJobRequest, nodeId: string): AgentJob {
    const existingId = this.byIdempotencyKey.get(request.idempotencyKey);
    if (existingId) return this.require(existingId);

    const job: AgentJob = {
      id: id("job"),
      provider: request.provider,
      nodeId,
      workspaceId: request.workspaceId,
      prompt: request.prompt,
      status: "queued",
      idempotencyKey: request.idempotencyKey,
      createdAt: this.clock().toISOString(),
    };

    this.jobs.set(job.id, job);
    this.byIdempotencyKey.set(job.idempotencyKey, job.id);
    return job;
  }

  start(jobId: string): AgentJob {
    return this.update(jobId, { status: "running" });
  }

  complete(jobId: string): AgentJob {
    return this.update(jobId, { status: "completed" });
  }

  fail(jobId: string): AgentJob {
    return this.update(jobId, { status: "failed" });
  }

  cancel(jobId: string): AgentJob {
    const job = this.require(jobId);
    if (job.status === "completed" || job.status === "failed") {
      throw new Error(`Cannot cancel terminal job: ${job.id}`);
    }
    return this.update(jobId, { status: "cancelled" });
  }

  get(jobId: string): AgentJob | undefined {
    return this.jobs.get(jobId);
  }

  getByIdempotencyKey(idempotencyKey: string): AgentJob | undefined {
    const jobId = this.byIdempotencyKey.get(idempotencyKey);
    return jobId ? this.jobs.get(jobId) : undefined;
  }

  private update(jobId: string, patch: Partial<AgentJob>): AgentJob {
    const job = this.require(jobId);
    const updated = { ...job, ...patch };
    this.jobs.set(jobId, updated);
    return updated;
  }

  private require(jobId: string): AgentJob {
    const job = this.jobs.get(jobId);
    if (!job) throw new Error(`Unknown job: ${jobId}`);
    return job;
  }
}

export class AuditLog {
  private readonly events: AuditEvent[] = [];
  private readonly clock: Clock;

  constructor(clock: Clock = defaultClock) {
    this.clock = clock;
  }

  append(
    type: AuditEvent["type"],
    actor: AuditEvent["actor"],
    resourceId: string,
    metadata: Record<string, string> = {},
  ): AuditEvent {
    const event: AuditEvent = {
      id: id("audit"),
      type,
      actor,
      resourceId,
      createdAt: this.clock().toISOString(),
      metadata: { ...metadata },
    };
    this.events.push(event);
    return event;
  }

  list(): AuditEvent[] {
    return this.events.map((event) => ({
      ...event,
      metadata: { ...event.metadata },
    }));
  }
}
