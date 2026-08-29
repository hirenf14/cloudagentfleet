import type {
  AgentJob,
  ControlMessage,
  NodeMessage,
  WorkspaceDescriptor,
  WorkspacePolicy,
} from "../../../packages/protocol/src/index.ts";

type CodemanMode =
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
  workspaces: WorkspaceDescriptor[];
  workspacePolicy: WorkspacePolicy;
  send: (message: NodeMessage) => Promise<void>;
  mode?: CodemanMode;
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
  private readonly workspaces: WorkspaceDescriptor[];
  private readonly workspacePolicy: WorkspacePolicy;
  private readonly send: (message: NodeMessage) => Promise<void>;
  private readonly mode: CodemanMode;
  private readonly activeJobs = new Map<string, ActiveJob>();

  constructor(options: CodemanWorkerRuntimeOptions) {
    this.client = options.client;
    this.nodeId = options.nodeId;
    this.workspaces = options.workspaces;
    this.workspacePolicy = options.workspacePolicy;
    this.send = options.send;
    this.mode = options.mode ?? "claude";
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
    if (workspace.health !== "ready") {
      throw new Error(`Workspace is not ready: ${workspaceId}`);
    }
    if (workspace.providers.codeman !== "ready") {
      throw new Error("Codeman is not ready for the selected workspace");
    }
    if (!isAllowedPath(workspace.canonicalPath, this.workspacePolicy)) {
      throw new Error(`Workspace is outside the worker policy: ${workspaceId}`);
    }
    return workspace;
  }
}

function isAllowedPath(path: string, policy: WorkspacePolicy): boolean {
  if (policy.mode === "system") return true;
  const normalizedPath = normalizePath(path);
  return policy.roots.some((root) => {
    const normalizedRoot = normalizePath(root);
    return normalizedPath === normalizedRoot || normalizedPath.startsWith(`${normalizedRoot}/`);
  });
}

function normalizePath(path: string): string {
  return path.replaceAll("\\", "/").replace(/\/+$/, "").toLowerCase();
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
