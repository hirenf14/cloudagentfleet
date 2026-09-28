import assert from "node:assert/strict";
import test from "node:test";
import type {
  CodemanAgentProfile,
  CodemanInstance,
  CodemanInstanceRegistration,
  CodemanSession,
  CodemanSessionEvent,
  CodemanStatus,
  WorkspaceDescriptor,
} from "../../../packages/protocol/src/index.ts";
import { CodemanHub } from "./hub.ts";

const workspace: WorkspaceDescriptor = {
  id: "workspace-a",
  name: "A",
  canonicalPath: "/workspaces/a",
  health: "ready",
  providers: { codeman: "ready" },
};

const agent: CodemanAgentProfile = {
  id: "claude",
  name: "Claude Code",
  mode: "claude",
  ready: true,
};

class FakeAdapter {
  readonly instance: CodemanInstance;
  readonly events = new Set<(event: CodemanSessionEvent) => void>();
  sessions: CodemanSession[] = [];

  constructor(instance: CodemanInstance) {
    this.instance = instance;
  }

  async getStatus(): Promise<CodemanStatus> {
    return { version: "test", agents: [agent] };
  }

  async listCapabilities(): Promise<CodemanAgentProfile[]> {
    return [agent];
  }

  async listWorkspaces(): Promise<WorkspaceDescriptor[]> {
    return [workspace];
  }

  async listWorkspacePathSuggestions(): Promise<{ path: string; name: string }[]> {
    return [];
  }

  async listSessions(): Promise<CodemanSession[]> {
    return this.sessions;
  }

  async createSession(
    selectedWorkspace: WorkspaceDescriptor,
    selectedAgent: CodemanAgentProfile,
    title = "session",
  ): Promise<CodemanSession> {
    const now = new Date().toISOString();
    const session: CodemanSession = {
      id: `${this.instance.id}-session`,
      instanceId: this.instance.id,
      workspaceId: selectedWorkspace.id,
      agent: selectedAgent,
      title,
      status: "starting",
      terminalBuffer: "",
      needsInput: false,
      previewAvailable: false,
      browserAvailable: false,
      createdAt: now,
      lastEventAt: now,
    };
    this.sessions = [session];
    return session;
  }

  async sendInput(): Promise<void> {}

  async resize(): Promise<void> {}

  async stopSession(sessionId: string): Promise<void> {
    this.emit({
      instanceId: this.instance.id,
      sessionId,
      event: "stopped",
      createdAt: new Date().toISOString(),
    });
  }

  subscribeEvents(listener: (event: CodemanSessionEvent) => void): () => void {
    this.events.add(listener);
    return () => this.events.delete(listener);
  }

  emit(event: CodemanSessionEvent): void {
    for (const listener of this.events) listener(event);
  }
}

function registration(id: string): CodemanInstanceRegistration {
  return {
    id,
    label: id,
    connectionMode: "tailscale-url",
    endpoint: `https://${id}.tailnet.ts.net`,
    agents: [agent],
    workspaces: [workspace],
  };
}

test("CodemanHub isolates many instances and applies adapter events durably", async () => {
  const adapters = new Map<string, FakeAdapter>();
  const hub = new CodemanHub({
    adapterFactory: (instance) => {
      const adapter = new FakeAdapter(instance);
      adapters.set(instance.id, adapter);
      return adapter;
    },
  });

  hub.registerInstance(registration("codeman-a"));
  hub.registerInstance({ ...registration("codeman-b"), workspaces: [] });
  assert.deepEqual(hub.listInstances().map((instance) => instance.id), ["codeman-a", "codeman-b"]);

  const session = await hub.createSession("codeman-a", workspace.id, agent.id);
  assert.equal(hub.getSession("codeman-a", session.id).instanceId, "codeman-a");
  await assert.rejects(
    () => hub.sendInput("codeman-b", session.id, "must not cross instances"),
    /Unknown session: codeman-b/,
  );

  const received: CodemanSessionEvent[] = [];
  const unsubscribe = hub.subscribeEvents((event) => received.push(event));
  adapters.get("codeman-a")!.emit({
    instanceId: "codeman-a",
    sessionId: session.id,
    event: "output",
    data: "hello",
    createdAt: new Date().toISOString(),
  });
  unsubscribe();

  assert.equal(received[0]?.instanceId, "codeman-a");
  assert.equal(hub.getSession("codeman-a", session.id).terminalBuffer, "hello");
  await hub.stopSession("codeman-a", session.id);
  hub.removeSession("codeman-a", session.id);
  assert.throws(
    () => hub.getSession("codeman-a", session.id),
    /Unknown session: codeman-a/,
  );
  await hub.checkInstance("codeman-a");
  assert.equal(hub.getInstance("codeman-a").status, "online");
});

test("CodemanHub accepts an explicit path only inside the instance policy", async () => {
  const hub = new CodemanHub({
    adapterFactory: (instance) => new FakeAdapter(instance),
  });
  hub.registerInstance({
    ...registration("codeman-path"),
    workspacePolicy: { mode: "folders", roots: ["/workspaces"] },
  });

  const session = await hub.createSession(
    "codeman-path",
    undefined,
    agent.id,
    undefined,
    "/workspaces/new-project",
  );
  assert.equal(session.workspaceId, "/workspaces/new-project");
  await assert.rejects(
    () => hub.createSession(
      "codeman-path",
      undefined,
      agent.id,
      undefined,
      "/outside/project",
    ),
    /outside the instance policy/,
  );
  await assert.rejects(
    () => hub.createSession(
      "codeman-path",
      undefined,
      agent.id,
      undefined,
      "/workspaces/../outside",
    ),
    /outside the instance policy/,
  );
});
