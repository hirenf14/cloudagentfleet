import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CLAUDE_CODE_MODELS, readClaudeModelPolicy, syncCptrClaudeModels } from "./cptr-models.ts";

type Profile = Record<string, unknown>;

/** A stand-in for cptr's sign-in and admin agent routes. */
function fakeCptr(state: { stored: Profile[] | null; effective: Profile[]; puts: Profile[][] }): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    if (path === "/api/auth/login") {
      return new Response("{}", { headers: { "set-cookie": "cptr_session=abc.def.ghi; Path=/; HttpOnly" } });
    }
    assert.match(String((init?.headers as Record<string, string>).cookie), /cptr_session=abc\.def\.ghi/);
    if (path === "/api/admin/config/agents") return Response.json({ config: state.stored ? { "agents.profiles": state.stored } : {} });
    if (path === "/api/admin/agents" && init?.method === "PUT") {
      state.puts.push((JSON.parse(String(init.body)) as { profiles: Profile[] }).profiles);
      return Response.json({});
    }
    if (path === "/api/admin/agents") return Response.json({ profiles: state.effective.map((config) => ({ config })) });
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
}

function setup() {
  const directory = mkdtempSync(join(tmpdir(), "cloudagentfleet-cptr-models-"));
  const credentialsPath = join(directory, "cptr-credentials.json");
  writeFileSync(credentialsPath, JSON.stringify({ username: "fleet", password: "pw" }));
  return { directory, credentialsPath, modelsPath: join(directory, "cptr-models.json") };
}

const claude = (extra: Profile = {}): Profile => ({ id: "claude-code", agent: "claude_code", command: "claude", models: [], default_model: "", ...extra });
const codex: Profile = { id: "codex", agent: "codex", command: "codex", models: [], default_model: "" };

test("a cptr with no saved profiles gets its built-ins written out with the current Claude models", async () => {
  const { directory, credentialsPath, modelsPath } = setup();
  try {
    // cptr's status merges what it detected into `models`; those must not be saved as if configured.
    const state = {
      stored: null,
      effective: [claude({ models: ["claude-opus-4-8"], default_model: "claude-opus-4-8" }), { ...codex, models: ["gpt-x"], default_model: "gpt-x" }],
      puts: [] as Profile[][],
    };
    const result = await syncCptrClaudeModels({ baseUrl: "http://127.0.0.1:8000", credentialsPath, modelsPath, fetchImpl: fakeCptr(state) });
    assert.equal(result, "updated");
    assert.equal(state.puts.length, 1);
    const [saved] = state.puts;
    assert.deepEqual(saved![0]!.models, CLAUDE_CODE_MODELS.models);
    assert.equal(saved![0]!.default_model, CLAUDE_CODE_MODELS.default);
    assert.deepEqual(saved![1], codex);
    // Agents that are not installed yet stay in the list, so installing one later still shows it.
    assert.deepEqual(saved!.map((profile) => profile.id), ["claude-code", "codex", "cursor", "grok", "opencode", "cline", "gemini", "pi"]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a machine without Claude Code is left untouched", async () => {
  const { directory, credentialsPath, modelsPath } = setup();
  try {
    const state = { stored: null, effective: [codex], puts: [] as Profile[][] };
    const result = await syncCptrClaudeModels({ baseUrl: "http://127.0.0.1:8000", credentialsPath, modelsPath, fetchImpl: fakeCptr(state) });
    assert.equal(result, "no-claude-profile");
    assert.equal(state.puts.length, 0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("saved profiles keep the operator's models and default; only missing models are added", async () => {
  const { directory, credentialsPath, modelsPath } = setup();
  try {
    const state = {
      stored: [claude({ models: ["my-own-model"], default_model: "my-own-model" }), codex],
      effective: [],
      puts: [] as Profile[][],
    };
    const result = await syncCptrClaudeModels({ baseUrl: "http://127.0.0.1:8000", credentialsPath, modelsPath, fetchImpl: fakeCptr(state) });
    assert.equal(result, "updated");
    assert.deepEqual(state.puts[0]![0]!.models, [...CLAUDE_CODE_MODELS.models, "my-own-model"]);
    assert.equal(state.puts[0]![0]!.default_model, "my-own-model");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a profile that already offers the current models is left alone", async () => {
  const { directory, credentialsPath, modelsPath } = setup();
  try {
    const state = {
      stored: [claude({ models: CLAUDE_CODE_MODELS.models, default_model: CLAUDE_CODE_MODELS.default }), codex],
      effective: [],
      puts: [] as Profile[][],
    };
    const result = await syncCptrClaudeModels({ baseUrl: "http://127.0.0.1:8000", credentialsPath, modelsPath, fetchImpl: fakeCptr(state) });
    assert.equal(result, "current");
    assert.equal(state.puts.length, 0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("without a Claude Code profile nothing is written", async () => {
  const { directory, credentialsPath, modelsPath } = setup();
  try {
    const state = { stored: [codex], effective: [], puts: [] as Profile[][] };
    const result = await syncCptrClaudeModels({ baseUrl: "http://127.0.0.1:8000", credentialsPath, modelsPath, fetchImpl: fakeCptr(state) });
    assert.equal(result, "no-claude-profile");
    assert.equal(state.puts.length, 0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("cptr-models.json replaces the built-in list, and a bad file falls back to it", () => {
  const { directory, modelsPath } = setup();
  try {
    assert.deepEqual(readClaudeModelPolicy(modelsPath), CLAUDE_CODE_MODELS);
    writeFileSync(modelsPath, JSON.stringify({ models: ["claude-next-1", " ", "claude-next-2"], default: "claude-next-2" }));
    assert.deepEqual(readClaudeModelPolicy(modelsPath), { models: ["claude-next-1", "claude-next-2"], default: "claude-next-2" });
    writeFileSync(modelsPath, JSON.stringify({ models: ["claude-next-1"], default: "not-in-list" }));
    assert.equal(readClaudeModelPolicy(modelsPath).default, "claude-next-1");
    writeFileSync(modelsPath, "not json");
    assert.deepEqual(readClaudeModelPolicy(modelsPath), CLAUDE_CODE_MODELS);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
