import assert from "node:assert/strict";
import test from "node:test";
import type {
  AgentProfile,
  HostInstance,
  HostInstanceRegistration,
  HostSession,
  HostSessionEvent,
  CodemanStatus,
  WorkspaceDescriptor,
} from "../../../packages/protocol/src/index.ts";
import { FleetHub } from "./hub.ts";

const workspace: WorkspaceDescriptor = {
  id: "workspace-a",
  name: "A",
  canonicalPath: "/workspaces/a",
  health: "ready",
  providers: { codeman: "ready" },
};

const agent: AgentProfile = {
  id: "claude",
  name: "Claude Code",
  mode: "claude",
  ready: true,
};

class FakeAdapter {
  readonly instance: HostInstance;
  readonly events = new Set<(event: HostSessionEvent) => void>();
  sessions: HostSession[] = [];

  constructor(instance: HostInstance) {
    this.instance = instance;
  }

  async getStatus(): Promise<CodemanStatus> {
    return { version: "test", agents: [agent] };
  }

  async listCapabilities(): Promise<AgentProfile[]> {
    return [agent];
  }

  async listWorkspaces(): Promise<WorkspaceDescriptor[]> {
    return [workspace];
  }

  async listWorkspacePathSuggestions(): Promise<{ path: string; name: string }[]> {
    return [];
  }

  async listSessions(): Promise<HostSession[]> {
    return this.sessions;
  }

  async createSession(
    selectedWorkspace: WorkspaceDescriptor,
    selectedAgent: AgentProfile,
    title = "session",
  ): Promise<HostSession> {
    const now = new Date().toISOString();
    const session: HostSession = {
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

  subscribeEvents(listener: (event: HostSessionEvent) => void): () => void {
    this.events.add(listener);
    return () => this.events.delete(listener);
  }

  emit(event: HostSessionEvent): void {
    for (const listener of this.events) listener(event);
  }
}

function registration(id: string): HostInstanceRegistration {
  return {
    id,
    label: id,
    connectionMode: "tailscale-url",
    endpoint: `https://${id}.tailnet.ts.net`,
    agents: [agent],
    workspaces: [workspace],
  };
}

test("FleetHub isolates many instances and applies adapter events durably", async () => {
  const adapters = new Map<string, FakeAdapter>();
  const hub = new FleetHub({
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

  const received: HostSessionEvent[] = [];
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

test("FleetHub accepts an explicit path only inside the instance policy", async () => {
  const hub = new FleetHub({
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
