import type { IncomingMessage, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import type {
  AgentProfile,
  BackendFeature,
  HostInstance,
  HostSession,
  HostSessionEvent,
  WorkspaceDescriptor,
  WorkspacePathSuggestion,
} from "../../../../packages/protocol/src/index.ts";
import {
  isRecord,
  validateHostInstance,
} from "../../../../packages/protocol/src/index.ts";
import type {
  ConnectorChannel,
  HostAdapter,
  NativeUiProxy,
  PathSuggestions,
  SessionControl,
  TerminalProxy,
} from "../contract.ts";
import { proxyHttpRequest } from "../shared/http-proxy.ts";
import { readSseStream } from "../shared/sse.ts";
import { proxyWebSocket } from "../shared/ws-relay.ts";
import {
  type CodemanEnvelope,
  type CodemanStatus,
  codemanEventKind,
  codemanEventSessionId,
  codemanSessionStatus,
  codemanTimestamp,
  dedupeAgents,
  normalizeCodemanAgent,
} from "./wire.ts";

export interface CodemanHttpAdapterOptions {
  instance: HostInstance;
  fetchImpl?: typeof fetch;
  username?: string;
  password?: string;
}

export interface CodemanConnectorAdapterOptions extends ConnectorChannel {
  instance: HostInstance;
}

export const CODEMAN_HTTP_FEATURES: readonly BackendFeature[] = [
  "sessions",
  "terminal",
  "native-ui-proxy",
  "workspace-suggest",
];

export const CODEMAN_CONNECTOR_FEATURES: readonly BackendFeature[] = [
  "sessions",
  "workspace-suggest",
];

interface SessionListData {
  sessions?: Array<Record<string, unknown>>;
}

interface SessionCreateData {
  session?: Record<string, unknown>;
}

/**
 * Adapter for one Codeman HTTP endpoint. It is used server-side, so endpoint
 * URLs and Basic credentials never cross into the dashboard.
 */
export class CodemanHttpAdapter
  implements HostAdapter, SessionControl, TerminalProxy, NativeUiProxy, PathSuggestions {
  readonly instance: HostInstance;
  readonly features = CODEMAN_HTTP_FEATURES;
  private readonly fetchImpl: typeof fetch;
  private readonly headers: Record<string, string>;
  private readonly listeners = new Set<(event: HostSessionEvent) => void>();
  private eventAbort?: AbortController;
  private inputSequence = Date.now();

  constructor(options: CodemanHttpAdapterOptions) {
    // Validation also enforces HTTPS or loopback HTTP without embedded credentials.
    this.instance = validateHostInstance(options.instance);
    if (!this.instance.endpoint) throw new Error("Codeman HTTP adapter requires an endpoint");
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.headers = { accept: "application/json" };
    if (options.username !== undefined || options.password !== undefined) {
      if (!options.username || options.password === undefined) {
        throw new Error("Codeman username and password must be provided together");
      }
      this.headers.authorization = `Basic ${Buffer.from(`${options.username}:${options.password}`).toString("base64")}`;
    }
  }

  get sessionControl(): SessionControl {
    return this;
  }

  get terminalProxy(): TerminalProxy {
    return this;
  }

  get nativeUi(): NativeUiProxy {
    return this;
  }

  get pathSuggestions(): PathSuggestions {
    return this;
  }

  async listWorkspaces(): Promise<WorkspaceDescriptor[]> {
    return this.instance.workspaces;
  }

  async listWorkspacePathSuggestions(prefix: string): Promise<WorkspacePathSuggestion[]> {
    const trimmed = prefix.trim();
    const normalizedPrefix = trimmed.toLowerCase();
    const suggestions = new Map<string, WorkspacePathSuggestion>();
    const add = (path: string, name: string) => {
      const key = path.replaceAll("\\", "/").toLowerCase();
      if (!suggestions.has(key)) suggestions.set(key, { path, name });
    };
    for (const workspace of this.instance.workspaces) {
      if (workspace.health !== "ready") continue;
      add(workspace.canonicalPath, workspace.name);
    }
    const roots = this.instance.workspacePolicy?.roots ?? [];
    for (const root of roots) {
      const segments = root.replaceAll("\\", "/").split("/").filter(Boolean);
      add(root, segments.at(-1) ?? root);
    }
    // Direct Codeman HTTP mode has no remote filesystem listing API, so the
    // Hub can only complete against registered workspaces and policy roots.
    return [...suggestions.values()]
      .filter((suggestion) => {
        if (!normalizedPrefix) return true;
        const path = suggestion.path.toLowerCase();
        return path.startsWith(normalizedPrefix)
          || suggestion.name.toLowerCase().startsWith(normalizedPrefix)
          || normalizedPrefix.startsWith(path);
      })
      .slice(0, 50);
  }

  async getStatus(): Promise<CodemanStatus> {
    const data = await this.requestData<Record<string, unknown>>("/api/v1/status");
    const status: CodemanStatus = {};
    if (typeof data.version === "string") status.version = data.version;
    if (typeof data.sessions === "number") status.sessions = data.sessions;
    if (Array.isArray(data.capabilities)) {
      status.capabilities = data.capabilities.filter(
        (capability): capability is string => typeof capability === "string",
      );
    }
    if (Array.isArray(data.agents)) status.agents = normalizeAgents(data.agents);
    return status;
  }

  async listAgents(): Promise<AgentProfile[]> {
    const status = await this.getStatus();
    if (status.agents && status.agents.length > 0) return status.agents;
    const fromCapabilities = normalizeAgents(status.capabilities ?? []);
    if (fromCapabilities.length > 0) return fromCapabilities;
    return this.instance.agents.map((agent) => ({ ...agent }));
  }

  async listSessions(): Promise<HostSession[]> {
    const data = await this.requestData<SessionListData | Array<Record<string, unknown>>>(
      "/api/v1/sessions",
    );
    const sessions = Array.isArray(data) ? data : data.sessions ?? [];
    return Promise.all(sessions.map(async (session) => {
      const normalized = this.toSession(session);
      const terminal = await this.readTerminal(normalized.id);
      return terminal
        ? {
            ...normalized,
            status: codemanSessionStatus(terminal.status ?? String(session.status ?? "")),
            terminalBuffer: terminal.terminalBuffer === undefined
              ? normalized.terminalBuffer
              : terminal.terminalBuffer,
          }
        : normalized;
    }));
  }

  async createSession(
    workspace: WorkspaceDescriptor,
    agent: AgentProfile,
    title = `${agent.name} · ${workspace.name}`,
  ): Promise<HostSession> {
    const data = await this.requestData<SessionCreateData>("/api/v1/sessions", {
      method: "POST",
      body: {
        workingDir: workspace.canonicalPath,
        mode: agent.mode,
        name: title,
      },
    });
    const session = this.toSession(
      data.session ?? (data as unknown as Record<string, unknown>),
      workspace.id,
      agent,
    );
    await this.request(`/api/v1/sessions/${encodeURIComponent(session.id)}/interactive`, {
      method: "POST",
    });
    this.emit(this.event(session.id, "started", undefined, session.lastEventAt));
    return { ...session, status: "working" };
  }

  async sendInput(sessionId: string, input: string, raw = false): Promise<void> {
    await this.request(`/api/v1/sessions/${encodeURIComponent(sessionId)}/input`, {
      method: "POST",
      body: {
        input: raw ? input : `${input.replaceAll(/\r?\n/g, " ")}${input.endsWith("\r") ? "" : "\r"}`,
        useMux: !raw,
        clientId: `cloudagentfleet-${this.instance.id}`,
        seq: ++this.inputSequence,
      },
    });
  }

  async resize(sessionId: string, cols: number, rows: number): Promise<void> {
    await this.request(`/api/v1/sessions/${encodeURIComponent(sessionId)}/resize`, {
      method: "POST",
      body: { cols, rows, viewportType: "desktop" },
    });
  }

  async stopSession(sessionId: string): Promise<void> {
    await this.request(`/api/v1/sessions/${encodeURIComponent(sessionId)}`, {
      method: "DELETE",
    });
    this.emit(this.event(sessionId, "stopped", undefined, new Date().toISOString()));
  }

  async proxyTerminal(
    sessionId: string,
    request: IncomingMessage,
    clientSocket: Duplex,
    head: Buffer,
  ): Promise<void> {
    const query = typeof request.url === "string"
      ? new URL(request.url, "http://controller.local").search
      : "";
    await proxyWebSocket(request, clientSocket, head, {
      endpoint: new URL(this.instance.endpoint!),
      path: `/ws/sessions/${encodeURIComponent(sessionId)}/terminal${query}`,
      authorization: this.basicAuthorization,
      label: "Codeman",
    });
  }

  /**
   * Best-effort: ensure Codeman "cases" exist for Hub workspaces so the
   * native Codeman Quick Start / New Session UI can create sessions.
   */
  async prepareNativeUi(): Promise<void> {
    const workspaces = this.instance.workspaces.filter(
      (workspace) => typeof workspace.canonicalPath === "string" && workspace.canonicalPath.length > 0,
    );
    if (workspaces.length === 0) return;

    let existingNames = new Set<string>();
    try {
      const data = await this.requestData<unknown>("/api/cases");
      const cases = Array.isArray(data)
        ? data
        : isRecord(data) && Array.isArray(data.cases)
          ? data.cases
          : [];
      existingNames = new Set(
        cases
          .map((entry) => (isRecord(entry) ? String(entry.name ?? "") : ""))
          .filter(Boolean),
      );
    } catch {
      // Older Codeman builds may not expose /api/cases; native UI remains usable.
      return;
    }

    for (const workspace of workspaces) {
      const candidates = uniqueCaseNames(workspace.name, workspace.id);
      if (candidates.some((name) => existingNames.has(name))) continue;
      const name = candidates[0]!;
      try {
        await this.request("/api/cases/link", {
          method: "POST",
          body: { name, path: workspace.canonicalPath },
        });
        existingNames.add(name);
      } catch (error) {
        const message = error instanceof Error ? error.message : "";
        if (/already exists/i.test(message)) {
          existingNames.add(name);
          continue;
        }
        // Keep selecting the host even when a single workspace cannot be linked.
      }
    }
  }

  /** Codeman keeps no browser session; Basic auth is injected server-side. */
  readonly browserCookieNames: readonly string[] = [];

  async proxyHttp(request: IncomingMessage, response: ServerResponse): Promise<void> {
    await proxyHttpRequest(request, response, {
      endpoint: new URL(this.instance.endpoint!),
      authorization: this.basicAuthorization,
      label: "Codeman",
      injectSwitcher: true,
    });
  }

  async proxyUpgrade(request: IncomingMessage, clientSocket: Duplex, head: Buffer): Promise<void> {
    const requestUrl = new URL(request.url ?? "/", "http://controller.local");
    await proxyWebSocket(request, clientSocket, head, {
      endpoint: new URL(this.instance.endpoint!),
      path: `${requestUrl.pathname}${requestUrl.search}`,
      authorization: this.basicAuthorization,
      label: "Codeman",
    });
  }

  subscribeEvents(onEvent: (event: HostSessionEvent) => void): () => void {
    this.listeners.add(onEvent);
    if (!this.eventAbort) void this.startEventStream();
    return () => {
      this.listeners.delete(onEvent);
      if (this.listeners.size === 0) {
        this.eventAbort?.abort();
        this.eventAbort = undefined;
      }
    };
  }

  private async startEventStream(): Promise<void> {
    const abort = new AbortController();
    this.eventAbort = abort;
    const response = await this.fetchImpl(`${this.baseUrl()}/api/v1/events`, {
      headers: { ...this.headers, accept: "text/event-stream" },
      signal: abort.signal,
    }).catch(() => undefined);
    if (response?.ok && response.body) {
      await readSseStream(response.body, abort.signal, (frame) => {
        let event: HostSessionEvent | undefined;
        try {
          const parsed = JSON.parse(frame.data) as unknown;
          const payload: Record<string, unknown> = isRecord(parsed) ? parsed : { data: parsed };
          if (frame.event && payload.type === undefined && payload.event === undefined) {
            payload.type = frame.event;
          }
          event = this.toEvent(payload);
        } catch {
          // Ignore malformed provider events; the HTTP control path remains usable.
        }
        if (event) this.emit(event);
      });
    }
    if (this.eventAbort === abort) this.eventAbort = undefined;
  }

  private async readTerminal(
    sessionId: string,
  ): Promise<{ terminalBuffer?: string; status?: string } | undefined> {
    try {
      return await this.requestData<{ terminalBuffer?: string; status?: string }>(
        `/api/v1/sessions/${encodeURIComponent(sessionId)}/terminal?tail=20000`,
      );
    } catch {
      return undefined;
    }
  }

  private toSession(
    raw: Record<string, unknown>,
    workspaceId?: string,
    agent?: AgentProfile,
  ): HostSession {
    const id = String(raw.id ?? "");
    if (!id) throw new Error("Codeman returned a session without an ID");
    const resolvedWorkspaceId = workspaceId
      ?? this.workspaceIdForPath(String(raw.workspaceId ?? raw.workingDir ?? ""));
    const resolvedAgent = agent ?? normalizeCodemanAgent(String(raw.mode ?? "")) ?? shellAgent();
    const createdAt = codemanTimestamp(raw.createdAt ?? raw.created_at);
    return {
      id,
      instanceId: this.instance.id,
      workspaceId: resolvedWorkspaceId,
      agent: resolvedAgent,
      title: String(raw.name ?? id),
      status: codemanSessionStatus(String(raw.status ?? "idle")),
      terminalBuffer: String(raw.terminalBuffer ?? ""),
      needsInput: false,
      previewAvailable: false,
      browserAvailable: false,
      createdAt,
      lastEventAt: codemanTimestamp(raw.lastEventAt ?? raw.last_event_at ?? createdAt),
    };
  }

  private toEvent(raw: Record<string, unknown>): HostSessionEvent | undefined {
    const sessionId = codemanEventSessionId(raw);
    if (!sessionId) return undefined;
    const kind = codemanEventKind(String(raw.type ?? raw.event ?? ""));
    if (!kind) return undefined;
    return this.event(
      sessionId,
      kind,
      raw.data ?? raw.output ?? raw.text,
      codemanTimestamp(raw.createdAt ?? raw.created_at),
    );
  }

  private workspaceIdForPath(path: string): string {
    const workspace = this.instance.workspaces.find(
      (candidate) => candidate.id === path || candidate.canonicalPath === path,
    );
    return workspace?.id ?? (path || "unknown");
  }

  private event(
    sessionId: string,
    event: HostSessionEvent["event"],
    data: unknown,
    createdAt: string,
  ): HostSessionEvent {
    return {
      instanceId: this.instance.id,
      sessionId,
      event,
      ...(data === undefined
        ? {}
        : { data: typeof data === "string" ? data : JSON.stringify(data) }),
      createdAt,
    };
  }

  private emit(event: HostSessionEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  private baseUrl(): string {
    return this.instance.endpoint!.replace(/\/+$/, "");
  }

  private get basicAuthorization(): string | undefined {
    return this.headers.authorization;
  }

  private async requestData<T>(path: string, options: RequestOptions = {}): Promise<T> {
    const envelope = await this.request<T>(path, options);
    if (envelope.data === undefined) throw new Error("Codeman response did not include data");
    return envelope.data;
  }

  private async request<T>(path: string, options: RequestOptions = {}): Promise<CodemanEnvelope<T>> {
    const response = await this.fetchImpl(`${this.baseUrl()}${path}`, {
      method: options.method ?? "GET",
      headers: {
        ...this.headers,
        ...(options.body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: options.signal,
    });
    const text = await response.text();
    if (response.status === 401) throw new Error("Codeman request unauthorized");
    if (!text) {
      if (response.ok) return { success: true } as CodemanEnvelope<T>;
      throw new Error(`Codeman request failed with HTTP ${response.status}`);
    }
    let envelope: CodemanEnvelope<T>;
    try {
      envelope = JSON.parse(text) as CodemanEnvelope<T>;
    } catch {
      throw new Error(`Codeman returned invalid JSON with HTTP ${response.status}`);
    }
    if (!response.ok || envelope.success === false) {
      throw new Error(envelope.error ?? `Codeman request failed with HTTP ${response.status}`);
    }
    return envelope;
  }
}

/**
 * Adapter for a Codeman endpoint reached through the Worker's connector
 * channel. The operation enum is deliberately allowlisted; callers cannot
 * turn the connector into an arbitrary HTTP proxy.
 */
export class CodemanConnectorAdapter implements HostAdapter, SessionControl, PathSuggestions {
  readonly instance: HostInstance;
  readonly features = CODEMAN_CONNECTOR_FEATURES;
  private readonly request: ConnectorChannel["request"];
  private readonly subscribe: ConnectorChannel["subscribeEvents"];

  constructor(options: CodemanConnectorAdapterOptions) {
    this.instance = validateHostInstance(options.instance);
    if (this.instance.connectionMode !== "connector") {
      throw new Error("Codeman connector adapter requires connector mode");
    }
    this.request = options.request;
    this.subscribe = options.subscribeEvents;
  }

  get sessionControl(): SessionControl {
    return this;
  }

  get pathSuggestions(): PathSuggestions {
    return this;
  }

  async getStatus(): Promise<CodemanStatus> {
    return this.request("status") as Promise<CodemanStatus>;
  }

  async listAgents(): Promise<AgentProfile[]> {
    const data = await this.request("capabilities");
    const agents = isRecord(data) && Array.isArray(data.agents) ? data.agents : data;
    if (!Array.isArray(agents)) return this.instance.agents.map((agent) => ({ ...agent }));
    return normalizeAgents(agents);
  }

  async listWorkspaces(): Promise<WorkspaceDescriptor[]> {
    const data = await this.request("workspaces");
    return Array.isArray(data) ? data.map((workspace) => workspace as WorkspaceDescriptor) : [];
  }

  async listWorkspacePathSuggestions(prefix: string): Promise<WorkspacePathSuggestion[]> {
    const data = await this.request("workspaces.suggest", { prefix });
    return Array.isArray(data) ? data.map((suggestion) => suggestion as WorkspacePathSuggestion) : [];
  }

  async listSessions(): Promise<HostSession[]> {
    const data = await this.request("sessions.list");
    const sessions = isRecord(data) && Array.isArray(data.sessions) ? data.sessions : data;
    if (!Array.isArray(sessions)) return [];
    return sessions.map((session) => this.toSession(session));
  }

  async createSession(
    workspace: WorkspaceDescriptor,
    agent: AgentProfile,
    title = `${agent.name} · ${workspace.name}`,
  ): Promise<HostSession> {
    const knownWorkspace = this.instance.workspaces.some(
      (candidate) => candidate.id === workspace.id
        || candidate.canonicalPath === workspace.canonicalPath,
    );
    const data = await this.request("sessions.create", {
      ...(knownWorkspace
        ? { workspaceId: workspace.id }
        : { workspacePath: workspace.canonicalPath }),
      agent,
      title,
    });
    const raw = isRecord(data) && isRecord(data.session) ? data.session : data;
    return this.toSession(raw, workspace.id, agent);
  }

  async sendInput(sessionId: string, input: string, raw = false): Promise<void> {
    await this.request("sessions.input", {
      sessionId,
      input,
      raw,
    });
  }

  async resize(sessionId: string, cols: number, rows: number): Promise<void> {
    await this.request("sessions.resize", { sessionId, cols, rows });
  }

  async stopSession(sessionId: string): Promise<void> {
    await this.request("sessions.stop", { sessionId });
  }

  subscribeEvents(onEvent: (event: HostSessionEvent) => void): () => void {
    return this.subscribe(onEvent);
  }

  private toSession(
    raw: unknown,
    workspaceId?: string,
    agent?: AgentProfile,
  ): HostSession {
    if (!isRecord(raw)) throw new Error("Connector returned an invalid session");
    const id = String(raw.id ?? "");
    if (!id) throw new Error("Connector returned a session without an ID");
    const resolvedWorkspaceId = workspaceId
      ?? String(raw.workspaceId ?? raw.workingDir ?? "unknown");
    const resolvedAgent = agent ?? normalizeCodemanAgent(raw.mode) ?? shellAgent();
    const createdAt = codemanTimestamp(raw.createdAt ?? raw.created_at);
    return {
      id,
      instanceId: this.instance.id,
      workspaceId: resolvedWorkspaceId,
      agent: resolvedAgent,
      title: String(raw.name ?? id),
      status: codemanSessionStatus(String(raw.status ?? "idle")),
      terminalBuffer: String(raw.terminalBuffer ?? ""),
      needsInput: false,
      previewAvailable: false,
      browserAvailable: false,
      createdAt,
      lastEventAt: codemanTimestamp(raw.lastEventAt ?? raw.last_event_at ?? createdAt),
    };
  }
}

function normalizeAgents(raw: unknown[]): AgentProfile[] {
  return dedupeAgents(
    raw
      .map((agent) => normalizeCodemanAgent(agent))
      .filter((agent): agent is AgentProfile => agent !== undefined),
  );
}

function shellAgent(): AgentProfile {
  return { id: "shell", name: "Shell (raw CLI)", mode: "shell", ready: true };
}

function uniqueCaseNames(...values: Array<string | undefined>): string[] {
  const names: string[] = [];
  for (const value of values) {
    const name = String(value ?? "")
      .trim()
      .replace(/[^\w.-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 64);
    if (name && !names.includes(name)) names.push(name);
  }
  return names;
}

interface RequestOptions {
  method?: string;
  body?: unknown;
  signal?: AbortSignal;
}
