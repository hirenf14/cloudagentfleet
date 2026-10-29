import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { CptrSessions, cptrCredentialsPath } from "./cptr-session.ts";

/**
 * What Open WebUI Computer (cptr) offers in its model pickers, kept current by
 * the Worker through cptr's admin API instead of patching cptr.
 *
 * - cptr hard-codes its Claude list and its newest entries lag behind Claude
 *   Code. cptr merges a profile's own `models` into that list, so the Worker
 *   adds the current Claude models (and a default) to the Claude Code profile.
 *   Codex and Cursor models are asked of the agents themselves, so they need
 *   nothing; an operator can still add model ids to any agent profile.
 * - A "connection" is an OpenAI-compatible (or Anthropic) server such as
 *   Ollama, LM Studio, llama.cpp or vLLM, which gives cptr's plain chat local
 *   models. The operator lists them in the config file below.
 */
export interface ModelPolicy {
  models: string[];
  /** Used only when the profile has no default of its own. */
  default: string;
}

export interface CustomConnection {
  name: string;
  baseUrl: string;
  provider: "openai" | "anthropic";
  /** Model ids are shown as `<prefix>/<model>`. */
  prefix?: string;
  apiKey?: string;
  /** A whitelist; without it cptr discovers the models from the server. */
  models?: string[];
}

export interface ModelConfig {
  /** By cptr agent type: `claude_code`, `codex`, `cursor`, ... */
  agents: Record<string, ModelPolicy>;
  connections: CustomConnection[];
}

export const CLAUDE_CODE_MODELS: ModelPolicy = {
  models: ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5", "claude-fable-5-1"],
  default: "claude-opus-5-5",
};

export const BUILT_IN_MODEL_CONFIG: ModelConfig = { agents: { claude_code: CLAUDE_CODE_MODELS }, connections: [] };

export function cptrModelsPath(home: string = homedir()): string {
  return join(home, ".cloudagentfleet", "cptr-models.json");
}

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? [...new Set(value.filter((item): item is string => typeof item === "string" && item.trim() !== "").map((item) => item.trim()))]
    : [];
}

function policyFrom(value: unknown): ModelPolicy | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const { models: rawModels, default: rawDefault } = value as { models?: unknown; default?: unknown };
  const models = strings(rawModels);
  if (models.length === 0) return undefined;
  const wanted = typeof rawDefault === "string" ? rawDefault.trim() : "";
  return { models, default: models.includes(wanted) ? wanted : models[0]! };
}

function connectionFrom(value: unknown): CustomConnection | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const raw = value as Record<string, unknown>;
  const name = typeof raw.name === "string" ? raw.name.trim() : "";
  const baseUrl = typeof raw.base_url === "string" ? raw.base_url.trim().replace(/\/+$/, "") : "";
  if (!name || !/^https?:\/\/\S+$/.test(baseUrl)) return undefined;
  const models = strings(raw.models);
  return {
    name,
    baseUrl,
    provider: raw.provider === "anthropic" ? "anthropic" : "openai",
    ...(typeof raw.prefix_id === "string" && raw.prefix_id.trim() ? { prefix: raw.prefix_id.trim() } : {}),
    ...(typeof raw.api_key === "string" && raw.api_key ? { apiKey: raw.api_key } : {}),
    ...(models.length > 0 ? { models } : {}),
  };
}

/**
 * The built-in config, changed by `~/.cloudagentfleet/cptr-models.json`:
 *
 *     {
 *       "claude_code": { "models": ["claude-..."], "default": "claude-..." },
 *       "codex":       { "models": ["my-codex-model"] },
 *       "connections": [
 *         { "name": "Ollama", "base_url": "http://127.0.0.1:11434/v1", "prefix_id": "ollama", "models": ["llama3.1"] }
 *       ]
 *     }
 *
 * An agent entry replaces the built-in list for that agent (Claude Code) or
 * adds ids to it (any other agent). Top-level `models`/`default` still mean
 * Claude Code. A bad file or entry is ignored.
 */
export function readModelConfig(path: string = cptrModelsPath()): ModelConfig {
  let file: Record<string, unknown>;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return BUILT_IN_MODEL_CONFIG;
    file = parsed as Record<string, unknown>;
  } catch {
    return BUILT_IN_MODEL_CONFIG;
  }
  const agents: Record<string, ModelPolicy> = { ...BUILT_IN_MODEL_CONFIG.agents };
  const legacy = policyFrom(file);
  if (legacy) agents.claude_code = legacy;
  for (const [agent, value] of Object.entries(file)) {
    if (agent === "connections" || agent === "models" || agent === "default") continue;
    const policy = policyFrom(value);
    if (policy) agents[agent] = policy;
  }
  const connections = Array.isArray(file.connections)
    ? file.connections.flatMap((entry) => connectionFrom(entry) ?? [])
    : [];
  return { agents, connections };
}

type Profile = Record<string, unknown> & { agent?: unknown; models?: unknown; default_model?: unknown };
type Connection = Record<string, unknown> & { id?: unknown; name?: unknown; data?: { models?: unknown } };
type Request = (path: string, init?: RequestInit) => Promise<unknown>;

/** Stands in for the API key of a local server that has none. */
const LOCAL_API_KEY = "local";

/** cptr's built-in agent profiles (id, agent), as of cptr 0.9. */
const CPTR_DEFAULT_AGENTS: Array<[string, string]> = [
  ["codex", "codex"],
  ["claude-code", "claude_code"],
  ["cursor", "cursor"],
  ["grok", "grok"],
  ["opencode", "opencode"],
  ["cline", "cline"],
  ["gemini", "gemini"],
  ["pi", "pi"],
];

export type ModelSyncResult = "updated" | "current" | "nothing-to-do";

export interface CptrModelSync {
  profiles: ModelSyncResult;
  /** Connections created or changed. */
  connections: number;
}

/**
 * Brings cptr's agent profiles and connections in line with the model config.
 * Models and a default the operator already set are kept; only missing models
 * are added, and a default is set only when the profile has none.
 */
export interface CptrModelKeeperOptions {
  baseUrl: string;
  credentialsPath?: string;
  modelsPath?: string;
  fetchImpl?: typeof fetch;
}

export interface CptrModelKeeper {
  sync(): Promise<CptrModelSync>;
  /**
   * Makes cptr look at its local model servers again. cptr caches what it
   * discovered until told otherwise, so a model pulled later would not show.
   */
  refresh(): Promise<void>;
  /** Whether any connection leaves its model list to discovery, so `refresh` is worth calling. */
  discovers(): boolean;
}

/** One sign-in is shared by every call, because cptr rate-limits logins. */
export function cptrModelKeeper(options: CptrModelKeeperOptions): CptrModelKeeper {
  const baseUrl = options.baseUrl.replace(/\/+$/, "");
  const fetchImpl = options.fetchImpl ?? fetch;
  const sessions = new CptrSessions({
    baseUrl,
    credentialsPath: options.credentialsPath ?? cptrCredentialsPath(),
    fetchImpl,
  });
  const request: Request = async (path, init = {}) => {
    const { token } = await sessions.session();
    const response = await fetchImpl(`${baseUrl}${path}`, {
      ...init,
      headers: { cookie: `cptr_session=${token}`, "content-type": "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      const detail = (await response.json().catch(() => undefined) as { detail?: unknown } | undefined)?.detail;
      throw new Error(`cptr ${path} answered HTTP ${response.status}${typeof detail === "string" ? `: ${detail}` : ""}`);
    }
    return response.json();
  };
  return {
    async sync() {
      const config = readModelConfig(options.modelsPath);
      const profiles = await syncProfiles(request, config.agents);
      const connections = await syncConnections(request, config.connections);
      return { profiles, connections };
    },
    async refresh() {
      await request("/api/admin/agents/refresh", { method: "POST" });
    },
    discovers: () => readModelConfig(options.modelsPath).connections.some((connection) => !connection.models),
  };
}

export function syncCptrModels(options: CptrModelKeeperOptions): Promise<CptrModelSync> {
  return cptrModelKeeper(options).sync();
}

async function syncProfiles(request: Request, agents: Record<string, ModelPolicy>): Promise<ModelSyncResult> {
  const stored = ((await request("/api/admin/config/agents")) as { config?: Record<string, unknown> }).config?.["agents.profiles"];
  let profiles: Profile[];
  if (Array.isArray(stored) && stored.length > 0) {
    profiles = stored as Profile[];
  } else {
    // Nothing saved yet: cptr is using its built-in profiles, so write those out (without the models cptr
    // detected itself, which it keeps adding on its own, nor the default it derived from them) to give our
    // models somewhere to live.
    const status = (await request("/api/admin/agents")) as { profiles?: Array<{ config?: Profile }> };
    profiles = (status.profiles ?? []).flatMap((entry) => (entry.config ? [{ ...entry.config, models: [], default_model: "" }] : []));
    // cptr lists only the agents it found until profiles are saved; once saved it lists exactly those. Keep
    // the agents that are not installed yet in the list (cptr fills in their name and command), so installing
    // one later still shows it. A machine with none of the agents we have models for is left untouched.
    if (!profiles.some((profile) => typeof profile.agent === "string" && profile.agent in agents)) return "nothing-to-do";
    for (const [id, agent] of CPTR_DEFAULT_AGENTS) {
      if (!profiles.some((profile) => profile.id === id)) profiles.push({ id, agent, mode: "auto" });
    }
  }

  let known = false;
  let changed = false;
  for (const profile of profiles) {
    const policy = typeof profile.agent === "string" ? agents[profile.agent] : undefined;
    if (!policy) continue;
    known = true;
    const existing = Array.isArray(profile.models) ? profile.models.filter((model): model is string => typeof model === "string") : [];
    const models = [...new Set([...policy.models, ...existing])];
    const defaultModel = typeof profile.default_model === "string" && profile.default_model ? profile.default_model : policy.default;
    if (models.length !== existing.length || defaultModel !== profile.default_model || models.some((model, index) => model !== existing[index])) {
      profile.models = models;
      profile.default_model = defaultModel;
      changed = true;
    }
  }
  if (!known) return "nothing-to-do";
  if (!changed) return "current";
  await request("/api/admin/agents", { method: "PUT", body: JSON.stringify({ profiles }) });
  return "updated";
}

async function syncConnections(request: Request, wanted: CustomConnection[]): Promise<number> {
  if (wanted.length === 0) return 0;
  const existing = ((await request("/api/admin/connections")) as { connections?: Connection[] }).connections ?? [];
  let changes = 0;
  for (const connection of wanted) {
    const fields = {
      name: connection.name,
      provider: connection.provider,
      base_url: connection.baseUrl,
      prefix_id: connection.prefix ?? "",
      enabled: true,
      ...(connection.models ? { models: connection.models } : {}),
      // cptr 0.9 sends `Authorization: Bearer ` with an empty key, which its HTTP client rejects, so a local
      // server that needs no key could neither be discovered nor chatted with. Servers like Ollama ignore it.
      ...(connection.apiKey ? { api_key: connection.apiKey } : connection.provider === "openai" ? { api_key: LOCAL_API_KEY } : {}),
    };
    const current = existing.find((entry) => entry.name === connection.name);
    if (!current) {
      await request("/api/admin/connections", { method: "POST", body: JSON.stringify(fields) });
      changes += 1;
      continue;
    }
    const currentModels = Array.isArray(current.data?.models) ? (current.data.models as unknown[]) : undefined;
    const same = current.provider === connection.provider
      && (current.base_url ?? "") === connection.baseUrl
      && (current.prefix_id ?? "") === (connection.prefix ?? "")
      && current.enabled !== false
      && (connection.models
        ? currentModels?.length === connection.models.length && connection.models.every((model, index) => model === currentModels[index])
        : currentModels === undefined);
    if (same) continue;
    // `models: null` clears the whitelist so cptr goes back to discovering them. The key is only sent along
    // with a real change: cptr returns it masked, so it cannot be compared.
    await request(`/api/admin/connections/${String(current.id)}`, {
      method: "PUT",
      body: JSON.stringify({ ...fields, ...(connection.models ? {} : { models: null }) }),
    });
    changes += 1;
  }
  return changes;
}
