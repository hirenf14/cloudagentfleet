import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { appendFileSync, chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { envFlagFrom } from "./codeman-supervisor.ts";
import type { SupervisorHandle } from "./supervisor.ts";

const DEFAULT_READY_TIMEOUT_MS = 60_000;
const DEFAULT_POLL_INTERVAL_MS = 500;
const SETUP_TOKEN = /\/\?token=([0-9a-f]{32,128})/;

/**
 * Keeps a user-installed Open WebUI Computer (`cptr`) running for this
 * Worker. It never installs cptr (setup does that, with consent), only binds
 * loopback, and leaves an already-running cptr alone.
 */
export interface CptrSupervisorOptions {
  baseUrl?: string;
  command?: string;
  logPath?: string;
  /** Where the one-time setup token is written (0600); never printed. */
  tokenPath?: string;
  readyTimeoutMs?: number;
  pollIntervalMs?: number;
  fetchImpl?: typeof fetch;
  spawnImpl?: (command: string, args: string[], options: SpawnOptions) => ChildProcess;
  sleep?: (ms: number) => Promise<void>;
  log?: (message: string) => void;
}

/**
 * The cptr executable. Service managers (systemd, launchd) start the Worker
 * with a minimal PATH that lacks ~/.local/bin, where uv and pipx install cptr,
 * so prefer the path setup recorded, then that default location.
 */
export function resolveCptrCommand(
  env: NodeJS.ProcessEnv = process.env,
  pathExists: (path: string) => boolean = existsSync,
  home: string = homedir(),
  platform: NodeJS.Platform = process.platform,
): string {
  const configured = env.CLOUDAGENTFLEET_CPTR_COMMAND?.trim();
  if (configured) return configured;
  const userBin = join(home, ".local", "bin", platform === "win32" ? "cptr.exe" : "cptr");
  return pathExists(userBin) ? userBin : "cptr";
}

export function manageCptrEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return envFlagFrom(env, "CLOUDAGENTFLEET_MANAGE_CPTR", true);
}

export async function isCptrReachable(baseUrl: string, fetchImpl: typeof fetch = fetch): Promise<boolean> {
  try {
    const response = await fetchImpl(`${trimSlash(baseUrl)}/api/health`, {
      signal: AbortSignal.timeout(3_000),
    });
    if (!response.ok) return false;
    const body = await response.json().catch(() => undefined) as { status?: unknown } | undefined;
    return body?.status === "ok";
  } catch {
    return false;
  }
}

async function needsSetup(baseUrl: string, fetchImpl: typeof fetch): Promise<boolean> {
  try {
    const response = await fetchImpl(`${trimSlash(baseUrl)}/api/config`, {
      signal: AbortSignal.timeout(3_000),
    });
    const body = await response.json().catch(() => undefined) as { needs_setup?: unknown } | undefined;
    return body?.needs_setup === true;
  } catch {
    return false;
  }
}

export async function ensureCptr(options: CptrSupervisorOptions = {}): Promise<SupervisorHandle> {
  const baseUrl = trimSlash(
    options.baseUrl ?? process.env.CLOUDAGENTFLEET_CPTR_URL ?? "http://127.0.0.1:8000",
  );
  const fetchImpl = options.fetchImpl ?? fetch;
  const log = options.log ?? console.log;
  const sleep = options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));

  if (await isCptrReachable(baseUrl, fetchImpl)) {
    log(`Open WebUI Computer already reachable at ${baseUrl}`);
    if (await needsSetup(baseUrl, fetchImpl)) {
      log("Open WebUI Computer still needs first-run setup; use the token it printed when it started.");
    }
    return { startedByUs: false, stopIfOwned() {} };
  }

  const target = new URL(baseUrl);
  const loopback = ["127.0.0.1", "localhost", "[::1]", "::1"].includes(target.hostname);
  if (target.protocol !== "http:" || !loopback) {
    throw new Error(
      `Open WebUI Computer is not reachable at ${baseUrl}, and the Worker only starts it on loopback HTTP. `
      + "Start it yourself or set CLOUDAGENTFLEET_CPTR_URL=http://127.0.0.1:<port>.",
    );
  }
  const port = target.port || "80";
  const logPath = options.logPath ?? join(homedir(), ".cloudagentfleet", "cptr.log");
  const tokenPath = options.tokenPath ?? join(dirname(logPath), "cptr-setup-token");
  mkdirSync(dirname(logPath), { recursive: true });
  appendFileSync(logPath, `\n--- ${new Date().toISOString()} starting cptr ---\n`, { mode: 0o600 });
  chmodSync(logPath, 0o600);

  let token: string | undefined;
  let exitCode: number | null | undefined;
  let spawnError: Error | undefined;
  const child = (options.spawnImpl ?? spawn)(
    options.command ?? resolveCptrCommand(),
    ["run", "--headless", "--host", target.hostname.replace(/^\[|\]$/g, ""), "--port", port],
    {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      // Keep cptr from pinning the Worker's install folder.
      cwd: homedir(),
      // On Windows, Python writes piped output in the ANSI code page, and
      // cptr's startup banner then fails to encode and exits.
      env: { ...process.env, PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8" },
    },
  );
  const capture = (chunk: Buffer) => {
    const text = chunk.toString("utf8");
    token ??= text.match(SETUP_TOKEN)?.[1];
    // The token grants cptr's first admin account; keep it out of logs.
    appendFileSync(logPath, text.replace(SETUP_TOKEN, "/?token=<redacted: see cptr-setup-token>"));
  };
  child.stdout?.on("data", capture);
  child.stderr?.on("data", capture);
  child.once("exit", (code) => {
    exitCode = code;
  });
  child.once("error", (error) => {
    spawnError = error;
  });

  log(`Starting Open WebUI Computer at ${baseUrl} (log: ${logPath}) …`);
  const deadline = Date.now() + (options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS);
  while (Date.now() < deadline) {
    if (spawnError) {
      throw new Error(
        (spawnError as NodeJS.ErrnoException).code === "ENOENT"
          ? "Open WebUI Computer (`cptr`) is not installed. Rerun `cloudagentfleet setup` or `pipx install cptr`."
          : `Failed to start Open WebUI Computer: ${spawnError.message}`,
      );
    }
    if (exitCode !== undefined) {
      throw new Error(`Open WebUI Computer exited with code ${exitCode} before becoming ready; see ${logPath}`);
    }
    if (await isCptrReachable(baseUrl, fetchImpl)) {
      log(`Open WebUI Computer ready at ${baseUrl}`);
      if (token && await needsSetup(baseUrl, fetchImpl)) {
        writeFileSync(tokenPath, `${token}\n`, { mode: 0o600 });
        chmodSync(tokenPath, 0o600);
        log(
          "Open WebUI Computer needs first-run setup. Its one-time token is in "
          + `${tokenPath} (owner-only); open the host from the fleet dashboard and go to /?token=<token>.`,
        );
      }
      return {
        startedByUs: true,
        stopIfOwned() {
          log("Stopping Open WebUI Computer started by this Worker …");
          child.kill();
        },
      };
    }
    await sleep(options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS);
  }
  child.kill();
  throw new Error(`Open WebUI Computer did not become ready at ${baseUrl}/api/health; see ${logPath}`);
}

function trimSlash(value: string): string {
  return value.replace(/\/+$/, "");
}
