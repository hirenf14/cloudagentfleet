import { ensureCodeman, manageCodemanEnabled, type CodemanSupervisorOptions } from "./codeman-supervisor.ts";
import { ensureCptr, manageCptrEnabled, type CptrSupervisorOptions } from "./cptr-supervisor.ts";

/** A local backend process the Worker keeps running. */
export interface SupervisorHandle {
  /** True when this Worker started the process (and so stops it on exit). */
  readonly startedByUs: boolean;
  stopIfOwned(): void;
}

export type SupervisedBackend = "codeman" | "cptr";

export interface BackendSupervisor {
  readonly backend: SupervisedBackend;
  ensure(): Promise<SupervisorHandle>;
}

/** Backends this Worker runs, from `CLOUDAGENTFLEET_BACKENDS` (default `codeman`). */
export function workerBackends(env: NodeJS.ProcessEnv = process.env): SupervisedBackend[] {
  const requested = (env.CLOUDAGENTFLEET_BACKENDS ?? "codeman")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  const unknown = requested.filter((value) => value !== "codeman" && value !== "cptr");
  if (unknown.length > 0) throw new Error(`Unsupported CLOUDAGENTFLEET_BACKENDS: ${unknown.join(", ")}`);
  return [...new Set(requested as SupervisedBackend[])];
}

export function backendSupervisors(
  backends: SupervisedBackend[],
  options: { codeman?: CodemanSupervisorOptions; cptr?: CptrSupervisorOptions; env?: NodeJS.ProcessEnv } = {},
): BackendSupervisor[] {
  const env = options.env ?? process.env;
  const supervisors: BackendSupervisor[] = [];
  if (backends.includes("codeman") && manageCodemanEnabled(env)) {
    supervisors.push({ backend: "codeman", ensure: () => ensureCodeman(options.codeman) });
  }
  if (backends.includes("cptr") && manageCptrEnabled(env)) {
    supervisors.push({ backend: "cptr", ensure: () => ensureCptr(options.cptr) });
  }
  return supervisors;
}
