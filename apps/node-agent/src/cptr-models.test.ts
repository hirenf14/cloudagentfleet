import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BUILT_IN_MODEL_CONFIG, CLAUDE_CODE_MODELS, cptrModelKeeper, readModelConfig, syncCptrModels } from "./cptr-models.ts";

type Json = Record<string, unknown>;
interface FakeState {
  stored: Json[] | null;
  effective: Json[];
  connections: Json[];
  puts: Json[][];
  /** Connection writes as "<METHOD> <path>" with their JSON body. */
  writes: Array<{ call: string; body: Json }>;
  logins: number;
  refreshes: number;
}

/** A stand-in for cptr's sign-in and admin agent and connection routes. */
function fakeCptr(state: Partial<FakeState> & Pick<FakeState, "stored" | "effective">): { fetchImpl: typeof fetch; state: FakeState } {
  const full: FakeState = { connections: [], puts: [], writes: [], logins: 0, refreshes: 0, ...state };
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    if (path === "/api/auth/login") {
      full.logins += 1;
      return new Response("{}", { headers: { "set-cookie": "cptr_session=abc.def.ghi; Path=/; HttpOnly" } });
    }
    if (path === "/api/admin/agents/refresh") {
      full.refreshes += 1;
      return Response.json({});
    }
    assert.match(String((init?.headers as Record<string, string>).cookie), /cptr_session=abc\.def\.ghi/);
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) as Json : {};
    if (path === "/api/admin/config/agents") return Response.json({ config: full.stored ? { "agents.profiles": full.stored } : {} });
    if (path === "/api/admin/agents" && method === "PUT") {
      full.puts.push(body.profiles as Json[]);
      return Response.json({});
    }
    if (path === "/api/admin/agents") return Response.json({ profiles: full.effective.map((config) => ({ config })) });
    if (path === "/api/admin/connections" && method === "GET") return Response.json({ connections: full.connections });
    if (path.startsWith("/api/admin/connections") && (method === "POST" || method === "PUT")) {
      full.writes.push({ call: `${method} ${path}`, body });
      return Response.json({ ok: true, id: "new-id" });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  return { fetchImpl, state: full };
}

function setup(config?: unknown) {
  const directory = mkdtempSync(join(tmpdir(), "cloudagentfleet-cptr-models-"));
  const credentialsPath = join(directory, "cptr-credentials.json");
  writeFileSync(credentialsPath, JSON.stringify({ username: "fleet", password: "pw" }));
  const modelsPath = join(directory, "cptr-models.json");
  if (config !== undefined) writeFileSync(modelsPath, typeof config === "string" ? config : JSON.stringify(config));
  const sync = (fake: ReturnType<typeof fakeCptr>) => syncCptrModels({ baseUrl: "http://127.0.0.1:8000", credentialsPath, modelsPath, fetchImpl: fake.fetchImpl });
  return { directory, sync };
}

const claude = (extra: Json = {}): Json => ({ id: "claude-code", agent: "claude_code", command: "claude", models: [], default_model: "", ...extra });
const codex: Json = { id: "codex", agent: "codex", command: "codex", models: [], default_model: "" };

test("a cptr with no saved profiles gets its built-ins written out with the current Claude models", async () => {
  const { directory, sync } = setup();
  try {
    // cptr's status merges what it detected into `models`; those must not be saved as if configured.
    const fake = fakeCptr({
      stored: null,
      effective: [claude({ models: ["claude-opus-4-8"], default_model: "claude-opus-4-8" }), { ...codex, models: ["gpt-x"], default_model: "gpt-x" }],
    });
    const result = await sync(fake);
    assert.equal(result.profiles, "updated");
    assert.equal(fake.state.puts.length, 1);
    const [saved] = fake.state.puts;
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
  const { directory, sync } = setup();
  try {
    const fake = fakeCptr({ stored: null, effective: [codex] });
    assert.equal((await sync(fake)).profiles, "nothing-to-do");
    assert.equal(fake.state.puts.length, 0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("saved profiles keep the operator's models and default; only missing models are added", async () => {
  const { directory, sync } = setup();
  try {
    const fake = fakeCptr({ stored: [claude({ models: ["my-own-model"], default_model: "my-own-model" }), codex], effective: [] });
    assert.equal((await sync(fake)).profiles, "updated");
    assert.deepEqual(fake.state.puts[0]![0]!.models, [...CLAUDE_CODE_MODELS.models, "my-own-model"]);
    assert.equal(fake.state.puts[0]![0]!.default_model, "my-own-model");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a profile that already offers the current models is left alone", async () => {
  const { directory, sync } = setup();
  try {
    const fake = fakeCptr({
      stored: [claude({ models: CLAUDE_CODE_MODELS.models, default_model: CLAUDE_CODE_MODELS.default }), codex],
      effective: [],
    });
    assert.equal((await sync(fake)).profiles, "current");
    assert.equal(fake.state.puts.length, 0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("model ids for another agent are added to its profile, and its default is set only if it has none", async () => {
  const { directory, sync } = setup({ codex: { models: ["my-codex", "other-codex"], default: "other-codex" } });
  try {
    const fake = fakeCptr({
      stored: [claude({ models: CLAUDE_CODE_MODELS.models, default_model: CLAUDE_CODE_MODELS.default }), { ...codex, models: ["kept"], default_model: "kept" }],
      effective: [],
    });
    assert.equal((await sync(fake)).profiles, "updated");
    const saved = fake.state.puts[0]!;
    assert.deepEqual(saved[1]!.models, ["my-codex", "other-codex", "kept"]);
    assert.equal(saved[1]!.default_model, "kept");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a local model server is created as a connection, and a later run finds it current", async () => {
  const ollama = { name: "Ollama", base_url: "http://127.0.0.1:11434/v1/", prefix_id: "ollama", models: ["llama3.1", "qwen3"] };
  const { directory, sync } = setup({ connections: [ollama, { name: "bad entry" }, { name: "no scheme", base_url: "localhost:1234" }] });
  try {
    const stored = [claude({ models: CLAUDE_CODE_MODELS.models, default_model: CLAUDE_CODE_MODELS.default })];
    const first = fakeCptr({ stored, effective: [] });
    assert.equal((await sync(first)).connections, 1);
    assert.equal(first.state.writes.length, 1);
    assert.equal(first.state.writes[0]!.call, "POST /api/admin/connections");
    assert.deepEqual(first.state.writes[0]!.body, {
      name: "Ollama", provider: "openai", base_url: "http://127.0.0.1:11434/v1", prefix_id: "ollama", enabled: true, models: ["llama3.1", "qwen3"],
      // cptr cannot call a server with an empty key, so a keyless local server gets a placeholder.
      api_key: "local",
    });

    const second = fakeCptr({
      stored,
      effective: [],
      connections: [{ id: "c1", name: "Ollama", provider: "openai", base_url: "http://127.0.0.1:11434/v1", prefix_id: "ollama", enabled: true, data: { models: ["llama3.1", "qwen3"] } }],
    });
    assert.equal((await sync(second)).connections, 0);
    assert.equal(second.state.writes.length, 0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a changed connection is updated, and dropping its model list goes back to discovery", async () => {
  const { directory, sync } = setup({ connections: [{ name: "LM Studio", base_url: "http://127.0.0.1:1234/v1", api_key: "secret" }] });
  try {
    const fake = fakeCptr({
      stored: [claude({ models: CLAUDE_CODE_MODELS.models, default_model: CLAUDE_CODE_MODELS.default })],
      effective: [],
      connections: [{ id: "c9", name: "LM Studio", provider: "openai", base_url: "http://127.0.0.1:1234/v1", prefix_id: null, enabled: true, data: { models: ["old"] } }],
    });
    assert.equal((await sync(fake)).connections, 1);
    assert.equal(fake.state.writes[0]!.call, "PUT /api/admin/connections/c9");
    assert.equal(fake.state.writes[0]!.body.models, null);
    assert.equal(fake.state.writes[0]!.body.api_key, "secret");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a local server without a model list is refreshed over the same sign-in; one with a list is not", async () => {
  const stored = [claude({ models: CLAUDE_CODE_MODELS.models, default_model: CLAUDE_CODE_MODELS.default })];
  const discovered = setup({ connections: [{ name: "Ollama", base_url: "http://127.0.0.1:11434/v1" }] });
  const pinned = setup({ connections: [{ name: "Ollama", base_url: "http://127.0.0.1:11434/v1", models: ["llama3.1"] }] });
  try {
    const fake = fakeCptr({ stored, effective: [] });
    const keeper = cptrModelKeeper({ baseUrl: "http://127.0.0.1:8000", credentialsPath: join(discovered.directory, "cptr-credentials.json"), modelsPath: join(discovered.directory, "cptr-models.json"), fetchImpl: fake.fetchImpl });
    assert.equal(keeper.discovers(), true);
    await keeper.sync();
    await keeper.refresh();
    await keeper.refresh();
    assert.equal(fake.state.refreshes, 2);
    assert.equal(fake.state.logins, 1, "cptr rate-limits logins, so one sign-in serves every call");

    const other = cptrModelKeeper({ baseUrl: "http://127.0.0.1:8000", credentialsPath: join(pinned.directory, "cptr-credentials.json"), modelsPath: join(pinned.directory, "cptr-models.json"), fetchImpl: fake.fetchImpl });
    assert.equal(other.discovers(), false);
  } finally {
    rmSync(discovered.directory, { recursive: true, force: true });
    rmSync(pinned.directory, { recursive: true, force: true });
  }
});

test("cptr-models.json changes the built-in config, and a bad file falls back to it", () => {
  const { directory } = setup();
  const path = join(directory, "cptr-models.json");
  try {
    assert.deepEqual(readModelConfig(path), BUILT_IN_MODEL_CONFIG);
    // The first format: top-level models/default are Claude Code's.
    writeFileSync(path, JSON.stringify({ models: ["claude-next-1", " ", "claude-next-2"], default: "claude-next-2" }));
    assert.deepEqual(readModelConfig(path).agents.claude_code, { models: ["claude-next-1", "claude-next-2"], default: "claude-next-2" });
    writeFileSync(path, JSON.stringify({ claude_code: { models: ["claude-next-1"], default: "not-in-list" }, cursor: { models: ["composer"] } }));
    const config = readModelConfig(path);
    assert.equal(config.agents.claude_code!.default, "claude-next-1");
    assert.deepEqual(config.agents.cursor, { models: ["composer"], default: "composer" });
    writeFileSync(path, "not json");
    assert.deepEqual(readModelConfig(path), BUILT_IN_MODEL_CONFIG);
    writeFileSync(path, "[1, 2]");
    assert.deepEqual(readModelConfig(path), BUILT_IN_MODEL_CONFIG);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
