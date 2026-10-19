import {
  backendDefinition,
  createAdapter,
  type AdapterDependencies,
  type HostAdapter,
  type NativeUiProxy,
  type PathSuggestions,
  type SessionControl,
  type TerminalProxy,
} from "../../../packages/host-adapters/src/index.ts";
import { HubStateStore } from "../../../packages/protocol/src/persistence.ts";
import { NotFoundError, UnavailableError, UnsupportedError } from "./errors.ts";
import type {
  AuditEvent,
  AgentProfile,
  BackendFeature,
  HostInstance,
  HostInstanceRegistration,
  HostSession,
  HostSessionEvent,
  CodemanConnectorOperation,
  WorkspaceDescriptor,
  WorkspacePathSuggestion,
} from "../../../packages/protocol/src/index.ts";
import {
  isPathAllowed,
  validateHostInstanceRegistration,
  validateHostInstance,
} from "../../../packages/protocol/src/index.ts";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";

type Credentials = { username: string; password: string };

export interface HubOptions {
  statePath?: string;
  credentials?: Record<string, Credentials>;
  /** Test seam; defaults to the backend registry. */
  adapterFactory?: (instance: HostInstance, credentials?: Credentials) => HostAdapter;
  connectorRequest?: (
    nodeId: string,
    instanceId: string,
    operation: CodemanConnectorOperation,
    payload?: Record<string, unknown>,
  ) => Promise<unknown>;
  connectorSubscribeEvents?: (
    nodeId: string,
    instanceId: string,
    listener: (event: HostSessionEvent) => void,
  ) => () => void;
}

/**
 * Fleet state plus one adapter per instance. Every backend-specific call goes
 * through a facet that the instance's adapter advertises; anything else is a
 * 409 (UnsupportedError) rather than a backend-name check.
 */
export class FleetHub {
  readonly state: HubStateStore;
  private readonly credentials: HubOptions["credentials"];
  private readonly adapterFactory: NonNullable<HubOptions["adapterFactory"]>;
  private readonly hasCustomAdapterFactory: boolean;
  private readonly connectorRequest?: HubOptions["connectorRequest"];
  private readonly connectorSubscribeEvents?: HubOptions["connectorSubscribeEvents"];
  private readonly runtimeCredentials = new Map<string, { username: string; password: string }>();
  private readonly adapters = new Map<string, HostAdapter>();
  private readonly adapterUnsubscribers = new Map<string, () => void>();
  private readonly listeners = new Set<(event: HostSessionEvent) => void>();

  constructor(options: HubOptions = {}) {
    this.state = new HubStateStore(options.statePath);
    this.hasCustomAdapterFactory = options.adapterFactory !== undefined;
    this.credentials = options.credentials;
    this.connectorRequest = options.connectorRequest;
    this.connectorSubscribeEvents = options.connectorSubscribeEvents;
    this.adapterFactory = options.adapterFactory
      ?? ((instance, credentials) => createAdapter(instance, this.adapterDependencies(instance, credentials)));
    for (const instance of this.state.snapshot().instances) {
      const features = this.attachAdapter(instance);
      if (!sameFeatures(features, instance.features)) {
        this.state.upsertInstance({ ...instance, features });
      }
    }
  }

  listInstances(): HostInstance[] {
    return this.state.snapshot().instances;
  }

  listSessions(): HostSession[] {
    return this.state.snapshot().sessions;
  }

  async suggestWorkspacePaths(
    instanceId: string,
    prefix: string,
  ): Promise<WorkspacePathSuggestion[]> {
    return this.facet(instanceId, "workspace-suggest", (adapter) => adapter.pathSuggestions)
      .listWorkspacePathSuggestions(prefix);
  }

  listAudit(): AuditEvent[] {
    return this.state.snapshot().audit;
  }

  getInstance(instanceId: string): HostInstance {
    const instance = this.listInstances().find((candidate) => candidate.id === instanceId);
    if (!instance) throw new NotFoundError(`Unknown instance: ${instanceId}`);
    return instance;
  }

  getAdapter(instanceId: string): HostAdapter {
    const adapter = this.adapters.get(instanceId);
    if (!adapter) throw new UnavailableError(`Instance is not connected: ${instanceId}`);
    return adapter;
  }

  getSession(instanceId: string, sessionId: string): HostSession {
    const session = this.listSessions().find(
      (candidate) => candidate.instanceId === instanceId && candidate.id === sessionId,
    );
    if (!session) throw new NotFoundError(`Unknown session: ${instanceId}/${sessionId}`);
    return session;
  }

  registerInstance(
    registration: HostInstanceRegistration,
    credentials?: { username: string; password: string },
  ): HostInstance {
    validateHostInstanceRegistration(registration);
    const existing = this.listInstances().find((instance) => instance.id === registration.id);
    const backend = registration.backend ?? "codeman";
    const instance: HostInstance = {
      id: registration.id,
      label: registration.label,
      backend,
      connectionMode: registration.connectionMode,
      ...(registration.nodeId ? { nodeId: registration.nodeId } : {}),
      endpoint: registration.endpoint ?? null,
      status: existing?.status ?? "offline",
      features: [],
      capabilities: [...new Set(registration.capabilities ?? [backend])],
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
      agents: (registration.agents ?? backendDefinition(backend).defaultAgents())
        .map((agent) => ({ ...agent })),
      workspaces: (registration.workspaces ?? []).map((workspace) => ({
        ...workspace,
        providers: { ...workspace.providers },
      })),
      lastSeenAt: existing?.lastSeenAt ?? null,
      createdAt: existing?.createdAt ?? new Date().toISOString(),
    };
    validateHostInstance(instance);
    if (credentials) this.runtimeCredentials.set(instance.id, credentials);
    const registered = {
      ...instance,
      features: this.attachAdapter(instance, credentials ?? this.runtimeCredentials.get(instance.id)),
    };
    this.state.upsertInstance(registered);
    this.appendAudit("instance.registered", instance.id, {
      backend: instance.backend,
      connectionMode: instance.connectionMode,
    });
    return registered;
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

  async checkInstance(instanceId: string): Promise<HostInstance> {
    const instance = this.getInstance(instanceId);
    const adapter = this.getAdapter(instanceId);
    try {
      const [workspaces, agents] = await Promise.all([
        adapter.listWorkspaces(),
        adapter.listAgents(),
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

  async listAgents(instanceId: string): Promise<AgentProfile[]> {
    const instance = this.getInstance(instanceId);
    const agents = await this.getAdapter(instanceId).listAgents();
    this.state.upsertInstance({
      ...instance,
      agents,
      status: "online",
      lastSeenAt: new Date().toISOString(),
    });
    return agents;
  }

  async syncSessions(instanceId: string): Promise<HostSession[]> {
    const sessions = await this.sessionControl(instanceId).listSessions();
    for (const session of sessions) this.state.upsertSession(session);
    return sessions;
  }

  async createSession(
    instanceId: string,
    workspaceId: string | undefined,
    agentId: string,
    title?: string,
    workspacePath?: string,
  ): Promise<HostSession> {
    const instance = this.getInstance(instanceId);
    const control = this.sessionControl(instanceId);
    const workspace = workspaceId
      ? requireWorkspace(instance.workspaces, workspaceId)
      : this.resolveWorkspacePath(instance, workspacePath);
    const agent = instance.agents.find((candidate) => candidate.id === agentId);
    if (!agent || !agent.ready) throw new Error(`Agent is not ready: ${agentId}`);
    let session: HostSession;
    try {
      session = await control.createSession(workspace, agent, title);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to create session";
      if (/workingDir does not exist|does not exist|ENOENT/i.test(message)) {
        throw new Error(
          `Workspace path does not exist on that host: ${workspace.canonicalPath}. `
          + "Use a path that exists on that machine (for WSL, prefer /home/... or /mnt/...).",
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
    await this.sessionControl(instanceId).sendInput(sessionId, input, raw);
  }

  async resizeSession(instanceId: string, sessionId: string, cols: number, rows: number): Promise<void> {
    this.assertSession(instanceId, sessionId);
    await this.sessionControl(instanceId).resize(sessionId, cols, rows);
  }

  async proxyTerminal(
    instanceId: string,
    sessionId: string,
    request: IncomingMessage,
    clientSocket: Duplex,
    head: Buffer,
  ): Promise<void> {
    const terminal = this.facet(instanceId, "terminal", (adapter) => adapter.terminalProxy);
    if (!this.listSessions().some(
      (session) => session.instanceId === instanceId && session.id === sessionId,
    )) {
      const remoteSession = (await this.sessionControl(instanceId).listSessions())
        .find((session) => session.id === sessionId);
      if (!remoteSession) throw new NotFoundError(`Unknown session: ${instanceId}/${sessionId}`);
      this.state.upsertSession(remoteSession);
    }
    await terminal.proxyTerminal(sessionId, request, clientSocket, head);
  }

  /** Proxies the instance's own UI on the Hub origin. */
  async proxyNativeUi(
    instanceId: string,
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    await this.nativeUi(instanceId).proxyHttp(request, response);
  }

  /** Backend-specific setup before the native UI opens (Codeman seeds cases). */
  async prepareNativeUi(instanceId: string): Promise<void> {
    await this.nativeUi(instanceId).prepareNativeUi?.();
  }

  supportsFeature(instanceId: string, feature: BackendFeature): boolean {
    return this.adapters.get(instanceId)?.features.includes(feature) ?? false;
  }

  async stopSession(instanceId: string, sessionId: string): Promise<void> {
    this.assertSession(instanceId, sessionId);
    await this.sessionControl(instanceId).stopSession(sessionId);
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

  subscribeEvents(listener: (event: HostSessionEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private adapterDependencies(
    instance: HostInstance,
    credentials?: Credentials,
  ): AdapterDependencies {
    const { nodeId } = instance;
    const connector = nodeId && this.connectorRequest && this.connectorSubscribeEvents
      ? {
          request: (operation: CodemanConnectorOperation, payload?: Record<string, unknown>) =>
            this.connectorRequest!(nodeId, instance.id, operation, payload),
          subscribeEvents: (listener: (event: HostSessionEvent) => void) =>
            this.connectorSubscribeEvents!(nodeId, instance.id, listener),
        }
      : undefined;
    return {
      ...(credentials ? { credentials } : {}),
      ...(connector ? { connector } : {}),
    };
  }

  /** Attaches the instance's adapter and returns the features it advertises. */
  private attachAdapter(instance: HostInstance, credentials?: Credentials): BackendFeature[] {
    this.adapterUnsubscribers.get(instance.id)?.();
    this.adapterUnsubscribers.delete(instance.id);
    this.adapters.delete(instance.id);
    if (instance.connectionMode === "connector") {
      if (
        !instance.nodeId
        || (!this.hasCustomAdapterFactory
          && (!this.connectorRequest || !this.connectorSubscribeEvents))
      ) return [];
    } else if (!instance.endpoint) {
      return [];
    }
    const adapter = this.adapterFactory(
      instance,
      credentials ?? this.credentials?.[instance.id],
    );
    this.adapters.set(instance.id, adapter);
    const unsubscribe = adapter.subscribeEvents?.((event) => {
      this.updateSessionFromEvent(instance.id, event);
      for (const listener of this.listeners) listener(event);
    });
    if (unsubscribe) this.adapterUnsubscribers.set(instance.id, unsubscribe);
    return [...adapter.features];
  }

  private sessionControl(instanceId: string): SessionControl {
    return this.facet(instanceId, "sessions", (adapter) => adapter.sessionControl);
  }

  private nativeUi(instanceId: string): NativeUiProxy {
    return this.facet(instanceId, "native-ui-proxy", (adapter) => adapter.nativeUi);
  }

  private facet<T extends SessionControl | TerminalProxy | NativeUiProxy | PathSuggestions>(
    instanceId: string,
    feature: BackendFeature,
    select: (adapter: HostAdapter) => T | undefined,
  ): T {
    const instance = this.getInstance(instanceId);
    const adapter = this.getAdapter(instanceId);
    const facet = adapter.features.includes(feature) ? select(adapter) : undefined;
    if (!facet) {
      throw new UnsupportedError(
        `${backendDefinition(instance.backend).label} instance ${instanceId} does not support ${feature}`,
      );
    }
    return facet;
  }

  private updateSessionFromEvent(instanceId: string, event: HostSessionEvent): void {
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
    if (!exists) throw new NotFoundError(`Unknown session: ${instanceId}/${sessionId}`);
  }

  private resolveWorkspacePath(
    instance: HostInstance,
    workspacePath: string | undefined,
  ): WorkspaceDescriptor {
    if (!workspacePath?.trim()) throw new Error("workspaceId or workspacePath is required");
    const path = workspacePath.trim();
    const known = instance.workspaces.find((workspace) => workspace.canonicalPath === path);
    if (known) return requireWorkspace(instance.workspaces, known.id);
    const policy = instance.workspacePolicy;
    if (!policy) throw new Error("This instance does not allow arbitrary workspace paths");
    if (!isPathAllowed(path, policy)) {
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
  event: HostSessionEvent["event"],
  current: HostSession["status"],
): HostSession["status"] {
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

function sameFeatures(left: readonly BackendFeature[], right: readonly BackendFeature[]): boolean {
  return left.length === right.length && left.every((feature, index) => feature === right[index]);
}
