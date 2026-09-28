import {
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import type {
  AuditEvent,
  CodemanInstance,
  CodemanSession,
} from "./index.ts";
import {
  isCodemanInstance,
  isCodemanSession,
  validateCodemanInstance,
  validateCodemanSession,
} from "./index.ts";

export interface HubState {
  instances: CodemanInstance[];
  sessions: CodemanSession[];
  audit: AuditEvent[];
}

const emptyState = (): HubState => ({ instances: [], sessions: [], audit: [] });

/**
 * Small durable local store for the single-owner Hub.
 *
 * Writes are atomic at the file level: state is serialized to a temporary file
 * beside the configured path, then renamed into place.
 */
export class HubStateStore {
  private state: HubState;
  private readonly path: string | undefined;

  constructor(path?: string) {
    this.path = path;
    this.state = path ? load(path) : emptyState();
  }

  snapshot(): HubState {
    return structuredClone(this.state);
  }

  upsertInstance(instance: CodemanInstance): void {
    validateCodemanInstance(instance);
    const index = this.state.instances.findIndex((candidate) => candidate.id === instance.id);
    if (index < 0) this.state.instances.push(structuredClone(instance));
    else this.state.instances[index] = structuredClone(instance);
    this.persist();
  }

  removeInstance(instanceId: string): void {
    this.state.instances = this.state.instances.filter((instance) => instance.id !== instanceId);
    this.state.sessions = this.state.sessions.filter((session) => session.instanceId !== instanceId);
    this.persist();
  }

  upsertSession(session: CodemanSession): void {
    validateCodemanSession(session);
    const index = this.state.sessions.findIndex(
      (candidate) => candidate.instanceId === session.instanceId && candidate.id === session.id,
    );
    if (index < 0) this.state.sessions.push(structuredClone(session));
    else this.state.sessions[index] = structuredClone(session);
    this.persist();
  }

  removeSession(instanceId: string, sessionId: string): void {
    this.state.sessions = this.state.sessions.filter(
      (session) => session.instanceId !== instanceId || session.id !== sessionId,
    );
    this.persist();
  }

  appendAudit(event: AuditEvent): void {
    this.state.audit.push(structuredClone(event));
    this.persist();
  }

  private persist(): void {
    if (!this.path) return;
    mkdirSync(dirname(this.path), { recursive: true });
    const temp = `${this.path}.tmp`;
    const serialized = `${JSON.stringify(this.state, null, 2)}\n`;
    writeFileSync(temp, serialized, { mode: 0o600 });
    try {
      renameSync(temp, this.path);
      chmodSync(this.path, 0o600);
    } catch {
      // Windows may hold an open antivirus handle on the destination.
      writeFileSync(this.path, serialized, { mode: 0o600 });
      chmodSync(this.path, 0o600);
      try {
        unlinkSync(temp);
      } catch {
        // Best-effort cleanup only.
      }
    }
  }
}

function load(path: string): HubState {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<HubState>;
    return {
      instances: Array.isArray(parsed.instances)
        ? parsed.instances.filter(isCodemanInstance)
        : [],
      sessions: Array.isArray(parsed.sessions)
        ? parsed.sessions.filter(isCodemanSession)
        : [],
      audit: Array.isArray(parsed.audit)
        ? parsed.audit.filter(isAuditEvent)
        : [],
    };
  } catch {
    return emptyState();
  }
}

function isAuditEvent(value: unknown): value is AuditEvent {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const event = value as Record<string, unknown>;
  return typeof event.id === "string"
    && isAuditType(event.type)
    && (event.actor === "system" || event.actor === "operator" || event.actor === "node")
    && typeof event.resourceId === "string"
    && typeof event.createdAt === "string"
    && typeof event.metadata === "object"
    && event.metadata !== null
    && !Array.isArray(event.metadata)
    && Object.values(event.metadata).every((entry) => typeof entry === "string");
}

function isAuditType(value: unknown): value is AuditEvent["type"] {
  return value === "node.enrolled"
    || value === "node.heartbeat"
    || value === "node.revoked"
    || value === "job.created"
    || value === "job.started"
    || value === "job.completed"
    || value === "job.failed"
    || value === "job.cancelled"
    || value === "instance.registered"
    || value === "instance.removed"
    || value === "instance.health"
    || value === "session.created"
    || value === "session.stopped"
    || value === "session.removed"
    || value === "preview.created"
    || value === "preview.revoked"
    || value === "browser.started"
    || value === "browser.stopped";
}
