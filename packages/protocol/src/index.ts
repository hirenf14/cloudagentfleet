export type Provider = "codeman" | "cursor" | "claude";

export type NodeStatus = "online" | "offline" | "revoked";
export type WorkerStatus = NodeStatus;

export const PROTOCOL_VERSION = 1;
export const DEFAULT_HEARTBEAT_TIMEOUT_MS = 45_000;
export const DEFAULT_PREVIEW_LEASE_MS = 15 * 60_000;

export type NodeCapability =
  | "codeman"
  | "cursor-worker"
  | "claude-runner"
  | "preview-relay"
  | "remote-browser"
  | "docker";
export type WorkerCapability = NodeCapability;

export interface HostedNode {
  id: string;
  name: string;
  platform: "linux" | "macos" | "windows";
  status: NodeStatus;
  capabilities: NodeCapability[];
  labels: Record<string, string>;
  workspacePolicy: WorkspacePolicy;
  workspaces: WorkspaceDescriptor[];
  lastSeenAt: string | null;
}
export type HostedWorker = HostedNode;

export type WorkspaceAccessMode = "folders" | "system";

export interface WorkspacePolicy {
  mode: WorkspaceAccessMode;
  roots: string[];
}

export type WorkspaceHealth = "ready" | "missing" | "unreadable";

export interface WorkspaceDescriptor {
  id: string;
  name: string;
  canonicalPath: string;
  health: WorkspaceHealth;
  providers: Partial<Record<Provider, "ready" | "missing" | "unauthenticated" | "unavailable">>;
}

export interface NodeRegistration {
  nodeId: string;
  name: string;
  platform: HostedNode["platform"];
  capabilities: NodeCapability[];
  labels?: Record<string, string>;
  workspacePolicy?: WorkspacePolicy;
  workspaces?: WorkspaceDescriptor[];
}
export type WorkerRegistration = NodeRegistration;

export interface NodeHeartbeat {
  nodeId: string;
  sentAt: string;
  capabilities: NodeCapability[];
}
export type WorkerHeartbeat = NodeHeartbeat;

export interface AgentJob {
  id: string;
  provider: Provider;
  nodeId: string | null;
  workspaceId: string;
  prompt: string;
  status: "queued" | "running" | "completed" | "failed" | "cancelled";
  idempotencyKey: string;
  createdAt: string;
}

export type SessionStatus =
  | "starting"
  | "working"
  | "waiting"
  | "idle"
  | "completed"
  | "failed"
  | "stopped";

export interface AgentSession {
  id: string;
  jobId: string;
  nodeId: string;
  workspaceId: string;
  provider: Provider;
  title: string;
  status: SessionStatus;
  needsInput: boolean;
  previewAvailable: boolean;
  browserAvailable: boolean;
  startedAt: string;
  lastEventAt: string;
}

export interface CreateJobRequest {
  provider: Provider;
  nodeId?: string;
  workspaceId: string;
  prompt: string;
  idempotencyKey: string;
}

export interface AuditEvent {
  id: string;
  type:
    | "node.enrolled"
    | "node.heartbeat"
    | "node.revoked"
    | "job.created"
    | "job.started"
    | "job.completed"
    | "job.failed"
    | "job.cancelled"
    | "preview.created"
    | "preview.revoked"
    | "browser.started"
    | "browser.stopped";
  actor: "system" | "operator" | "node";
  resourceId: string;
  createdAt: string;
  metadata: Record<string, string>;
}

export interface PreviewLease {
  id: string;
  nodeId: string;
  jobId: string;
  port: number;
  protocol: "http" | "https";
  browserUrl: string;
  localPort: number | null;
  expiresAt: string;
  revokedAt: string | null;
}

export interface RemoteBrowserSession {
  id: string;
  nodeId: string;
  jobId: string;
  previewLeaseId: string;
  width: number;
  height: number;
  profileMode: "disposable" | "persistent";
  status: "starting" | "active" | "stopped" | "failed";
  createdAt: string;
}

export type NodeMessage =
  | {
      type: "heartbeat";
      nodeId: string;
      sentAt: string;
      capabilities: NodeCapability[];
    }
  | {
      type: "job.accept";
      jobId: string;
      idempotencyKey: string;
    }
  | {
      type: "job.event";
      jobId: string;
      event: "started" | "output" | "completed" | "failed" | "cancelled";
      data?: string;
    }
  | {
      type: "preview.open";
      leaseId: string;
      port: number;
    }
  | {
      type: "browser.input";
      sessionId: string;
      event:
        | { kind: "mouse"; x: number; y: number; action: "move" | "down" | "up" }
        | { kind: "keyboard"; action: "down" | "up"; key: string }
        | { kind: "navigate"; url: string }
        | { kind: "resize"; width: number; height: number };
    };
export type WorkerMessage = NodeMessage;

export type ControlMessage =
  | {
      type: "job.assign";
      job: AgentJob;
    }
  | {
      type: "job.cancel";
      jobId: string;
    }
  | {
      type: "preview.open";
      lease: PreviewLease;
    }
  | {
      type: "browser.start";
      session: RemoteBrowserSession;
    }
  | {
      type: "browser.stop";
      sessionId: string;
    };
