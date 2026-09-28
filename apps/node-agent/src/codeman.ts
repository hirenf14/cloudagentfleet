import { readdir, realpath } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import type {
  AgentJob,
  CodemanAgentProfile,
  CodemanConnectorRequest,
  CodemanSessionEvent,
  CodemanStatus,
  ControlMessage,
  NodeMessage,
  WorkspaceDescriptor,
  WorkspacePolicy,
  WorkspacePathSuggestion,
} from "../../../packages/protocol/src/index.ts";

export type CodemanMode =
  | "claude"
  | "shell"
  | "opencode"
  | "codex"
  | "gemini"
  | "antigravity"
  | "pi"
  | "grok"
  | "deepseek";

interface CodemanEnvelope<T> {
  success: boolean;
  data?: T;
  error?: string;
  errorCode?: string;
}

interface CodemanSession {
  id: string;
}

interface CreateSessionData {
  session: CodemanSession;
}

interface InputData {
  delivered?: boolean;
  duplicate?: boolean;
  wait?: {
    timedOut?: boolean;
    ended?: boolean;
    aborted?: boolean;
    signal?: string | null;
  };
}

interface LastResponseData {
  text: string;
  timestamp: number;
}

export interface CodemanClientOptions {
  baseUrl: string;
  username?: string;
  password?: string;
  fetchImpl?: typeof fetch;
  waitTimeoutMs?: number;
}

export interface CodemanCreateSessionOptions {
  workingDir: string;
  mode: CodemanMode;
  name: string;
}

export interface CodemanProviderEvent {
  sessionId: string;
  type: string;
  data?: unknown;
  createdAt: string;
}

export class CodemanApiError extends Error {
  readonly status: number;
  readonly errorCode?: string;

  constructor(status: number, message: string, errorCode?: string) {
    super(message);
    this.name = "CodemanApiError";
    this.status = status;
    this.errorCode = errorCode;
  }
}

/**
 * Thin client for Codeman's supported HTTP API.
 *
 * Codeman owns PTYs, tmux persistence, terminal streaming, and provider CLI
 * invocation. Hosted Agents only creates a session, submits a prompt, waits for
 * the definitive stop/exit signal, and reads the clean response.
 */
export class CodemanClient {
  private readonly baseUrl: string;
  private readonly headers: Record<string, string>;
  private readonly fetchImpl: typeof fetch;
  private readonly waitTimeoutMs: number;
  private inputSequence = Date.now();

  constructor(options: CodemanClientOptions) {
    const baseUrl = options.baseUrl.endsWith("/")
      ? options.baseUrl.slice(0, -1)
      : options.baseUrl;
    const parsed = new URL(baseUrl);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error("Codeman URL must use HTTP or HTTPS");
    }

    this.baseUrl = baseUrl;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.waitTimeoutMs = options.waitTimeoutMs ?? 60_000;
    this.headers = { accept: "application/json" };

    if (options.username !== undefined || options.password !== undefined) {
      if (!options.username || options.password === undefined) {
        throw new Error("Codeman username and password must be provided together");
      }
      this.headers.authorization = `Basic ${Buffer.from(
        `${options.username}:${options.password}`,
      ).toString("base64")}`;
    }
  }

  async createSession(options: CodemanCreateSessionOptions): Promise<CodemanSession> {
    const envelope = await this.request<CreateSessionData>("/api/v1/sessions", {
      method: "POST",
      body: {
        workingDir: options.workingDir,
        mode: options.mode,
        name: options.name,
      },
    });
    if (!envelope.data?.session?.id) {
      throw new CodemanApiError(200, "Codeman returned no session ID");
    }
    return envelope.data.session;
  }

  async status(): Promise<CodemanStatus & Record<string, unknown>> {
    return this.requestData<CodemanStatus & Record<string, unknown>>("/api/v1/status");
  }

  async listSessions(includeTerminal = false): Promise<Array<Record<string, unknown>>> {
    const data = await this.requestData<
      { sessions?: Array<Record<string, unknown>> } | Array<Record<string, unknown>>
    >("/api/v1/sessions");
    const sessions = Array.isArray(data) ? data : data.sessions ?? [];
    if (!includeTerminal) return sessions;
    return Promise.all(sessions.map(async (session) => {
      const sessionId = typeof session.id === "string" ? session.id : "";
      if (!sessionId) return session;
      try {
        const terminal = await this.requestData<{
          terminalBuffer?: string;
          status?: string;
        }>(`/api/v1/sessions/${encodeURIComponent(sessionId)}/terminal?tail=20000`);
        return {
          ...session,
          ...(terminal.terminalBuffer === undefined ? {} : { terminalBuffer: terminal.terminalBuffer }),
          ...(terminal.status === undefined ? {} : { status: terminal.status }),
        };
      } catch {
        return session;
      }
    }));
  }

  async startInteractive(sessionId: string): Promise<void> {
    await this.request(`/api/v1/sessions/${encodeURIComponent(sessionId)}/interactive`, {
      method: "POST",
    });
  }

  async sendPrompt(
    sessionId: string,
    prompt: string,
    clientId: string,
    seq: number,
    signal?: AbortSignal,
  ): Promise<InputData> {
    const input = `${prompt.replaceAll(/\r?\n/g, " ")}\r`;
    return this.requestData<InputData>(
      `/api/v1/sessions/${encodeURIComponent(sessionId)}/input`,
      {
        method: "POST",
        body: {
          input,
          useMux: true,
          clientId,
          seq,
          wait: true,
          waitTimeout: this.waitTimeoutMs,
        },
        signal,
      },
    );
  }

  async sendInput(sessionId: string, input: string, raw = false): Promise<void> {
    const deliveredInput = raw
      ? input
      : `${input.replaceAll(/\r?\n/g, " ")}${input.endsWith("\r") ? "" : "\r"}`;
    await this.request(`/api/v1/sessions/${encodeURIComponent(sessionId)}/input`, {
      method: "POST",
      body: {
        input: deliveredInput,
        useMux: !raw,
        clientId: "hosted-agents-connector",
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

  async waitForCompletion(
    sessionId: string,
    signal?: AbortSignal,
  ): Promise<InputData["wait"]> {
    while (true) {
      const data = await this.requestData<InputData>(
        `/api/v1/sessions/${encodeURIComponent(sessionId)}/wait?until=stop,exit&timeout=${this.waitTimeoutMs}`,
        { signal },
      );
      if (!data.wait?.timedOut) return data.wait;
    }
  }

  async lastResponse(sessionId: string, signal?: AbortSignal): Promise<LastResponseData> {
    return this.requestData<LastResponseData>(
      `/api/v1/sessions/${encodeURIComponent(sessionId)}/last-response`,
      { signal },
    );
  }

  async deleteSession(sessionId: string, signal?: AbortSignal): Promise<void> {
    await this.request(
      `/api/v1/sessions/${encodeURIComponent(sessionId)}`,
      { method: "DELETE", signal },
    );
  }

  subscribeEvents(onEvent: (event: CodemanProviderEvent) => void): () => void {
    const abort = new AbortController();
    void this.readEvents(abort.signal, onEvent);
    return () => abort.abort();
  }

  private async readEvents(
    signal: AbortSignal,
    onEvent: (event: CodemanProviderEvent) => void,
  ): Promise<void> {
    const response = await this.fetchImpl(`${this.baseUrl}/api/v1/events`, {
      headers: { ...this.headers, accept: "text/event-stream" },
      signal,
    }).catch(() => undefined);
    if (!response?.ok || !response.body) return;
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      while (!signal.aborted) {
        const result = await reader.read();
        if (result.done) return;
        buffer += decoder.decode(result.value, { stream: true });
        let boundary = sseBoundary(buffer);
        while (boundary) {
          const raw = buffer.slice(0, boundary.index);
          buffer = buffer.slice(boundary.index + boundary.length);
          boundary = sseBoundary(buffer);
          const data = raw.split(/\r?\n/)
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).trimStart())
            .join("\n");
          if (!data) continue;
          try {
            const parsed = JSON.parse(data) as Record<string, unknown>;
            const nestedSession = isRecord(parsed.session) ? parsed.session : undefined;
            const nestedData = isRecord(parsed.data) ? parsed.data : undefined;
            const sessionId = String(
              parsed.sessionId
              ?? parsed.session_id
              ?? nestedSession?.id
              ?? nestedData?.sessionId
              ?? nestedData?.session_id
              ?? "",
            );
            if (!sessionId) continue;
            onEvent({
              sessionId,
              type: String(
                parsed.type
                ?? parsed.event
                ?? raw.split(/\r?\n/).find((line) => line.startsWith("event:"))
                  ?.slice("event:".length).trim()
                ?? "",
              ).toLowerCase(),
              data: parsed.data ?? parsed.output ?? parsed.text,
              createdAt: providerTimestamp(parsed.createdAt ?? parsed.created_at),
            });
          } catch {
            // Ignore malformed provider events.
          }
        }
      }
    } catch {
      // The connector control path remains usable if the event stream closes.
    } finally {
      reader.releaseLock();
    }
  }

  private async requestData<T>(
    path: string,
    options: {
      method?: string;
      body?: unknown;
      signal?: AbortSignal;
    } = {},
  ): Promise<T> {
    const envelope = await this.request<T>(path, options);
    if (envelope.data === undefined) {
      throw new CodemanApiError(200, "Codeman response did not include data");
    }
    return envelope.data;
  }

  private async request<T>(
    path: string,
    options: {
      method?: string;
      body?: unknown;
      signal?: AbortSignal;
    } = {},
  ): Promise<CodemanEnvelope<T>> {
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method: options.method ?? "GET",
      headers: {
        ...this.headers,
        ...(options.body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: options.signal,
    });
    const text = await response.text();
    let envelope: CodemanEnvelope<T>;
    try {
      envelope = JSON.parse(text) as CodemanEnvelope<T>;
    } catch {
      throw new CodemanApiError(response.status, text || response.statusText);
    }
    if (!response.ok || envelope.success === false) {
      throw new CodemanApiError(
        response.status,
        envelope.error ?? `Codeman request failed with HTTP ${response.status}`,
        envelope.errorCode,
      );
    }
    return envelope;
  }
}

export interface CodemanWorkerRuntimeOptions {
  client: CodemanClient;
  nodeId: string;
  instanceId?: string;
  workspaces: WorkspaceDescriptor[];
  workspacePolicy: WorkspacePolicy;
  send: (message: NodeMessage) => Promise<void>;
  mode?: CodemanMode;
  agentProfiles?: CodemanAgentProfile[];
  cursorCommand?: string;
  claudeCommand?: string;
}

interface ActiveJob {
  sessionId: string;
  abortController: AbortController;
}

/**
 * Turns a Controller job assignment into a real Codeman-backed agent run.
 */
export class CodemanWorkerRuntime {
  private readonly client: CodemanClient;
  private readonly nodeId: string;
  private readonly instanceId: string;
  private readonly workspaces: WorkspaceDescriptor[];
  private readonly workspacePolicy: WorkspacePolicy;
  private readonly send: (message: NodeMessage) => Promise<void>;
  private readonly mode: CodemanMode;
  private readonly agentProfiles: CodemanAgentProfile[];
  private readonly cursorCommand?: string;
  private readonly claudeCommand?: string;
  private readonly activeJobs = new Map<string, ActiveJob>();

  constructor(options: CodemanWorkerRuntimeOptions) {
    this.client = options.client;
    this.nodeId = options.nodeId;
    this.instanceId = options.instanceId ?? options.nodeId;
    this.workspaces = options.workspaces;
    this.workspacePolicy = options.workspacePolicy;
    this.send = options.send;
    this.mode = options.mode ?? "claude";
    this.agentProfiles = options.agentProfiles?.map((agent) => ({ ...agent })) ?? [];
    this.cursorCommand = options.cursorCommand;
    this.claudeCommand = options.claudeCommand;
  }

  async handle(message: ControlMessage): Promise<void> {
    if (message.type === "job.assign") {
      await this.assign(message.job);
      return;
    }
    if (message.type === "job.cancel") {
      await this.cancel(message.jobId);
    }
  }

  async handleConnectorRequest(request: CodemanConnectorRequest): Promise<unknown> {
    if (request.instanceId !== this.instanceId) {
      throw new Error("Connector instance authorization failed");
    }
    const payload = request.payload ?? {};
    switch (request.operation) {
      case "status":
        return this.client.status();
      case "capabilities": {
        const status = await this.client.status();
        const codemanAgents = [
          {
            id: this.mode,
            name: this.mode === "claude" ? "Claude Code" : this.mode,
            mode: this.mode,
            ready: true,
          },
          ...(status.agents ?? []),
          ...(status.capabilities ?? []),
        ];
        return [
          ...codemanAgents,
          ...this.agentProfiles.filter(
            (agent) => !codemanAgents.some((candidate) =>
              (typeof candidate === "string" ? candidate : candidate.id) === agent.id,
            ),
          ),
        ];
      }
      case "workspaces":
        return this.workspaces;
      case "workspaces.suggest":
        return this.suggestWorkspacePaths(typeof payload.prefix === "string" ? payload.prefix : "");
      case "sessions.list":
        return this.client.listSessions(true);
      case "sessions.create": {
        const workspace = typeof payload.workspaceId === "string"
          ? this.resolveWorkspace(payload.workspaceId)
          : this.resolveWorkspacePath(requiredString(payload.workspacePath, "workspacePath"));
        const agent = payload.agent;
        if (!isAgentProfile(agent)) throw new Error("Invalid connector agent");
        const session = await this.client.createSession({
          workingDir: workspace.canonicalPath,
          mode: agent.mode,
          name: typeof payload.title === "string"
            ? payload.title
            : `${agent.name} · ${workspace.name}`,
        });
        await this.client.startInteractive(session.id);
        const providerCommand = agent.id === "cursor-agent"
          ? this.cursorCommand
          : agent.id === "claude-code"
            ? this.claudeCommand
            : undefined;
        if (providerCommand) {
          await this.client.sendInput(session.id, `${providerCommand}\r`, true);
        }
        return {
          ...session,
          workspaceId: workspace.id,
          mode: agent.mode,
        };
      }
      case "sessions.input":
        await this.client.sendInput(
          requiredString(payload.sessionId, "sessionId"),
          requiredInput(payload.input, "input"),
          payload.raw === true,
        );
        return undefined;
      case "sessions.resize":
        await this.client.resize(
          requiredString(payload.sessionId, "sessionId"),
          requiredInteger(payload.cols, "cols"),
          requiredInteger(payload.rows, "rows"),
        );
        return undefined;
      case "sessions.stop":
        await this.client.deleteSession(requiredString(payload.sessionId, "sessionId"));
        return undefined;
    }
  }

  startEventForwarding(): () => void {
    return this.client.subscribeEvents((event) => {
      const mapped = this.toSessionEvent(event);
      if (!mapped) return;
      void this.send({
        type: "codeman.session.event",
        instanceId: this.instanceId,
        event: mapped,
      }).catch(() => undefined);
    });
  }

  private async assign(job: AgentJob): Promise<void> {
    if (job.provider !== "codeman") {
      throw new Error(`Codeman runtime cannot execute provider: ${job.provider}`);
    }
    if (this.activeJobs.has(job.id)) return;

    const workspace = this.resolveWorkspace(job.workspaceId);
    const abortController = new AbortController();
    const session = await this.client.createSession({
      workingDir: workspace.canonicalPath,
      mode: this.mode,
      name: `hosted-${this.nodeId}-${job.id}`,
    });
    this.activeJobs.set(job.id, { sessionId: session.id, abortController });

    try {
      await this.send({
        type: "job.accept",
        jobId: job.id,
        idempotencyKey: job.idempotencyKey,
      });
      await this.send({ type: "job.event", jobId: job.id, event: "started" });
      await this.client.startInteractive(session.id);
      const input = await this.client.sendPrompt(
        session.id,
        job.prompt,
        `hosted-agents-${this.nodeId}`,
        1,
        abortController.signal,
      );
      if (input.wait?.timedOut || !input.wait) {
        await this.client.waitForCompletion(session.id, abortController.signal);
      }
      const response = await this.readResponse(session.id, abortController.signal);
      await this.send({
        type: "job.event",
        jobId: job.id,
        event: "completed",
        data: response.text,
      });
    } catch (error) {
      if (abortController.signal.aborted) {
        await this.send({ type: "job.event", jobId: job.id, event: "cancelled" });
      } else {
        await this.send({
          type: "job.event",
          jobId: job.id,
          event: "failed",
          data: error instanceof Error ? error.message : "Codeman job failed",
        });
      }
    } finally {
      this.activeJobs.delete(job.id);
    }
  }

  private async cancel(jobId: string): Promise<void> {
    const active = this.activeJobs.get(jobId);
    if (!active) return;
    active.abortController.abort();
    await this.client.deleteSession(active.sessionId);
  }

  private async readResponse(
    sessionId: string,
    signal: AbortSignal,
  ): Promise<LastResponseData> {
    let response = await this.client.lastResponse(sessionId, signal);
    for (let attempt = 0; attempt < 10 && !response.text.trim(); attempt += 1) {
      await delay(250, signal);
      response = await this.client.lastResponse(sessionId, signal);
    }
    return response;
  }

  private resolveWorkspace(workspaceId: string): WorkspaceDescriptor {
    const workspace = this.workspaces.find((candidate) => candidate.id === workspaceId);
    if (!workspace) throw new Error(`Unknown workspace: ${workspaceId}`);
    return this.validateWorkspace(workspace);
  }

  private async suggestWorkspacePaths(prefix: string): Promise<WorkspacePathSuggestion[]> {
    const input = prefix.trim();
    if (!input && this.workspacePolicy.mode === "folders") {
      return this.workspacePolicy.roots
        .slice(0, 50)
        .map((path) => ({ path: resolve(path), name: basename(path) || path }));
    }

    const trailingSeparator = /[\\/]/.test(input.at(-1) ?? "");
    const basePath = input
      ? trailingSeparator ? input : dirname(input)
      : process.cwd();
    const fragment = input && !trailingSeparator ? basename(input).toLowerCase() : "";
    const directory = resolve(basePath);
    if (!isAllowedPath(directory, this.workspacePolicy)) return [];

    let entries: Dirent[];
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (isFileSystemError(error, "ENOENT", "ENOTDIR")) return [];
      throw error;
    }

    const suggestions: WorkspacePathSuggestion[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      if (fragment && !entry.name.toLowerCase().startsWith(fragment)) continue;
      const candidate = join(directory, entry.name);
      let canonicalCandidate: string;
      try {
        canonicalCandidate = await realpath(candidate);
      } catch (error) {
        if (isFileSystemError(error, "ENOENT", "ELOOP")) continue;
        throw error;
      }
      if (!isAllowedPath(canonicalCandidate, this.workspacePolicy)) continue;
      suggestions.push({ path: canonicalCandidate, name: entry.name });
      if (suggestions.length >= 50) break;
    }
    return suggestions.sort((left, right) => left.name.localeCompare(right.name));
  }

  private resolveWorkspacePath(workspacePath: string): WorkspaceDescriptor {
    const existing = this.workspaces.find(
      (candidate) => candidate.canonicalPath === workspacePath,
    );
    if (existing) return this.validateWorkspace(existing);
    if (!isAllowedPath(workspacePath, this.workspacePolicy)) {
      throw new Error(`Workspace is outside the worker policy: ${workspacePath}`);
    }
    return {
      id: workspacePath,
      name: workspacePath.split(/[\\/]/).filter(Boolean).at(-1) ?? workspacePath,
      canonicalPath: workspacePath,
      health: "ready",
      providers: { codeman: "ready" },
    };
  }

  private validateWorkspace(workspace: WorkspaceDescriptor): WorkspaceDescriptor {
    if (workspace.health !== "ready") {
      throw new Error(`Workspace is not ready: ${workspace.id}`);
    }
    if (workspace.providers.codeman !== "ready") {
      throw new Error("Codeman is not ready for the selected workspace");
    }
    if (!isAllowedPath(workspace.canonicalPath, this.workspacePolicy)) {
      throw new Error(`Workspace is outside the worker policy: ${workspace.id}`);
    }
    return workspace;
  }

  private toSessionEvent(event: CodemanProviderEvent): CodemanSessionEvent | undefined {
    const type = event.type;
    let mapped: CodemanSessionEvent["event"];
    if (type.includes("terminal") || type.includes("output")) mapped = "output";
    else if (type.includes("permission") || type.includes("wait")) mapped = "waiting";
    else if (type.includes("idle")) mapped = "idle";
    else if (type.includes("fail") || type.includes("error")) mapped = "failed";
    else if (type.includes("complete")) mapped = "completed";
    else if (type.includes("exit") || type.includes("delet") || type.includes("stop")) mapped = "stopped";
    else if (type.includes("start") || type.includes("run")) mapped = "started";
    else if (type.includes("create")) mapped = "created";
    else return undefined;
    return {
      instanceId: this.instanceId,
      sessionId: event.sessionId,
      event: mapped,
      ...(event.data === undefined
        ? {}
        : { data: typeof event.data === "string" ? event.data : JSON.stringify(event.data) }),
      createdAt: event.createdAt,
    };
  }
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} is required`);
  return value;
}

function requiredInput(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${field} is required`);
  return value;
}

function requiredInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 500) {
    throw new Error(`${field} must be an integer between 1 and 500`);
  }
  return value;
}

function isAgentProfile(value: unknown): value is { mode: CodemanMode; name: string } {
  if (!isRecord(value)) return false;
  const modes: CodemanMode[] = [
    "claude", "shell", "opencode", "codex", "gemini", "antigravity", "pi", "grok", "deepseek",
  ];
  return typeof value.name === "string" && modes.includes(value.mode as CodemanMode);
}

function isAllowedPath(path: string, policy: WorkspacePolicy): boolean {
  if (policy.mode === "system") return true;
  const normalizedPath = normalizePath(path);
  return policy.roots.some((root) => {
    const normalizedRoot = normalizePath(root);
    return !normalizedRoot
      || normalizedPath === normalizedRoot
      || normalizedPath.startsWith(`${normalizedRoot}/`);
  });
}

function normalizePath(path: string): string {
  const segments: string[] = [];
  for (const segment of path.replaceAll("\\", "/").split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      segments.pop();
    } else {
      segments.push(segment);
    }
  }
  return segments.join("/").toLowerCase();
}

function isFileSystemError(error: unknown, ...codes: string[]): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && codes.includes(String(error.code));
}

function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, milliseconds);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason ?? new Error("Operation aborted"));
      },
      { once: true },
    );
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

function providerTimestamp(value: unknown): string {
  if (typeof value === "string" && !Number.isNaN(Date.parse(value))) return value;
  if (typeof value === "number" && Number.isFinite(value)) return new Date(value).toISOString();
  return new Date().toISOString();
}
