export type Provider = "codeman" | "cursor" | "claude";
export type ConnectionMode = "connector" | "tailscale-url";

/** The per-machine execution plane behind an instance. */
export const HOST_BACKENDS = ["codeman"] as const;
export type HostBackend = (typeof HOST_BACKENDS)[number];

/**
 * What the Hub may do with an instance. Routes and the dashboard gate on
 * these; adapters advertise them and the Hub stores them on the instance.
 */
export const BACKEND_FEATURES = [
  "sessions",
  "terminal",
  "native-ui-proxy",
  "native-ui-link",
  "workspace-suggest",
] as const;
export type BackendFeature = (typeof BACKEND_FEATURES)[number];

export function isHostBackend(value: unknown): value is HostBackend {
  return (HOST_BACKENDS as readonly unknown[]).includes(value);
}

export function isBackendFeature(value: unknown): value is BackendFeature {
  return (BACKEND_FEATURES as readonly unknown[]).includes(value);
}
export type HostInstanceStatus = "online" | "offline" | "unhealthy" | "revoked";
export const CODEMAN_AGENT_MODES = [
  "claude",
  "shell",
  "opencode",
  "codex",
  "gemini",
  "antigravity",
  "pi",
  "grok",
  "deepseek",
] as const;
export type CodemanAgentMode = (typeof CODEMAN_AGENT_MODES)[number];

export type NodeStatus = "online" | "offline" | "revoked";

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

export interface AgentProfile {
  id: string;
  name: string;
  /** Backend-specific launch key (a Codeman mode for Codeman instances). */
  mode: string;
  ready: boolean;
}

export interface HostInstance {
  id: string;
  label: string;
  backend: HostBackend;
  connectionMode: ConnectionMode;
  /**
   * Connector instances are reached through this enrolled Worker. It remains
   * optional for persisted/direct instances to preserve the existing schema.
   */
  nodeId?: string;
  endpoint: string | null;
  status: HostInstanceStatus;
  /** Set by the Hub from the attached adapter; empty until one is attached. */
  features: BackendFeature[];
  capabilities: string[];
  /**
   * Optional metadata for direct registrations. Connector instances also
   * inherit the authoritative policy from their enrolled Worker.
   */
  workspacePolicy?: WorkspacePolicy;
  agents: AgentProfile[];
  workspaces: WorkspaceDescriptor[];
  lastSeenAt: string | null;
  createdAt: string;
}

export interface CodemanStatus {
  version?: string;
  agents?: AgentProfile[];
  capabilities?: string[];
  sessions?: number;
}

export interface HostInstanceRegistration {
  id: string;
  label: string;
  /** Defaults to "codeman" so older Workers and CLIs keep registering. */
  backend?: HostBackend;
  connectionMode: ConnectionMode;
  nodeId?: string;
  endpoint?: string;
  capabilities?: string[];
  workspacePolicy?: WorkspacePolicy;
  agents?: AgentProfile[];
  workspaces?: WorkspaceDescriptor[];
}

/**
 * A session identifier is only unique within a Codeman instance. Callers that
 * persist or route sessions outside an adapter must retain both parts.
 */
export interface HostSession {
  id: string;
  instanceId: string;
  workspaceId: string;
  agent: AgentProfile;
  title: string;
  status: SessionStatus;
  terminalBuffer: string;
  needsInput: boolean;
  previewAvailable: boolean;
  browserAvailable: boolean;
  createdAt: string;
  lastEventAt: string;
}

export function isHostSession(value: unknown): value is HostSession {
  return isRecord(value)
    && isNonEmptyString(value.id)
    && isNonEmptyString(value.instanceId)
    && isNonEmptyString(value.workspaceId)
    && isAgentProfile(value.agent)
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

export function validateHostSession(value: unknown): HostSession {
  if (!isHostSession(value)) {
    throw new TypeError("Invalid namespaced host session");
  }
  return value;
}

export interface HostSessionEvent {
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

export function isHostSessionEvent(value: unknown): value is HostSessionEvent {
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

export function validateHostSessionEvent(value: unknown): HostSessionEvent {
  if (!isHostSessionEvent(value)) {
    throw new TypeError("Invalid host session event");
  }
  return value;
}

export function isHostInstance(value: unknown): value is HostInstance {
  return isRecord(value)
    && isNonEmptyString(value.id)
    && isNonEmptyString(value.label)
    && isHostBackend(value.backend)
    && (value.connectionMode === "connector" || value.connectionMode === "tailscale-url")
    && Array.isArray(value.features)
    && value.features.every(isBackendFeature)
    && (value.nodeId === undefined || isNonEmptyString(value.nodeId))
    && (value.endpoint === null
      || (typeof value.endpoint === "string" && isSafeEndpoint(value.endpoint)))
    && (value.connectionMode !== "tailscale-url" || typeof value.endpoint === "string")
    && (value.workspacePolicy === undefined || isWorkspacePolicy(value.workspacePolicy))
    && (value.status === "online"
      || value.status === "offline"
      || value.status === "unhealthy"
      || value.status === "revoked")
    && Array.isArray(value.capabilities)
    && value.capabilities.every((capability) => typeof capability === "string")
    && Array.isArray(value.agents)
    && value.agents.every(isAgentProfile)
    && Array.isArray(value.workspaces)
    && value.workspaces.every(isWorkspaceDescriptor)
    && (value.lastSeenAt === null || typeof value.lastSeenAt === "string")
    && typeof value.createdAt === "string";
}

export function validateHostInstance(value: unknown): HostInstance {
  if (!isHostInstance(value)) {
    throw new TypeError("Invalid host instance");
  }
  return value;
}

export function validateHostInstanceRegistration(
  value: unknown,
): HostInstanceRegistration {
  if (!isRecord(value)
    || !isNonEmptyString(value.id)
    || !isNonEmptyString(value.label)
    || (value.backend !== undefined && !isHostBackend(value.backend))
    || (value.connectionMode !== "connector" && value.connectionMode !== "tailscale-url")
    || (value.connectionMode === "connector" && !isNonEmptyString(value.nodeId))
    || (value.endpoint !== undefined
      && (typeof value.endpoint !== "string" || !isSafeEndpoint(value.endpoint)))
    || (value.workspacePolicy !== undefined && !isWorkspacePolicy(value.workspacePolicy))
    || (value.connectionMode === "tailscale-url" && typeof value.endpoint !== "string")) {
    throw new TypeError("Invalid host instance registration");
  }
  if ((value.capabilities !== undefined
      && (!Array.isArray(value.capabilities)
        || !value.capabilities.every((capability) => typeof capability === "string")))
    || (value.agents !== undefined
      && (!Array.isArray(value.agents) || !value.agents.every(isAgentProfile)))
    || (value.workspaces !== undefined
      && (!Array.isArray(value.workspaces) || !value.workspaces.every(isWorkspaceDescriptor)))) {
    throw new TypeError("Invalid host instance registration");
  }
  return value as unknown as HostInstanceRegistration;
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

export interface NodeHeartbeat {
  nodeId: string;
  sentAt: string;
  capabilities: NodeCapability[];
}

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
  event: HostSessionEvent;
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
    && isHostSessionEvent(value.event)
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

export function isRecord(value: unknown): value is Record<string, unknown> {
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

function isSafeEndpoint(value: string): boolean {
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

function isAgentProfile(value: unknown): value is AgentProfile {
  return isRecord(value)
    && isNonEmptyString(value.id)
    && isNonEmptyString(value.name)
    && isNonEmptyString(value.mode)
    && typeof value.ready === "boolean";
}

export function isCodemanAgentMode(value: unknown): value is CodemanAgentMode {
  return (CODEMAN_AGENT_MODES as readonly unknown[]).includes(value);
}

/** Display name shared by the Hub, bridge, and Worker for launch profiles. */
export function codemanAgentName(id: string, mode: CodemanAgentMode): string {
  if (id === "cursor-agent") return "Cursor Agent CLI";
  if (id === "claude-code") return "Claude Code CLI";
  if (id === "shell") return "Shell (raw CLI)";
  if (id === "claude" && mode === "claude") return "Claude Code";
  return id;
}

/**
 * Whether a path falls inside a workspace policy. Comparison is
 * case-insensitive and separator-agnostic so Windows and POSIX roots agree.
 */
export function isPathAllowed(path: string, policy: WorkspacePolicy): boolean {
  if (policy.mode === "system") return true;
  return policy.roots.some((root) => isWithinPath(path, root));
}

export function isWithinPath(path: string, root: string): boolean {
  const normalizedPath = normalizePolicyPath(path);
  const normalizedRoot = normalizePolicyPath(root);
  return !normalizedRoot
    || normalizedPath === normalizedRoot
    || normalizedPath.startsWith(`${normalizedRoot}/`);
}

function normalizePolicyPath(value: string): string {
  const segments: string[] = [];
  for (const segment of value.replaceAll("\\", "/").split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      segments.pop();
    } else {
      segments.push(segment);
    }
  }
  return segments.join("/").toLowerCase();
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
