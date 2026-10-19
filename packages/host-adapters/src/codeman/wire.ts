import type {
  AgentProfile,
  HostSession,
  HostSessionEvent,
} from "../../../../packages/protocol/src/index.ts";
import {
  codemanAgentName,
  isCodemanAgentMode,
  isRecord,
} from "../../../../packages/protocol/src/index.ts";

/**
 * Codeman wire-format helpers shared by the Hub's HTTP adapter and the
 * Worker's connector runtime, so both sides map Codeman payloads identically.
 */

export interface CodemanEnvelope<T> {
  success: boolean;
  data?: T;
  error?: string;
  errorCode?: string;
}

/** Codeman `/api/v1/status` payload, normalized. */
export interface CodemanStatus {
  version?: string;
  agents?: AgentProfile[];
  capabilities?: string[];
  sessions?: number;
}

export function codemanSessionStatus(status: string): HostSession["status"] {
  if (status === "running" || status === "working" || status === "busy") return "working";
  if (status === "starting" || status === "created") return "starting";
  if (status === "completed") return "completed";
  if (status === "failed") return "failed";
  if (status === "stopped" || status === "deleted" || status === "exited") return "stopped";
  if (status === "waiting" || status === "blocked") return "waiting";
  return "idle";
}

export function codemanEventKind(type: string): HostSessionEvent["event"] | undefined {
  const normalized = type.toLowerCase();
  if (normalized.includes("terminal") || normalized.includes("output")) return "output";
  if (
    normalized === "hook:idle_prompt"
    || normalized.includes("permission")
    || normalized.includes("wait")
  ) return "waiting";
  if (normalized.includes("idle")) return "idle";
  if (normalized.includes("fail") || normalized.includes("error")) return "failed";
  if (normalized.includes("complete")) return "completed";
  if (normalized.includes("exit") || normalized.includes("delet")) return "stopped";
  if (normalized.includes("start") || normalized.includes("run")) return "started";
  if (normalized.includes("stop")) return "stopped";
  if (normalized.includes("create")) return "created";
  return undefined;
}

/** Codeman nests the session ID differently across event types. */
export function codemanEventSessionId(payload: Record<string, unknown>): string {
  const session = isRecord(payload.session) ? payload.session : undefined;
  const data = isRecord(payload.data) ? payload.data : undefined;
  return String(
    payload.sessionId
    ?? payload.session_id
    ?? session?.id
    ?? data?.sessionId
    ?? data?.session_id
    ?? "",
  );
}

export function codemanTimestamp(value: unknown): string {
  if (typeof value === "string" && !Number.isNaN(Date.parse(value))) return value;
  if (typeof value === "number" && Number.isFinite(value)) return new Date(value).toISOString();
  return new Date().toISOString();
}

/**
 * Normalizes a Codeman status agent (a mode string or a profile object).
 * Opaque capability strings that would collapse into duplicate shell entries
 * are dropped.
 */
export function normalizeCodemanAgent(raw: unknown): AgentProfile | undefined {
  if (typeof raw === "string") {
    if (!isCodemanAgentMode(raw)) return undefined;
    return { id: raw, name: codemanAgentName(raw, raw), mode: raw, ready: true };
  }
  if (!isRecord(raw)) return undefined;
  const modeRaw = String(raw.mode ?? raw.id ?? "shell");
  const mode = isCodemanAgentMode(modeRaw) ? modeRaw : "shell";
  const id = String(raw.id ?? mode);
  if (mode === "shell" && id !== "shell" && !String(raw.name ?? "").trim()) return undefined;
  return {
    id,
    name: String(raw.name ?? codemanAgentName(id, mode)),
    mode,
    ready: raw.ready !== false && raw.available !== false,
  };
}

export function dedupeAgents(agents: AgentProfile[]): AgentProfile[] {
  const seen = new Set<string>();
  return agents.filter((agent) => {
    if (seen.has(agent.id)) return false;
    seen.add(agent.id);
    return true;
  });
}
