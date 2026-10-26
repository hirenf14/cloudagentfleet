import { mkdir, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { realpathSync, type Dirent } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import type {
  AgentJob,
  CodemanAgentMode,
  AgentProfile,
  CodemanConnectorRequest,
  HostSessionEvent,
  ControlMessage,
  NodeMessage,
  WorkspaceDescriptor,
  WorkspacePolicy,
  WorkspacePathSuggestion,
} from "../../../packages/protocol/src/index.ts";
import {
  codemanAgentName,
  isCodemanAgentMode,
  isPathAllowed,
  isRecord,
} from "../../../packages/protocol/src/index.ts";
import {
  type CodemanEnvelope,
  codemanEventKind,
  codemanEventSessionId,
  codemanTimestamp,
  dedupeAgents,
  normalizeCodemanAgent,
  type CodemanStatus,
} from "../../../packages/host-adapters/src/codeman/wire.ts";
import { readSseStream } from "../../../packages/host-adapters/src/shared/sse.ts";

interface CodemanApiSession {
  id: string;
}

interface CreateSessionData {
  session: CodemanApiSession;
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
  /** Codeman sends an ISO date string; only compared for equality. */
  timestamp: number | string;
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
  mode: CodemanAgentMode;
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
 * invocation. Cloud Agent Fleet only creates a session, submits a prompt, waits for
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

  async createSession(options: CodemanCreateSessionOptions): Promise<CodemanApiSession> {
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
        const terminal = await this.terminal(sessionId, 20000);
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

  async terminal(
    sessionId: string,
    tail: number,
    signal?: AbortSignal,
  ): Promise<{ terminalBuffer?: string; status?: string }> {
    return this.requestData<{ terminalBuffer?: string; status?: string }>(
      `/api/v1/sessions/${encodeURIComponent(sessionId)}/terminal?tail=${tail}`,
      { signal },
    );
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
        clientId: "cloudagentfleet-connector",
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
    await readSseStream(response.body, signal, (frame) => {
      try {
        const parsed = JSON.parse(frame.data) as Record<string, unknown>;
        const sessionId = codemanEventSessionId(parsed);
        if (!sessionId) return;
        onEvent({
          sessionId,
          type: String(parsed.type ?? parsed.event ?? frame.event ?? "").toLowerCase(),
          data: parsed.data ?? parsed.output ?? parsed.text,
          createdAt: codemanTimestamp(parsed.createdAt ?? parsed.created_at),
        });
      } catch {
        // Ignore malformed provider events.
      }
    });
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
  mode?: CodemanAgentMode;
  agentProfiles?: AgentProfile[];
  cursorCommand?: string;
  claudeCommand?: string;
  /** How long a new session's terminal must stay unchanged before the first prompt is typed. */
  settleMs?: number;
  /** Where long prompts are written for the agent to read (default ~/.cloudagentfleet/prompts). */
  promptDir?: string;
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
  private readonly mode: CodemanAgentMode;
  private readonly agentProfiles: AgentProfile[];
  private readonly cursorCommand?: string;
  private readonly claudeCommand?: string;
  private readonly settleMs: number;
  private readonly promptDir: string;
  private readonly activeJobs = new Map<string, ActiveJob>();

  constructor(options: CodemanWorkerRuntimeOptions) {
    this.client = options.client;
    this.nodeId = options.nodeId;
    this.instanceId = options.instanceId ?? options.nodeId;
    this.workspaces = options.workspaces;
    // Candidates are compared by real path, so the roots must be real paths too: a root given through a
    // symlink (macOS /var and /tmp, a linked projects folder) otherwise never matches anything.
    this.workspacePolicy = options.workspacePolicy.mode === "folders"
      ? { ...options.workspacePolicy, roots: options.workspacePolicy.roots.map(realRoot) }
      : options.workspacePolicy;
    this.send = options.send;
    this.mode = options.mode ?? "claude";
    this.agentProfiles = options.agentProfiles?.map((agent) => ({ ...agent })) ?? [];
    this.cursorCommand = options.cursorCommand;
    this.claudeCommand = options.claudeCommand;
    this.settleMs = options.settleMs ?? 1500;
    this.promptDir = options.promptDir ?? join(homedir(), ".cloudagentfleet", "prompts");
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
        return mergeLaunchAgents({
          mode: this.mode,
          statusAgents: [...(status.agents ?? []), ...(status.capabilities ?? [])],
          localProfiles: this.agentProfiles,
        });
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
    // A follow-up continues an earlier job's session (same conversation);
    // otherwise the job gets a fresh session.
    const followUp = job.sessionId ? await this.requireJobSession(job.sessionId) : undefined;
    const mode: string = followUp?.mode ?? job.agent ?? this.mode;
    const session = followUp ?? await this.client.createSession({
      workingDir: workspace.canonicalPath,
      mode: job.agent ?? this.mode,
      name: `${this.jobSessionPrefix()}${job.id}`,
    });
    this.activeJobs.set(job.id, { sessionId: session.id, abortController });
    let promptFile: string | undefined;

    try {
      await this.send({
        type: "job.accept",
        jobId: job.id,
        idempotencyKey: job.idempotencyKey,
      });
      await this.send({ type: "job.event", jobId: job.id, event: "started", sessionId: session.id });
      if (!followUp) {
        await this.client.startInteractive(session.id);
        await this.waitForSettled(session.id, abortController.signal);
      }
      // Whatever the session reports as its last response before the prompt is not this job's: the
      // previous job's on a follow-up, or (for a new Codex session with no rollout yet) another
      // session's from the same folder. Only a newer one counts.
      const previous = await this.client.lastResponse(session.id, abortController.signal).catch(() => undefined);
      promptFile = await this.promptFileFor(job);
      const typed = promptFile
        ? `Read the file ${promptFile} and do what it asks; it holds this whole request.`
        : job.prompt;
      if (mode !== "claude") {
        // Only Claude Code has the hooks behind Codeman's stop/working signals; other agents
        // (Codex, OpenCode, ...) stay "idle" throughout, so watch the reply and the screen instead.
        await this.client.sendInput(session.id, typed);
        const response = await this.waitForReply(session.id, abortController.signal, previous);
        await this.send({ type: "job.event", jobId: job.id, event: "completed", data: response.text });
        return;
      }
      const input = await this.client.sendPrompt(
        session.id,
        typed,
        `cloudagentfleet-${this.nodeId}-${job.id}`,
        1,
        abortController.signal,
      );
      if (input.wait?.timedOut || !input.wait) {
        await this.client.waitForCompletion(session.id, abortController.signal);
      }
      let response = await this.readResponse(session.id, abortController.signal, previous);
      // An agent that is still starting can take the typed text but drop the Enter. If nothing came
      // back and the prompt is still in the input box, press Enter again (twice at most).
      for (let attempt = 0; attempt < 2 && !response.text.trim(); attempt += 1) {
        if (!await this.promptStillTyped(session.id, typed, abortController.signal)) break;
        const retry = await this.client.sendPrompt(
          session.id,
          "",
          `cloudagentfleet-${this.nodeId}-${job.id}`,
          attempt + 2,
          abortController.signal,
        );
        // Only keep waiting if the Enter got the agent working; an idle session never sends "stop".
        if (retry.wait?.timedOut && (await this.client.terminal(session.id, 1, abortController.signal)).status === "busy") {
          await this.client.waitForCompletion(session.id, abortController.signal);
        }
        response = await this.readResponse(session.id, abortController.signal, previous);
      }
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
      if (promptFile) await rm(promptFile, { force: true });
    }
  }

  /**
   * Writes a long or multi-line prompt to a file and returns its path, or returns undefined when the
   * prompt is short enough to type. Typing a long prompt into an agent's TUI loses text (Claude Code
   * folds a big burst into a paste placeholder and drops its start) and flattens newlines; a file
   * keeps the whole request, and any agent can read it.
   */
  private async promptFileFor(job: AgentJob): Promise<string | undefined> {
    if (job.prompt.length <= 400 && !job.prompt.includes("\n")) return undefined;
    await mkdir(this.promptDir, { recursive: true });
    const file = join(this.promptDir, `${job.id.replaceAll(/[^\w-]/g, "_")}.md`);
    await writeFile(file, job.prompt, { mode: 0o600 });
    return file;
  }

  private jobSessionPrefix(): string {
    return `hosted-${this.nodeId}-`;
  }

  /**
   * Finds a session this Worker created for an earlier job. Sessions people
   * started from the dashboard are refused, so a job can't type into them.
   */
  private async requireJobSession(sessionId: string): Promise<{ id: string; mode?: string }> {
    const sessions = await this.client.listSessions();
    const session = sessions.find((candidate) => candidate.id === sessionId);
    if (!session) throw new Error(`Session not found on this Worker: ${sessionId}`);
    const name = typeof session.name === "string" ? session.name : "";
    if (!name.startsWith(this.jobSessionPrefix())) {
      throw new Error(`Session ${sessionId} was not started by a job; follow-ups only continue job sessions`);
    }
    return { id: sessionId, ...(typeof session.mode === "string" ? { mode: session.mode } : {}) };
  }

  private async cancel(jobId: string): Promise<void> {
    const active = this.activeJobs.get(jobId);
    if (!active) return;
    active.abortController.abort();
    await this.client.deleteSession(active.sessionId);
  }

  /**
   * Waits until a freshly started session's terminal stops changing (the agent's TUI has drawn its
   * input box), so the first prompt isn't typed into a half-started agent. Gives up after 30s and
   * lets the Enter retry in assign() cover what's left.
   */
  private async waitForSettled(sessionId: string, signal: AbortSignal): Promise<void> {
    const step = Math.max(50, Math.min(500, this.settleMs / 3));
    let last = "";
    let quietFor = 0;
    for (let waited = 0; waited < 30_000; waited += step) {
      const buffer = (await this.client.terminal(sessionId, 4000, signal).catch(() => ({ terminalBuffer: "" }))).terminalBuffer ?? "";
      quietFor = buffer && buffer === last ? quietFor + step : 0;
      if (quietFor >= this.settleMs) return;
      last = buffer;
      await delay(step, signal);
    }
  }

  /**
   * Waits for a hookless agent's turn to end: a newer last response than `previous`, with the
   * screen unchanged for two settle periods (a working agent keeps redrawing its spinner/timer).
   * A screen that stays still with no reply means the Enter was dropped, so Enter is pressed
   * again (three times at most); after that, a still screen with no reply ends the job empty.
   */
  private async waitForReply(
    sessionId: string,
    signal: AbortSignal,
    previous?: LastResponseData,
  ): Promise<LastResponseData> {
    const step = Math.max(50, Math.min(1000, this.settleMs / 3));
    let last = "";
    let stillFor = 0;
    let enters = 0;
    while (true) {
      await delay(step, signal);
      const { terminalBuffer = "" } = await this.client.terminal(sessionId, 4000, signal);
      stillFor = terminalBuffer === last ? stillFor + step : 0;
      last = terminalBuffer;
      const response = await this.client.lastResponse(sessionId, signal);
      const fresh = response.text.trim() !== "" && response.timestamp !== previous?.timestamp;
      if (fresh && stillFor >= this.settleMs * 2) return response;
      if (!fresh && stillFor >= this.settleMs * 5) {
        if (enters >= 3) return { ...response, text: "" };
        await this.client.sendInput(sessionId, "\r");
        enters += 1;
        stillFor = 0;
      }
    }
  }

  /** Whether the start of the prompt is still on screen with no reply, i.e. it was typed but never sent. */
  private async promptStillTyped(sessionId: string, prompt: string, signal: AbortSignal): Promise<boolean> {
    const flat = (text: string) => text.replaceAll(/\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07/g, "").replaceAll(/\s+/g, " ");
    const head = flat(prompt).trim().slice(0, 40);
    const { terminalBuffer = "" } = await this.client.terminal(sessionId, 4000, signal);
    return head.length > 0 && flat(terminalBuffer).includes(head);
  }

  /**
   * Reads the session's last response, polling briefly until there is one, then until it stops
   * changing. With `previous`, a response carrying the same timestamp is still the earlier job's,
   * so it counts as none yet.
   */
  private async readResponse(
    sessionId: string,
    signal: AbortSignal,
    previous?: LastResponseData,
  ): Promise<LastResponseData> {
    const fresh = (response: LastResponseData) =>
      response.text.trim() !== "" && response.timestamp !== previous?.timestamp;
    let response = await this.client.lastResponse(sessionId, signal);
    for (let attempt = 0; attempt < 20 && !fresh(response); attempt += 1) {
      await delay(250, signal);
      response = await this.client.lastResponse(sessionId, signal);
    }
    if (!fresh(response)) return { ...response, text: "" };
    // The stop signal can beat Claude's transcript write, so the first fresh read may be an interim
    // message ("Checking X, then I'll write the plan") with the final answer a moment behind. Keep
    // reading until the response has held still for a settle period (10s at most).
    const step = Math.max(50, Math.min(500, this.settleMs / 3));
    let stableFor = 0;
    for (let waited = 0; stableFor < this.settleMs && waited < 10_000; waited += step) {
      await delay(step, signal);
      const next = await this.client.lastResponse(sessionId, signal);
      const changed = next.text !== response.text || next.timestamp !== response.timestamp;
      stableFor = changed ? 0 : stableFor + step;
      if (changed && next.text.trim() !== "") response = next;
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
    // Check the folder's real path, like the roots: a typed /var/... is /private/var/... on macOS.
    const directory = await realpath(resolve(basePath)).catch(() => resolve(basePath));
    if (!isPathAllowed(directory, this.workspacePolicy)) return [];

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
      if (!isPathAllowed(canonicalCandidate, this.workspacePolicy)) continue;
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
    if (!isPathAllowed(workspacePath, this.workspacePolicy)) {
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
    if (!isPathAllowed(workspace.canonicalPath, this.workspacePolicy)) {
      throw new Error(`Workspace is outside the worker policy: ${workspace.id}`);
    }
    return workspace;
  }

  private toSessionEvent(event: CodemanProviderEvent): HostSessionEvent | undefined {
    const mapped = codemanEventKind(event.type);
    if (!mapped) return undefined;
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

function isAgentProfile(
  value: unknown,
): value is { id: string; mode: CodemanAgentMode; name: string } {
  return isRecord(value)
    && typeof value.id === "string"
    && typeof value.name === "string"
    && isCodemanAgentMode(value.mode);
}

/** Stable launch list: raw Shell CLI first, configured Codeman mode, then status/local profiles. */
export function mergeLaunchAgents(input: {
  mode: CodemanAgentMode;
  statusAgents?: unknown[];
  localProfiles?: AgentProfile[];
}): AgentProfile[] {
  const ordered: AgentProfile[] = [
    {
      id: "shell",
      name: "Shell (raw CLI)",
      mode: "shell",
      ready: true,
    },
  ];
  if (input.mode !== "shell") {
    ordered.push({
      id: input.mode,
      name: codemanAgentName(input.mode, input.mode),
      mode: input.mode,
      ready: true,
    });
  }
  for (const raw of input.statusAgents ?? []) {
    const agent = normalizeCodemanAgent(raw);
    if (agent) ordered.push(agent);
  }
  for (const profile of input.localProfiles ?? []) {
    ordered.push(profile);
  }
  return dedupeAgents(ordered);
}

function isFileSystemError(error: unknown, ...codes: string[]): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && codes.includes(String(error.code));
}

/** A policy root's real path, or the root as given when it doesn't exist (yet). */
function realRoot(root: string): string {
  try {
    return realpathSync(root);
  } catch {
    return root;
  }
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
