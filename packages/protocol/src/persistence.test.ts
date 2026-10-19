import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { HubStateStore } from "./persistence.ts";
import {
  isHostInstance,
  validateHostInstance,
} from "./index.ts";
import type { HostInstance, HostSession } from "./index.ts";

const instance: HostInstance = {
  id: "pc-a",
  label: "PC A",
  backend: "codeman",
  features: [],
  connectionMode: "tailscale-url",
  endpoint: "https://pc-a.tailnet.ts.net",
  status: "online",
  capabilities: ["codeman"],
  agents: [{ id: "claude", name: "Claude Code", mode: "claude", ready: true }],
  workspaces: [],
  lastSeenAt: new Date().toISOString(),
  createdAt: new Date().toISOString(),
};

const session: HostSession = {
  id: "session-1",
  instanceId: "pc-a",
  workspaceId: "workspace-1",
  agent: { id: "claude", name: "Claude Code", mode: "claude", ready: true },
  title: "Fix tests",
  status: "working",
  terminalBuffer: "running",
  needsInput: false,
  previewAvailable: false,
  browserAvailable: false,
  createdAt: new Date().toISOString(),
  lastEventAt: new Date().toISOString(),
};

test("HubStateStore reloads instances, sessions, and audit events", () => {
  const directory = mkdtempSync(join(tmpdir(), "cloudagentfleet-"));
  const path = join(directory, "hub.json");
  try {
    const first = new HubStateStore(path);
    first.upsertInstance(instance);
    first.upsertSession(session);
    first.appendAudit({
      id: "audit-1",
      type: "instance.registered",
      actor: "operator",
      resourceId: instance.id,
      createdAt: new Date().toISOString(),
      metadata: {},
    });

    const second = new HubStateStore(path);
    const snapshot = second.snapshot();
    assert.equal(snapshot.instances[0]?.id, "pc-a");
    assert.equal(snapshot.sessions[0]?.id, "session-1");
    assert.equal(snapshot.audit[0]?.type, "instance.registered");
    assert.match(readFileSync(path, "utf8"), /"pc-a"/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Codeman contracts require safe endpoints and preserve instance-scoped sessions", () => {
  assert.equal(session.instanceId, "pc-a");
  assert.equal(isHostInstance(instance), true);
  assert.throws(
    () => validateHostInstance({ ...instance, endpoint: "http://remote.example" }),
    /Invalid host instance/,
  );
});

test("HubStateStore migrates instances saved before the backend field", () => {
  const directory = mkdtempSync(join(tmpdir(), "cloudagentfleet-"));
  try {
    const path = join(directory, "hub.json");
    const { backend: _backend, features: _features, ...legacy } = instance;
    writeFileSync(path, JSON.stringify({ instances: [legacy], sessions: [], audit: [] }));
    const migrated = new HubStateStore(path).snapshot().instances[0];
    assert.equal(migrated?.backend, "codeman");
    assert.deepEqual(migrated?.features, []);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
