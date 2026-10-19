import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const DEFAULT_READY_TIMEOUT_MS = 60_000;
const DEFAULT_POLL_INTERVAL_MS = 500;
const INSTALL_TIMEOUT_MS = 10 * 60_000;
const START_TIMEOUT_MS = 30_000;

export type CodemanExecution = "native" | "wsl";

export interface CodemanSupervisorOptions {
  baseUrl?: string;
  /** When true (default), install Codeman if the binary is missing. */
  installIfMissing?: boolean;
  readyTimeoutMs?: number;
  pollIntervalMs?: number;
  wslDistro?: string;
  fetchImpl?: typeof fetch;
  runCommand?: (
    commandName: string,
    args: string[],
    options?: { timeout?: number; inheritStdio?: boolean },
  ) => SpawnSyncReturns<string>;
  sleep?: (ms: number) => Promise<void>;
  homedirImpl?: () => string;
  platformImpl?: NodeJS.Platform;
  pathExists?: (path: string) => boolean;
  log?: (message: string) => void;
}

export interface CodemanSupervisorHandle {
  /** True when this supervisor started Codeman during ensure(). */
  readonly startedByUs: boolean;
  stopIfOwned(): void;
}

export function envFlagFrom(env: NodeJS.ProcessEnv, name: string, defaultValue: boolean): boolean {
  const raw = env[name]?.trim().toLowerCase();
  if (raw === undefined || raw === "") return defaultValue;
  if (["1", "true", "yes", "on"].includes(raw)) return true;
  if (["0", "false", "no", "off"].includes(raw)) return false;
  return defaultValue;
}

/** Manage Codeman under the Worker by default. */
export function manageCodemanEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return envFlagFrom(env, "CLOUDAGENTFLEET_MANAGE_CODEMAN", true);
}

/** Auto-install when manage is on (default true). */
export function codemanInstallEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return envFlagFrom(env, "CLOUDAGENTFLEET_CODEMAN_INSTALL", true);
}

function resolveWslDistro(explicit?: string): string {
  return explicit ?? (process.env.CLOUDAGENTFLEET_WSL_DISTRO?.trim() || "Ubuntu");
}

function defaultRunCommand(
  commandName: string,
  args: string[],
  options?: { timeout?: number; inheritStdio?: boolean },
): SpawnSyncReturns<string> {
  return spawnSync(commandName, args, {
    encoding: "utf8",
    timeout: options?.timeout ?? 30_000,
    stdio: options?.inheritStdio ? "inherit" : ["ignore", "pipe", "pipe"],
    shell: false,
  });
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

export async function isCodemanReachable(
  baseUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  try {
    const response = await fetchImpl(`${normalizeBaseUrl(baseUrl)}/api/v1/status`, {
      signal: AbortSignal.timeout(3_000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

function resolveExecution(platformImpl: NodeJS.Platform): CodemanExecution {
  return platformImpl === "win32" ? "wsl" : "native";
}

function wrapShell(
  execution: CodemanExecution,
  script: string,
  wslDistro: string,
): { commandName: string; args: string[] } {
  if (execution === "wsl") {
    return {
      commandName: "wsl.exe",
      args: ["-d", wslDistro, "-e", "bash", "-lc", script],
    };
  }
  return { commandName: "bash", args: ["-lc", script] };
}

export function detectCodemanBinary(options: {
  runCommand?: CodemanSupervisorOptions["runCommand"];
  homedirImpl?: () => string;
  pathExists?: (path: string) => boolean;
  platformImpl?: NodeJS.Platform;
  wslDistro?: string;
}): string | undefined {
  const run = options.runCommand ?? defaultRunCommand;
  const home = options.homedirImpl ?? homedir;
  const pathExists = options.pathExists ?? existsSync;
  const platformImpl = options.platformImpl ?? process.platform;
  const wslDistro = resolveWslDistro(options.wslDistro);
  const execution = resolveExecution(platformImpl);

  if (execution === "native") {
    const which = run("sh", ["-lc", "command -v codeman"], { timeout: 5_000 });
    if (which.status === 0 && which.stdout?.trim()) return which.stdout.trim();
    const local = join(home(), ".local", "bin", "codeman");
    if (pathExists(local)) return local;
    return undefined;
  }

  const which = run("wsl.exe", ["-d", wslDistro, "-e", "bash", "-lc", "command -v codeman"], {
    timeout: 10_000,
  });
  if (which.status === 0 && which.stdout?.trim()) return which.stdout.trim();
  const localCheck = run(
    "wsl.exe",
    ["-d", wslDistro, "-e", "bash", "-lc", "test -x \"$HOME/.local/bin/codeman\" && echo \"$HOME/.local/bin/codeman\""],
    { timeout: 10_000 },
  );
  if (localCheck.status === 0 && localCheck.stdout?.trim()) return localCheck.stdout.trim();
  return undefined;
}

export function installCodeman(options: CodemanSupervisorOptions = {}): void {
  const run = options.runCommand ?? defaultRunCommand;
  const platformImpl = options.platformImpl ?? process.platform;
  const wslDistro = resolveWslDistro(options.wslDistro);
  const log = options.log ?? console.log;
  const execution = resolveExecution(platformImpl);

  if (platformImpl === "win32" && execution === "wsl") {
    const wslOk = run("wsl.exe", ["-d", wslDistro, "-e", "echo", "ok"], { timeout: 10_000 });
    if (wslOk.status !== 0) {
      throw new Error(
        `WSL distro "${wslDistro}" is required to install Codeman on Windows. `
        + "Install WSL (`wsl --install`) or set CLOUDAGENTFLEET_WSL_DISTRO.",
      );
    }
  }

  log("Installing Codeman via https://getcodeman.com/install …");
  const wrapped = wrapShell(execution, "curl -fsSL https://getcodeman.com/install | bash", wslDistro);
  const result = run(wrapped.commandName, wrapped.args, {
    timeout: INSTALL_TIMEOUT_MS,
    inheritStdio: true,
  });
  if (result.status !== 0) {
    const detail = result.stderr?.trim() || result.stdout?.trim() || `exit ${result.status}`;
    throw new Error(`Codeman install failed: ${detail}`);
  }
}

export function startCodemanDaemon(options: CodemanSupervisorOptions = {}): void {
  const run = options.runCommand ?? defaultRunCommand;
  const platformImpl = options.platformImpl ?? process.platform;
  const wslDistro = resolveWslDistro(options.wslDistro);
  const execution = resolveExecution(platformImpl);
  const wrapped = wrapShell(execution, "codeman web -d", wslDistro);
  const result = run(wrapped.commandName, wrapped.args, {
    timeout: START_TIMEOUT_MS,
    inheritStdio: true,
  });
  if (result.status !== 0) {
    const detail = result.stderr?.trim() || result.stdout?.trim() || `exit ${result.status}`;
    throw new Error(`Failed to start Codeman (\`codeman web -d\`): ${detail}`);
  }
}

export function stopCodemanDaemon(options: CodemanSupervisorOptions = {}): void {
  const run = options.runCommand ?? defaultRunCommand;
  const platformImpl = options.platformImpl ?? process.platform;
  const wslDistro = resolveWslDistro(options.wslDistro);
  const execution = resolveExecution(platformImpl);
  const wrapped = wrapShell(execution, "codeman web --stop", wslDistro);
  run(wrapped.commandName, wrapped.args, { timeout: START_TIMEOUT_MS, inheritStdio: false });
}

/**
 * Ensure Codeman is installed (optional) and reachable at baseUrl.
 * Starts `codeman web -d` when down; tracks ownership for shutdown cleanup.
 */
export async function ensureCodeman(
  options: CodemanSupervisorOptions = {},
): Promise<CodemanSupervisorHandle> {
  const baseUrl = normalizeBaseUrl(
    options.baseUrl ?? process.env.CLOUDAGENTFLEET_CODEMAN_URL ?? "http://127.0.0.1:3000",
  );
  const installIfMissing = options.installIfMissing ?? codemanInstallEnabled();
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? defaultSleep;
  const log = options.log ?? console.log;
  const readyTimeoutMs = options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;

  let startedByUs = false;

  if (await isCodemanReachable(baseUrl, fetchImpl)) {
    log(`Codeman already reachable at ${baseUrl}`);
    return {
      get startedByUs() {
        return startedByUs;
      },
      stopIfOwned() {
        /* pre-existing — leave running */
      },
    };
  }

  let binary = detectCodemanBinary(options);
  if (!binary) {
    if (!installIfMissing) {
      throw new Error(
        "Codeman is not installed and CLOUDAGENTFLEET_CODEMAN_INSTALL=false. "
        + "Install Codeman or enable auto-install.",
      );
    }
    installCodeman(options);
    binary = detectCodemanBinary(options);
    if (!binary) {
      throw new Error("Codeman install finished but `codeman` was not found on PATH.");
    }
  }

  log(`Starting Codeman web at ${baseUrl} …`);
  startCodemanDaemon(options);
  startedByUs = true;

  const deadline = Date.now() + readyTimeoutMs;
  while (Date.now() < deadline) {
    if (await isCodemanReachable(baseUrl, fetchImpl)) {
      log(`Codeman ready at ${baseUrl}`);
      return {
        get startedByUs() {
          return startedByUs;
        },
        stopIfOwned() {
          if (!startedByUs) return;
          log("Stopping Codeman started by this Worker …");
          try {
            stopCodemanDaemon(options);
          } catch {
            // Best-effort shutdown only.
          }
        },
      };
    }
    await sleep(pollIntervalMs);
  }

  // We started it but it never became ready: stop it rather than orphan it.
  try {
    stopCodemanDaemon(options);
  } catch {
    // Best-effort cleanup only.
  }
  throw new Error(
    `Codeman did not become ready at ${baseUrl}/api/v1/status within ${readyTimeoutMs}ms`,
  );
}
