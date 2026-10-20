import { ensureCodeman, manageCodemanEnabled, type CodemanSupervisorOptions } from "./codeman-supervisor.ts";
import { ensureCptr, manageCptrEnabled, type CptrSupervisorOptions } from "./cptr-supervisor.ts";
import { isHostBackend, type HostBackend } from "../../../packages/protocol/src/index.ts";

/** A local backend process the Worker keeps running. */
export interface SupervisorHandle {
  /** True when this Worker started the process (and so stops it on exit). */
  readonly startedByUs: boolean;
  stopIfOwned(): void;
}

export type SupervisedBackend = HostBackend;

export interface BackendSupervisor {
  readonly backend: SupervisedBackend;
  /** A required backend's failure stops the Worker; an optional one only logs. */
  readonly required: boolean;
  ensure(): Promise<SupervisorHandle>;
}

/** Backends this Worker runs, from `CLOUDAGENTFLEET_BACKENDS` (default `codeman`). */
export function workerBackends(env: NodeJS.ProcessEnv = process.env): SupervisedBackend[] {
  const requested = (env.CLOUDAGENTFLEET_BACKENDS ?? "codeman")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  const unknown = requested.filter((value) => !isHostBackend(value));
  if (unknown.length > 0) throw new Error(`Unsupported CLOUDAGENTFLEET_BACKENDS: ${unknown.join(", ")}`);
  return [...new Set(requested.filter(isHostBackend))];
}

export function backendSupervisors(
  backends: SupervisedBackend[],
  options: { codeman?: CodemanSupervisorOptions; cptr?: CptrSupervisorOptions; env?: NodeJS.ProcessEnv } = {},
): BackendSupervisor[] {
  const env = options.env ?? process.env;
  const supervisors: BackendSupervisor[] = [];
  if (backends.includes("codeman") && manageCodemanEnabled(env)) {
    // The connector and jobs depend on Codeman, so it is required when selected.
    supervisors.push({ backend: "codeman", required: true, ensure: () => ensureCodeman(options.codeman) });
  }
  if (backends.includes("cptr") && manageCptrEnabled(env)) {
    // cptr is independent of the connector: a cptr problem must not take the Worker offline.
    supervisors.push({ backend: "cptr", required: false, ensure: () => ensureCptr(options.cptr) });
  }
  return supervisors;
}
