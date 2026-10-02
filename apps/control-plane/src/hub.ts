import {
  CodemanHttpAdapter,
  CodemanConnectorAdapter,
  type CodemanInstanceAdapter,
} from "../../../packages/codeman-bridge/src/index.ts";
import { HubStateStore } from "../../../packages/protocol/src/persistence.ts";
import type {
  AuditEvent,
  CodemanAgentMode,
  CodemanAgentProfile,
  CodemanInstance,
  CodemanInstanceRegistration,
  CodemanSession,
  CodemanSessionEvent,
  CodemanConnectorOperation,
  WorkspaceDescriptor,
  WorkspacePathSuggestion,
} from "../../../packages/protocol/src/index.ts";
import {
  validateCodemanInstanceRegistration,
  validateCodemanInstance,
} from "../../../packages/protocol/src/index.ts";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";

export interface HubOptions {
  statePath?: string;
  credentials?: Record<string, { username: string; password: string }>;
  adapterFactory?: (
    instance: CodemanInstance,
    credentials?: { username: string; password: string },
  ) => CodemanInstanceAdapter;
  connectorRequest?: (
    nodeId: string,
    instanceId: string,
    operation: CodemanConnectorOperation,
    payload?: Record<string, unknown>,
  ) => Promise<unknown>;
  connectorSubscribeEvents?: (
    nodeId: string,
    instanceId: string,
    listener: (event: CodemanSessionEvent) => void,
  ) => () => void;
}

export class CodemanHub {
  readonly state: HubStateStore;
  private readonly credentials: HubOptions["credentials"];
  private readonly adapterFactory: NonNullable<HubOptions["adapterFactory"]>;
  private readonly hasCustomAdapterFactory: boolean;
  private readonly connectorRequest?: HubOptions["connectorRequest"];
  private readonly connectorSubscribeEvents?: HubOptions["connectorSubscribeEvents"];
  private readonly runtimeCredentials = new Map<string, { username: string; password: string }>();
  private readonly adapters = new Map<string, CodemanInstanceAdapter>();
  private readonly adapterUnsubscribers = new Map<string, () => void>();
  private readonly listeners = new Set<(event: CodemanSessionEvent) => void>();

  constructor(options: HubOptions = {}) {
    this.state = new HubStateStore(options.statePath);
    this.hasCustomAdapterFactory = options.adapterFactory !== undefined;
    this.credentials = options.credentials;
    this.connectorRequest = options.connectorRequest;
    this.connectorSubscribeEvents = options.connectorSubscribeEvents;
    this.adapterFactory = options.adapterFactory
      ?? ((instance, credentials) => {
        if (instance.connectionMode === "connector") {
          if (!this.connectorRequest || !this.connectorSubscribeEvents || !instance.nodeId) {
            throw new Error(`Connector is not configured: ${instance.id}`);
          }
          return new CodemanConnectorAdapter({
            instance,
            request: (operation, payload) => this.connectorRequest!(
              instance.nodeId!,
              instance.id,
              operation,
              payload,
            ),
            subscribeEvents: (listener) => this.connectorSubscribeEvents!(
              instance.nodeId!,
              instance.id,
              listener,
            ),
          });
        }
        return new CodemanHttpAdapter({ instance, ...(credentials ?? {}) });
      });
    for (const instance of this.state.snapshot().instances) this.attachAdapter(instance);
  }

  listInstances(): CodemanInstance[] {
    return this.state.snapshot().instances;
  }

  listSessions(): CodemanSession[] {
    return this.state.snapshot().sessions;
  }

  async suggestWorkspacePaths(
    instanceId: string,
    prefix: string,
  ): Promise<WorkspacePathSuggestion[]> {
    this.getInstance(instanceId);
    return this.getAdapter(instanceId).listWorkspacePathSuggestions(prefix);
  }

  listAudit(): AuditEvent[] {
    return this.state.snapshot().audit;
  }

  getInstance(instanceId: string): CodemanInstance {
    const instance = this.listInstances().find((candidate) => candidate.id === instanceId);
    if (!instance) throw new Error(`Unknown Codeman instance: ${instanceId}`);
    return instance;
  }

  getAdapter(instanceId: string): CodemanInstanceAdapter {
    const adapter = this.adapters.get(instanceId);
    if (!adapter) throw new Error(`Codeman instance is not connected: ${instanceId}`);
    return adapter;
  }

  getSession(instanceId: string, sessionId: string): CodemanSession {
    const session = this.listSessions().find(
      (candidate) => candidate.instanceId === instanceId && candidate.id === sessionId,
    );
    if (!session) throw new Error(`Unknown session: ${instanceId}/${sessionId}`);
    return session;
  }

  registerInstance(
    registration: CodemanInstanceRegistration,
    credentials?: { username: string; password: string },
  ): CodemanInstance {
    validateCodemanInstanceRegistration(registration);
    const existing = this.listInstances().find((instance) => instance.id === registration.id);
    const instance: CodemanInstance = {
      id: registration.id,
      label: registration.label,
      connectionMode: registration.connectionMode,
      ...(registration.nodeId ? { nodeId: registration.nodeId } : {}),
      endpoint: registration.endpoint ?? null,
      status: existing?.status ?? "offline",
      capabilities: [...new Set(registration.capabilities ?? ["codeman"])],
      ...(registration.workspacePolicy
        ? {
            workspacePolicy: {
              mode: registration.workspacePolicy.mode,
              roots: [...registration.workspacePolicy.roots],
            },
          }
        : existing?.workspacePolicy
          ? {
              workspacePolicy: {
                mode: existing.workspacePolicy.mode,
                roots: [...existing.workspacePolicy.roots],
              },
            }
          : {}),
      agents: (registration.agents ?? defaultAgents()).map((agent) => ({ ...agent })),
      workspaces: (registration.workspaces ?? []).map((workspace) => ({
        ...workspace,
        providers: { ...workspace.providers },
      })),
      lastSeenAt: existing?.lastSeenAt ?? null,
      createdAt: existing?.createdAt ?? new Date().toISOString(),
    };
    validateCodemanInstance(instance);
    if (credentials) this.runtimeCredentials.set(instance.id, credentials);
    this.attachAdapter(instance, credentials ?? this.runtimeCredentials.get(instance.id));
    this.state.upsertInstance(instance);
    this.appendAudit("instance.registered", instance.id, { connectionMode: instance.connectionMode });
    return instance;
  }

  removeInstance(instanceId: string): void {
    this.getInstance(instanceId);
    this.adapterUnsubscribers.get(instanceId)?.();
    this.adapterUnsubscribers.delete(instanceId);
    this.adapters.delete(instanceId);
    this.runtimeCredentials.delete(instanceId);
    this.appendAudit("instance.removed", instanceId);
    this.state.removeInstance(instanceId);
  }

  async checkInstance(instanceId: string): Promise<CodemanInstance> {
    const instance = this.getInstance(instanceId);
    const adapter = this.getAdapter(instanceId);
    try {
      const [workspaces, agents] = await Promise.all([
        adapter.listWorkspaces(),
        adapter.listCapabilities(),
      ]);
      const updated = {
        ...instance,
        status: "online" as const,
        workspaces,
        agents,
        lastSeenAt: new Date().toISOString(),
      };
      this.state.upsertInstance(updated);
      this.appendAudit("instance.health", instanceId, { status: updated.status });
      return updated;
    } catch {
      const updated = { ...instance, status: "unhealthy" as const };
      this.state.upsertInstance(updated);
      this.appendAudit("instance.health", instanceId, { status: updated.status });
      return updated;
    }
  }

  async listCapabilities(instanceId: string): Promise<CodemanAgentProfile[]> {
    const instance = this.getInstance(instanceId);
    const agents = await this.getAdapter(instanceId).listCapabilities();
    this.state.upsertInstance({
      ...instance,
      agents,
      status: "online",
      lastSeenAt: new Date().toISOString(),
    });
    return agents;
  }

  async syncSessions(instanceId: string): Promise<CodemanSession[]> {
    const adapter = this.getAdapter(instanceId);
    const sessions = await adapter.listSessions();
    for (const session of sessions) this.state.upsertSession(session);
    return sessions;
  }

  async createSession(
    instanceId: string,
    workspaceId: string | undefined,
    agentId: string,
    title?: string,
    workspacePath?: string,
  ): Promise<CodemanSession> {
    const instance = this.getInstance(instanceId);
    const workspace = workspaceId
      ? requireWorkspace(instance.workspaces, workspaceId)
      : this.resolveWorkspacePath(instance, workspacePath);
    const agent = instance.agents.find((candidate) => candidate.id === agentId);
    if (!agent || !agent.ready) throw new Error(`Agent is not ready: ${agentId}`);
    let session: CodemanSession;
    try {
      session = await this.getAdapter(instanceId).createSession(workspace, agent, title);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to create session";
      if (/workingDir does not exist|does not exist|ENOENT/i.test(message)) {
        throw new Error(
          `Workspace path does not exist on that host: ${workspace.canonicalPath}. `
          + "Use a path that exists on the Codeman machine (for WSL, prefer /home/... or /mnt/...).",
        );
      }
      throw error;
    }
    this.state.upsertSession(session);
    this.appendAudit("session.created", `${instanceId}/${session.id}`, {
      workspaceId: workspace.id,
      agentId,
    });
    return session;
  }

  async sendInput(instanceId: string, sessionId: string, input: string, raw = false): Promise<void> {
    this.assertSession(instanceId, sessionId);
    await this.getAdapter(instanceId).sendInput(sessionId, input, raw);
  }

  async resizeSession(instanceId: string, sessionId: string, cols: number, rows: number): Promise<void> {
    this.assertSession(instanceId, sessionId);
    await this.getAdapter(instanceId).resize(sessionId, cols, rows);
  }

  async proxyTerminal(
    instanceId: string,
    sessionId: string,
    request: IncomingMessage,
    clientSocket: Duplex,
    head: Buffer,
  ): Promise<void> {
    const adapter = this.getAdapter(instanceId);
    if (!this.listSessions().some(
      (session) => session.instanceId === instanceId && session.id === sessionId,
    )) {
      const remoteSession = (await adapter.listSessions())
        .find((session) => session.id === sessionId);
      if (!remoteSession) throw new Error(`Unknown session: ${instanceId}/${sessionId}`);
      this.state.upsertSession(remoteSession);
    }
    const proxyTerminal = adapter.proxyTerminal;
    if (!proxyTerminal) {
      throw new Error(`Codeman WebSocket proxy is unavailable: ${instanceId}`);
    }
    await proxyTerminal.call(
      adapter,
      sessionId,
      request,
      clientSocket,
      head,
    );
  }

  async proxyCodemanRequest(
    instanceId: string,
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const adapter = this.getAdapter(instanceId);
    const proxyHttp = adapter.proxyHttp;
    if (!proxyHttp) {
      throw new Error(`Codeman HTTP proxy is unavailable: ${instanceId}`);
    }
    await proxyHttp.call(adapter, request, response);
  }

  /**
   * Prepare a Tailscale Codeman host for the native UI: seed Cases from Hub
   * workspaces so Codeman Quick Start can create sessions.
   */
  async prepareNativeUi(instanceId: string): Promise<void> {
    const instance = this.getInstance(instanceId);
    if (instance.connectionMode !== "tailscale-url") {
      throw new Error(`Native Codeman UI requires a Tailscale host: ${instanceId}`);
    }
    const adapter = this.getAdapter(instanceId);
    await adapter.ensureNativeCases?.();
  }

  async stopSession(instanceId: string, sessionId: string): Promise<void> {
    this.assertSession(instanceId, sessionId);
    await this.getAdapter(instanceId).stopSession(sessionId);
    const existing = this.state.snapshot().sessions.find(
      (session) => session.instanceId === instanceId && session.id === sessionId,
    );
    if (existing) this.state.upsertSession({ ...existing, status: "stopped", lastEventAt: new Date().toISOString() });
    this.appendAudit("session.stopped", `${instanceId}/${sessionId}`);
  }

  removeSession(instanceId: string, sessionId: string): void {
    const session = this.getSession(instanceId, sessionId);
    if (!["completed", "failed", "stopped"].includes(session.status)) {
      throw new Error("Only stopped sessions can be removed");
    }
    this.state.removeSession(instanceId, sessionId);
    this.appendAudit("session.removed", `${instanceId}/${sessionId}`);
  }

  subscribeEvents(listener: (event: CodemanSessionEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private attachAdapter(
    instance: CodemanInstance,
    credentials?: { username: string; password: string },
  ): void {
    this.adapterUnsubscribers.get(instance.id)?.();
    this.adapterUnsubscribers.delete(instance.id);
    this.adapters.delete(instance.id);
    if (instance.connectionMode === "connector") {
      if (
        !instance.nodeId
        || (!this.hasCustomAdapterFactory
          && (!this.connectorRequest || !this.connectorSubscribeEvents))
      ) return;
    } else if (!instance.endpoint) {
      return;
    }
    const adapter = this.adapterFactory(
      instance,
      credentials ?? this.credentials?.[instance.id],
    );
    this.adapters.set(instance.id, adapter);
    const unsubscribe = adapter.subscribeEvents((event) => {
      this.updateSessionFromEvent(instance.id, event);
      for (const listener of this.listeners) listener(event);
    });
    this.adapterUnsubscribers.set(instance.id, unsubscribe);
  }

  private updateSessionFromEvent(instanceId: string, event: CodemanSessionEvent): void {
    const existing = this.state.snapshot().sessions.find(
      (session) => session.instanceId === instanceId && session.id === event.sessionId,
    );
    if (!existing) return;
    const status = sessionStatusForEvent(event.event, existing.status);
    this.state.upsertSession({
      ...existing,
      status,
      needsInput: event.event === "waiting"
        ? true
        : event.event === "output" || event.event === "started"
          ? false
          : existing.needsInput,
      terminalBuffer: event.data ? `${existing.terminalBuffer}${event.data}` : existing.terminalBuffer,
      lastEventAt: event.createdAt,
    });
  }

  private assertSession(instanceId: string, sessionId: string): void {
    const exists = this.state.snapshot().sessions.some(
      (session) => session.instanceId === instanceId && session.id === sessionId,
    );
    if (!exists) throw new Error(`Unknown session: ${instanceId}/${sessionId}`);
  }

  private resolveWorkspacePath(
    instance: CodemanInstance,
    workspacePath: string | undefined,
  ): WorkspaceDescriptor {
    if (!workspacePath?.trim()) throw new Error("workspaceId or workspacePath is required");
    const path = workspacePath.trim();
    const known = instance.workspaces.find((workspace) => workspace.canonicalPath === path);
    if (known) return requireWorkspace(instance.workspaces, known.id);
    const policy = instance.workspacePolicy;
    if (!policy) throw new Error("This instance does not allow arbitrary workspace paths");
    if (
      policy.mode !== "system"
      && !policy.roots.some((root) => isWithinPath(path, root))
    ) {
      throw new Error("Workspace path is outside the instance policy");
    }
    return {
      id: path,
      name: path.split(/[\\/]/).filter(Boolean).at(-1) ?? path,
      canonicalPath: path,
      health: "ready",
      providers: { codeman: "ready" },
    };
  }

  private appendAudit(
    type: AuditEvent["type"],
    resourceId: string,
    metadata: Record<string, string> = {},
  ): void {
    this.state.appendAudit({
      id: `audit_${crypto.randomUUID()}`,
      type,
      actor: "operator",
      resourceId,
      createdAt: new Date().toISOString(),
      metadata,
    });
  }
}

function sessionStatusForEvent(
  event: CodemanSessionEvent["event"],
  current: CodemanSession["status"],
): CodemanSession["status"] {
  switch (event) {
    case "output":
      return current;
    case "created":
      return "starting";
    case "started":
      return "working";
    case "waiting":
      return "waiting";
    case "idle":
      return "idle";
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "stopped":
      return "stopped";
  }
}

function requireWorkspace(workspaces: WorkspaceDescriptor[], workspaceId: string): WorkspaceDescriptor {
  const workspace = workspaces.find((candidate) => candidate.id === workspaceId);
  if (!workspace) throw new Error(`Unknown workspace: ${workspaceId}`);
  if (workspace.health !== "ready") throw new Error(`Workspace is not ready: ${workspaceId}`);
  return workspace;
}

function isWithinPath(path: string, root: string): boolean {
  const normalizedPath = normalizePath(path);
  const normalizedRoot = normalizePath(root);
  return !normalizedRoot
    || normalizedPath === normalizedRoot
    || normalizedPath.startsWith(`${normalizedRoot}/`);
}

function normalizePath(value: string): string {
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

function defaultAgents(): CodemanAgentProfile[] {
  const modes: CodemanAgentMode[] = [
    "claude",
    "shell",
    "opencode",
    "codex",
    "gemini",
    "antigravity",
    "pi",
    "grok",
    "deepseek",
  ];
  return modes.map((mode) => ({
    id: mode,
    name: mode === "claude" ? "Claude Code" : mode === "shell" ? "Shell (raw CLI)" : mode,
    mode,
    ready: true,
  }));
}
