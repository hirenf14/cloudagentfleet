import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { HubStateStore } from "./persistence.ts";
import {
  isCodemanInstance,
  namespaceSession,
  validateCodemanInstance,
} from "./index.ts";
import type { CodemanInstance, CodemanSession } from "./index.ts";

const instance: CodemanInstance = {
  id: "pc-a",
  label: "PC A",
  connectionMode: "tailscale-url",
  endpoint: "https://pc-a.tailnet.ts.net",
  status: "online",
  capabilities: ["codeman"],
  agents: [{ id: "claude", name: "Claude Code", mode: "claude", ready: true }],
  workspaces: [],
  lastSeenAt: new Date().toISOString(),
  createdAt: new Date().toISOString(),
};

const session: CodemanSession = {
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
  const directory = mkdtempSync(join(tmpdir(), "hosted-agents-"));
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
  assert.equal(namespaceSession("pc-a", "session-1").instanceId, "pc-a");
  assert.equal(isCodemanInstance(instance), true);
  assert.throws(
    () => validateCodemanInstance({ ...instance, endpoint: "http://remote.example" }),
    /Invalid Codeman instance/,
  );
});
