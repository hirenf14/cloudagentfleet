import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { CptrSessions, cptrCredentialsPath } from "./cptr-session.ts";

/**
 * Open WebUI Computer (cptr) hard-codes its Claude model list, and its newest
 * entries lag behind Claude Code. cptr merges a profile's own `models` into
 * that list, so the Worker adds the current models to the Claude Code profile
 * through cptr's admin API instead of patching cptr.
 */
export interface ModelPolicy {
  models: string[];
  /** Used only when the profile has no default of its own. */
  default: string;
}

export const CLAUDE_CODE_MODELS: ModelPolicy = {
  models: ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5", "claude-fable-5-1"],
  default: "claude-opus-5-5",
};

export function cptrModelsPath(home: string = homedir()): string {
  return join(home, ".cloudagentfleet", "cptr-models.json");
}

/**
 * The model list, with `~/.cloudagentfleet/cptr-models.json` (`{"models": [...], "default": "..."}`)
 * replacing the built-in one, so a new model can be offered without a Worker release.
 */
export function readClaudeModelPolicy(path: string = cptrModelsPath()): ModelPolicy {
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as { models?: unknown; default?: unknown };
    const models = Array.isArray(value.models)
      ? value.models.filter((model): model is string => typeof model === "string" && model.trim() !== "").map((model) => model.trim())
      : [];
    if (models.length === 0) return CLAUDE_CODE_MODELS;
    const fallback = typeof value.default === "string" ? value.default.trim() : "";
    return { models, default: models.includes(fallback) ? fallback : models[0]! };
  } catch {
    return CLAUDE_CODE_MODELS;
  }
}

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

type Profile =Record<string, unknown> & { agent?: unknown; models?: unknown; default_model?: unknown };

export type ModelSyncResult = "updated" | "current" | "no-claude-profile";

/**
 * Makes sure cptr's Claude Code profile offers the current models. Existing
 * models and an explicit default the operator chose are kept; only missing
 * models are added, and the default is set only when the profile has none.
 */
export async function syncCptrClaudeModels(options: {
  baseUrl: string;
  credentialsPath?: string;
  modelsPath?: string;
  fetchImpl?: typeof fetch;
}): Promise<ModelSyncResult> {
  const baseUrl = options.baseUrl.replace(/\/+$/, "");
  const fetchImpl = options.fetchImpl ?? fetch;
  const policy = readClaudeModelPolicy(options.modelsPath);
  const sessions = new CptrSessions({
    baseUrl,
    credentialsPath: options.credentialsPath ?? cptrCredentialsPath(),
    fetchImpl,
  });
  const { token } = await sessions.session();
  const request = async (path: string, init: RequestInit = {}): Promise<unknown> => {
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

  const stored = ((await request("/api/admin/config/agents")) as { config?: Record<string, unknown> }).config?.["agents.profiles"];
  let profiles: Profile[];
  if (Array.isArray(stored) && stored.length > 0) {
    profiles = stored as Profile[];
  } else {
    // Nothing saved yet: cptr is using its built-in profiles, so write those out (without the models it
    // detected itself, which cptr keeps adding on its own, nor the default it derived from them) to give the
    // Claude Code profile somewhere to live.
    const status = (await request("/api/admin/agents")) as { profiles?: Array<{ config?: Profile }> };
    profiles = (status.profiles ?? []).flatMap((entry) => (entry.config ? [{ ...entry.config, models: [], default_model: "" }] : []));
    // cptr lists only the agents it found until profiles are saved; once saved it lists exactly those. Keep
    // the agents that are not installed yet in the list (cptr fills in their name and command), so installing
    // one later still shows it. A machine without Claude Code has nothing to add, so it is left untouched.
    if (!profiles.some((profile) => profile.agent === "claude_code")) return "no-claude-profile";
    for (const [id, agent] of CPTR_DEFAULT_AGENTS) {
      if (!profiles.some((profile) => profile.id === id)) profiles.push({ id, agent, mode: "auto" });
    }
  }

  let changed = false;
  for (const profile of profiles) {
    if (profile.agent !== "claude_code") continue;
    const existing = Array.isArray(profile.models) ? profile.models.filter((model): model is string => typeof model === "string") : [];
    const models = [...new Set([...policy.models, ...existing])];
    const defaultModel = typeof profile.default_model === "string" && profile.default_model ? profile.default_model : policy.default;
    if (models.length !== existing.length || defaultModel !== profile.default_model || models.some((model, index) => model !== existing[index])) {
      profile.models = models;
      profile.default_model = defaultModel;
      changed = true;
    }
  }
  if (!profiles.some((profile) => profile.agent === "claude_code")) return "no-claude-profile";
  if (!changed) return "current";
  await request("/api/admin/agents", { method: "PUT", body: JSON.stringify({ profiles }) });
  return "updated";
}
