import type {
  AgentProfile,
  HostSession,
  HostSessionEvent,
} from "../../../packages/protocol/src/index.ts";
import {
  codemanAgentName,
  isCodemanAgentMode,
  isRecord,
} from "../../../packages/protocol/src/index.ts";

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

export interface SseFrame {
  event?: string;
  data: string;
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

/** Reads an SSE body until it ends or the signal aborts. Never throws. */
export async function readSseStream(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
  onFrame: (frame: SseFrame) => void,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (!signal.aborted) {
      const result = await reader.read();
      if (result.done) return;
      buffer += decoder.decode(result.value, { stream: true });
      let boundary = sseBoundary(buffer);
      while (boundary) {
        const raw = buffer.slice(0, boundary.index);
        buffer = buffer.slice(boundary.index + boundary.length);
        boundary = sseBoundary(buffer);
        const lines = raw.split(/\r?\n/);
        const data = lines
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart())
          .join("\n");
        if (!data) continue;
        const event = lines
          .find((line) => line.startsWith("event:"))
          ?.slice("event:".length)
          .trim();
        onFrame(event ? { event, data } : { data });
      }
    }
  } catch {
    // Callers keep their HTTP control path when the event stream closes.
  } finally {
    reader.releaseLock();
  }
}

function sseBoundary(value: string): { index: number; length: number } | undefined {
  const lineFeed = value.indexOf("\n\n");
  const carriageReturn = value.indexOf("\r\n\r\n");
  if (lineFeed < 0 && carriageReturn < 0) return undefined;
  if (lineFeed < 0) return { index: carriageReturn, length: 4 };
  if (carriageReturn < 0 || lineFeed < carriageReturn) {
    return { index: lineFeed, length: 2 };
  }
  return { index: carriageReturn, length: 4 };
}
