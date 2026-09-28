export type Provider = "codeman" | "cursor" | "claude";
export type CodemanConnectionMode = "connector" | "tailscale-url";
export type CodemanInstanceStatus = "online" | "offline" | "unhealthy" | "revoked";
export type CodemanAgentMode =
  | "claude"
  | "shell"
  | "opencode"
  | "codex"
  | "gemini"
  | "antigravity"
  | "pi"
  | "grok"
  | "deepseek";

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

export interface WorkspacePathSuggestion {
  path: string;
  name: string;
}

export interface CodemanAgentProfile {
  id: string;
  name: string;
  mode: CodemanAgentMode;
  ready: boolean;
}

export interface CodemanInstance {
  id: string;
  label: string;
  connectionMode: CodemanConnectionMode;
  /**
   * Connector instances are reached through this enrolled Worker. It remains
   * optional for persisted/direct instances to preserve the existing schema.
   */
  nodeId?: string;
  endpoint: string | null;
  status: CodemanInstanceStatus;
  capabilities: string[];
  /**
   * Optional metadata for direct registrations. Connector instances also
   * inherit the authoritative policy from their enrolled Worker.
   */
  workspacePolicy?: WorkspacePolicy;
  agents: CodemanAgentProfile[];
  workspaces: WorkspaceDescriptor[];
  lastSeenAt: string | null;
  createdAt: string;
}

export interface CodemanStatus {
  version?: string;
  agents?: CodemanAgentProfile[];
  capabilities?: string[];
  sessions?: number;
}

export interface CodemanInstanceRegistration {
  id: string;
  label: string;
  connectionMode: CodemanConnectionMode;
  nodeId?: string;
  endpoint?: string;
  capabilities?: string[];
  workspacePolicy?: WorkspacePolicy;
  agents?: CodemanAgentProfile[];
  workspaces?: WorkspaceDescriptor[];
}

/**
 * A session identifier is only unique within a Codeman instance. Callers that
 * persist or route sessions outside an adapter must retain both parts.
 */
export interface CodemanSession {
  id: string;
  instanceId: string;
  workspaceId: string;
  agent: CodemanAgentProfile;
  title: string;
  status: SessionStatus;
  terminalBuffer: string;
  needsInput: boolean;
  previewAvailable: boolean;
  browserAvailable: boolean;
  createdAt: string;
  lastEventAt: string;
}

export function isCodemanSession(value: unknown): value is CodemanSession {
  return isRecord(value)
    && isNonEmptyString(value.id)
    && isNonEmptyString(value.instanceId)
    && isNonEmptyString(value.workspaceId)
    && isCodemanAgentProfile(value.agent)
    && isNonEmptyString(value.title)
    && (value.status === "starting"
      || value.status === "working"
      || value.status === "waiting"
      || value.status === "idle"
      || value.status === "completed"
      || value.status === "failed"
      || value.status === "stopped")
    && typeof value.terminalBuffer === "string"
    && typeof value.needsInput === "boolean"
    && typeof value.previewAvailable === "boolean"
    && typeof value.browserAvailable === "boolean"
    && typeof value.createdAt === "string"
    && typeof value.lastEventAt === "string";
}

export function validateCodemanSession(value: unknown): CodemanSession {
  if (!isCodemanSession(value)) {
    throw new TypeError("Invalid namespaced Codeman session");
  }
  return value;
}

export interface NamespacedSessionRef {
  instanceId: string;
  sessionId: string;
}

export function namespaceSession(instanceId: string, sessionId: string): NamespacedSessionRef {
  return {
    instanceId: requireNonEmpty(instanceId, "instanceId"),
    sessionId: requireNonEmpty(sessionId, "sessionId"),
  };
}

export function isNamespacedSessionRef(value: unknown): value is NamespacedSessionRef {
  return isRecord(value)
    && isNonEmptyString(value.instanceId)
    && isNonEmptyString(value.sessionId);
}

export function validateNamespacedSessionRef(value: unknown): NamespacedSessionRef {
  if (!isNamespacedSessionRef(value)) {
    throw new TypeError("Invalid namespaced Codeman session reference");
  }
  return value;
}

export interface CodemanSessionEvent {
  instanceId: string;
  sessionId: string;
  event:
    | "created"
    | "started"
    | "output"
    | "waiting"
    | "idle"
    | "completed"
    | "failed"
    | "stopped";
  data?: string;
  createdAt: string;
}

export function isCodemanSessionEvent(value: unknown): value is CodemanSessionEvent {
  return isRecord(value)
    && isNonEmptyString(value.instanceId)
    && isNonEmptyString(value.sessionId)
    && (value.event === "created"
      || value.event === "started"
      || value.event === "output"
      || value.event === "waiting"
      || value.event === "idle"
      || value.event === "completed"
      || value.event === "failed"
      || value.event === "stopped")
    && (value.data === undefined || typeof value.data === "string")
    && isNonEmptyString(value.createdAt);
}

export function validateCodemanSessionEvent(value: unknown): CodemanSessionEvent {
  if (!isCodemanSessionEvent(value)) {
    throw new TypeError("Invalid Codeman session event");
  }
  return value;
}

export function isCodemanInstance(value: unknown): value is CodemanInstance {
  return isRecord(value)
    && isNonEmptyString(value.id)
    && isNonEmptyString(value.label)
    && (value.connectionMode === "connector" || value.connectionMode === "tailscale-url")
    && (value.nodeId === undefined || isNonEmptyString(value.nodeId))
    && (value.endpoint === null
      || (typeof value.endpoint === "string" && isSafeCodemanEndpoint(value.endpoint)))
    && (value.connectionMode !== "tailscale-url" || typeof value.endpoint === "string")
    && (value.workspacePolicy === undefined || isWorkspacePolicy(value.workspacePolicy))
    && (value.status === "online"
      || value.status === "offline"
      || value.status === "unhealthy"
      || value.status === "revoked")
    && Array.isArray(value.capabilities)
    && value.capabilities.every((capability) => typeof capability === "string")
    && Array.isArray(value.agents)
    && value.agents.every(isCodemanAgentProfile)
    && Array.isArray(value.workspaces)
    && value.workspaces.every(isWorkspaceDescriptor)
    && (value.lastSeenAt === null || typeof value.lastSeenAt === "string")
    && typeof value.createdAt === "string";
}

export function validateCodemanInstance(value: unknown): CodemanInstance {
  if (!isCodemanInstance(value)) {
    throw new TypeError("Invalid Codeman instance");
  }
  return value;
}

export function validateCodemanInstanceRegistration(
  value: unknown,
): CodemanInstanceRegistration {
  if (!isRecord(value)
    || !isNonEmptyString(value.id)
    || !isNonEmptyString(value.label)
    || (value.connectionMode !== "connector" && value.connectionMode !== "tailscale-url")
    || (value.connectionMode === "connector" && !isNonEmptyString(value.nodeId))
    || (value.endpoint !== undefined
      && (typeof value.endpoint !== "string" || !isSafeCodemanEndpoint(value.endpoint)))
    || (value.workspacePolicy !== undefined && !isWorkspacePolicy(value.workspacePolicy))
    || (value.connectionMode === "tailscale-url" && typeof value.endpoint !== "string")) {
    throw new TypeError("Invalid Codeman instance registration");
  }
  if ((value.capabilities !== undefined
      && (!Array.isArray(value.capabilities)
        || !value.capabilities.every((capability) => typeof capability === "string")))
    || (value.agents !== undefined
      && (!Array.isArray(value.agents) || !value.agents.every(isCodemanAgentProfile)))
    || (value.workspaces !== undefined
      && (!Array.isArray(value.workspaces) || !value.workspaces.every(isWorkspaceDescriptor)))) {
    throw new TypeError("Invalid Codeman instance registration");
  }
  return value as unknown as CodemanInstanceRegistration;
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
    | "instance.registered"
    | "instance.removed"
    | "instance.health"
    | "session.created"
    | "session.stopped"
    | "session.removed"
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

export type CodemanConnectorOperation =
  | "status"
  | "capabilities"
  | "workspaces"
  | "workspaces.suggest"
  | "sessions.list"
  | "sessions.create"
  | "sessions.input"
  | "sessions.resize"
  | "sessions.stop";

export interface CodemanConnectorRequest {
  type: "codeman.request";
  requestId: string;
  instanceId: string;
  operation: CodemanConnectorOperation;
  payload?: Record<string, unknown>;
}

export interface CodemanConnectorResponse {
  type: "codeman.response";
  requestId: string;
  instanceId: string;
  success: boolean;
  data?: unknown;
  error?: string;
  errorCode?: string;
}

export interface CodemanConnectorSessionEvent {
  type: "codeman.session.event";
  instanceId: string;
  event: CodemanSessionEvent;
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
    }
  | CodemanConnectorResponse
  | CodemanConnectorSessionEvent;
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
    }
  | CodemanConnectorRequest;

export function isCodemanConnectorRequest(
  value: unknown,
): value is CodemanConnectorRequest {
  return isRecord(value)
    && value.type === "codeman.request"
    && isNonEmptyString(value.requestId)
    && isNonEmptyString(value.instanceId)
    && isCodemanConnectorOperation(value.operation)
    && (value.payload === undefined || isRecord(value.payload));
}

export function isCodemanConnectorResponse(
  value: unknown,
): value is CodemanConnectorResponse {
  return isRecord(value)
    && value.type === "codeman.response"
    && isNonEmptyString(value.requestId)
    && isNonEmptyString(value.instanceId)
    && typeof value.success === "boolean"
    && (value.success || isNonEmptyString(value.error))
    && (value.error === undefined || isNonEmptyString(value.error))
    && (value.errorCode === undefined || isNonEmptyString(value.errorCode));
}

export function isCodemanConnectorSessionEvent(
  value: unknown,
): value is CodemanConnectorSessionEvent {
  return isRecord(value)
    && value.type === "codeman.session.event"
    && isNonEmptyString(value.instanceId)
    && isCodemanSessionEvent(value.event)
    && value.event.instanceId === value.instanceId;
}

export function validateCodemanConnectorRequest(value: unknown): CodemanConnectorRequest {
  if (!isCodemanConnectorRequest(value)) {
    throw new TypeError("Invalid Codeman connector request");
  }
  return value;
}

export function validateCodemanConnectorResponse(value: unknown): CodemanConnectorResponse {
  if (!isCodemanConnectorResponse(value)) {
    throw new TypeError("Invalid Codeman connector response");
  }
  return value;
}

export function validateCodemanConnectorSessionEvent(
  value: unknown,
): CodemanConnectorSessionEvent {
  if (!isCodemanConnectorSessionEvent(value)) {
    throw new TypeError("Invalid Codeman connector session event");
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isCodemanConnectorOperation(
  value: unknown,
): value is CodemanConnectorOperation {
  return value === "status"
    || value === "capabilities"
    || value === "workspaces"
    || value === "workspaces.suggest"
    || value === "sessions.list"
    || value === "sessions.create"
    || value === "sessions.input"
    || value === "sessions.resize"
    || value === "sessions.stop";
}

function requireNonEmpty(value: string, field: string): string {
  if (!isNonEmptyString(value)) throw new TypeError(`${field} must not be empty`);
  return value;
}

function isSafeCodemanEndpoint(value: string): boolean {
  try {
    const endpoint = new URL(value);
    const hasNoEmbeddedCredentials = endpoint.username === "" && endpoint.password === "";
    return hasNoEmbeddedCredentials && (
      endpoint.protocol === "https:"
      || (endpoint.protocol === "http:"
        && (endpoint.hostname === "localhost"
          || endpoint.hostname === "127.0.0.1"
          || endpoint.hostname === "::1"
          || endpoint.hostname === "[::1]"))
    );
  } catch {
    return false;
  }
}

function isCodemanAgentProfile(value: unknown): value is CodemanAgentProfile {
  return isRecord(value)
    && isNonEmptyString(value.id)
    && isNonEmptyString(value.name)
    && isCodemanAgentMode(value.mode)
    && typeof value.ready === "boolean";
}

function isCodemanAgentMode(value: unknown): value is CodemanAgentMode {
  return value === "claude"
    || value === "shell"
    || value === "opencode"
    || value === "codex"
    || value === "gemini"
    || value === "antigravity"
    || value === "pi"
    || value === "grok"
    || value === "deepseek";
}

function isWorkspaceDescriptor(value: unknown): value is WorkspaceDescriptor {
  return isRecord(value)
    && isNonEmptyString(value.id)
    && isNonEmptyString(value.name)
    && isNonEmptyString(value.canonicalPath)
    && (value.health === "ready" || value.health === "missing" || value.health === "unreadable")
    && isRecord(value.providers)
    && Object.values(value.providers).every(
      (provider) =>
        provider === "ready"
        || provider === "missing"
        || provider === "unauthenticated"
        || provider === "unavailable",
    );
}

function isWorkspacePolicy(value: unknown): value is WorkspacePolicy {
  return isRecord(value)
    && (value.mode === "folders" || value.mode === "system")
    && Array.isArray(value.roots)
    && value.roots.every((root) => isNonEmptyString(root));
}
