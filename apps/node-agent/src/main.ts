import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { CodemanClient, CodemanWorkerRuntime } from "./codeman.ts";
import {
  backendSupervisors,
  workerBackends,
  type SupervisorHandle,
} from "./supervisor.ts";
import { validateConfig, type NodeAgentConfig } from "./index.ts";
import { ControllerTransport } from "./transport.ts";
import { WorkerTunnels, type TunnelTarget } from "./tunnel.ts";
import type {
  CodemanAgentMode,
  AgentProfile,
  WorkspaceDescriptor,
  WorkspacePolicy,
} from "../../../packages/protocol/src/index.ts";
import { isCodemanAgentMode } from "../../../packages/protocol/src/index.ts";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function parseWorkspaces(): WorkspaceDescriptor[] {
  const raw = process.env.CLOUDAGENTFLEET_WORKSPACES ?? "[]";
  const value = JSON.parse(raw) as unknown;
  if (!Array.isArray(value)) throw new Error("CLOUDAGENTFLEET_WORKSPACES must be a JSON array");
  return (value as WorkspaceDescriptor[]).map((workspace) => ({
    ...workspace,
    id: `ws_${createHash("sha256").update(workspace.canonicalPath).digest("hex").slice(0, 20)}`,
  }));
}

function parsePolicy(): WorkspacePolicy {
  const mode = process.env.CLOUDAGENTFLEET_WORKSPACE_MODE === "system" ? "system" : "folders";
  const roots = (process.env.CLOUDAGENTFLEET_WORKSPACE_ROOTS ?? "")
    .split(";")
    .map((root) => root.trim())
    .filter(Boolean);
  return { mode, roots };
}

function platform(): NodeAgentConfig["platform"] {
  if (process.platform === "darwin") return "macos";
  if (process.platform === "win32") return "windows";
  return "linux";
}

function commandAvailable(commandName: string): boolean {
  const result = process.platform === "win32"
    ? spawnSync("where.exe", [commandName], { encoding: "utf8", stdio: "pipe" })
    : spawnSync("sh", ["-lc", `command -v ${commandName}`], { encoding: "utf8", stdio: "pipe" });
  return result.status === 0 && Boolean(result.stdout?.trim());
}

function detectCommand(commandNames: string[]): string | undefined {
  for (const commandName of commandNames) {
    if (commandAvailable(commandName)) return commandName;
  }
  for (const commandName of commandNames) {
    const installedPath = join(homedir(), ".local", "bin", commandName);
    if (existsSync(installedPath)) return installedPath;
  }
  return undefined;
}

function isCursorAuthenticated(commandName: string): boolean {
  const result = spawnSync(commandName, ["status"], {
    encoding: "utf8",
    stdio: "pipe",
    timeout: 5_000,
  });
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  return result.status === 0 && !/not logged in|login required|unauthenticated/i.test(output);
}

function detectAgentProfiles(providers: {
  cursor?: { command: string; ready: boolean };
  claude?: { command: string; ready: boolean };
}): AgentProfile[] {
  return [
    ...(providers.cursor ? [{
      id: "cursor-agent",
      name: "Cursor Agent CLI",
      mode: "shell" as const,
      ready: providers.cursor.ready,
    }] : []),
    ...(providers.claude ? [{
      id: "claude-code",
      name: "Claude Code CLI",
      mode: "shell" as const,
      ready: providers.claude.ready,
    }] : []),
  ];
}

function mode(): CodemanAgentMode {
  const selected = process.env.CLOUDAGENTFLEET_CODEMAN_MODE ?? "claude";
  if (!isCodemanAgentMode(selected)) {
    throw new Error(`Unsupported CLOUDAGENTFLEET_CODEMAN_MODE: ${selected}`);
  }
  return selected;
}

export async function runWorker(): Promise<void> {
  const cursorCommand = detectCommand(["agent", "cursor-agent"]);
  const claudeCommand = detectCommand(["claude"]);
  const providers = {
    ...(cursorCommand ? { cursor: { command: cursorCommand, ready: isCursorAuthenticated(cursorCommand) } } : {}),
    ...(claudeCommand ? { claude: { command: claudeCommand, ready: true } } : {}),
  };
  const agentProfiles = detectAgentProfiles(providers);
  const workspaces = parseWorkspaces().map((workspace) => ({
    ...workspace,
    providers: {
      ...workspace.providers,
      cursor: !providers.cursor
        ? "missing" as const
        : providers.cursor.ready
          ? "ready" as const
          : "unauthenticated" as const,
      claude: !providers.claude ? "missing" as const : "ready" as const,
    },
  }));
  const backends = workerBackends();
  const config = validateConfig({
    nodeId: required("CLOUDAGENTFLEET_NODE_ID"),
    name: process.env.CLOUDAGENTFLEET_NODE_NAME ?? "Cloud Agent Fleet Worker",
    platform: platform(),
    capabilities: [
      ...backends,
      ...(backends.includes("codeman") && agentProfiles.length > 0 ? ["cursor-worker" as const] : []),
    ],
    workspacePolicy: parsePolicy(),
    workspaces,
    controlPlaneUrl: required("CLOUDAGENTFLEET_CONTROLLER_URL"),
    authToken: process.env.CLOUDAGENTFLEET_AUTH_TOKEN,
  });
  const instanceId = process.env.CLOUDAGENTFLEET_CODEMAN_INSTANCE_ID ?? config.nodeId;
  const codemanBaseUrl = process.env.CLOUDAGENTFLEET_CODEMAN_URL ?? "http://127.0.0.1:3000";
  const supervised: SupervisorHandle[] = [];
  const stopSupervised = () => {
    for (const handle of supervised.splice(0)) handle.stopIfOwned();
  };
  let stopping = false;
  try {
    for (const supervisor of backendSupervisors(backends, { codeman: { baseUrl: codemanBaseUrl } })) {
      if (supervisor.required) {
        supervised.push(await supervisor.ensure());
        continue;
      }
      void supervisor.ensure().then(
        (handle) => {
          if (stopping) handle.stopIfOwned();
          else supervised.push(handle);
        },
        (error) => console.error(
          `${supervisor.backend} is unavailable; the Worker keeps running without it: ${
            error instanceof Error ? error.message : String(error)
          }`,
        ),
      );
    }
  } catch (error) {
    stopSupervised();
    throw error;
  }
  const transport = new ControllerTransport({
    ...config,
    connectorInstanceId: instanceId,
    reconnect: true,
  });
  const codeman = new CodemanClient({
    baseUrl: codemanBaseUrl,
    username: process.env.CLOUDAGENTFLEET_CODEMAN_USERNAME,
    password: process.env.CLOUDAGENTFLEET_CODEMAN_PASSWORD,
  });
  const runtime = new CodemanWorkerRuntime({
    client: codeman,
    nodeId: config.nodeId,
    instanceId,
    workspaces,
    workspacePolicy: config.workspacePolicy ?? { mode: "folders", roots: [] },
    send: (message) => transport.send(message),
    mode: mode(),
    agentProfiles,
    cursorCommand,
    claudeCommand,
  });
  // The connector and job runtime are Codeman-only; a cptr-only Worker just
  // supervises cptr and keeps its node heartbeat.
  const codemanEnabled = backends.includes("codeman");
  const stopEventForwarding = codemanEnabled ? runtime.startEventForwarding() : () => undefined;
  const codemanDisabled = async (): Promise<never> => {
    throw new Error("Codeman is not enabled on this Worker");
  };

  const shutdown = () => {
    stopping = true;
    transport.stop();
    stopSupervised();
  };
  // cptr connector driver: the Hub reaches this machine's cptr through the
  // Worker's outbound connection instead of an inbound tailnet port.
  const tunnels = backends.includes("cptr")
    ? new WorkerTunnels({
        targets: new Map([[
          process.env.CLOUDAGENTFLEET_CPTR_INSTANCE_ID ?? `${config.nodeId}-cptr`,
          loopbackTarget(process.env.CLOUDAGENTFLEET_CPTR_URL ?? "http://127.0.0.1:8000"),
        ]]),
        send: (message) => transport.send(message),
      })
    : undefined;

  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  try {
    await transport.start(
      codemanEnabled ? (message) => runtime.handle(message) : codemanDisabled,
      codemanEnabled ? (request) => runtime.handleConnectorRequest(request) : codemanDisabled,
      tunnels ? (message) => tunnels.handle(message) : undefined,
    );
  } catch (error) {
    // SIGINT/SIGTERM aborts the Controller stream; that is a clean shutdown.
    if (!(stopping && error instanceof Error && error.name === "AbortError")) throw error;
  } finally {
    stopping = true;
    tunnels?.closeAll();
    stopEventForwarding();
    stopSupervised();
  }
}

/** Tunnels may only reach a loopback service on this machine. */
function loopbackTarget(value: string): TunnelTarget {
  const url = new URL(value);
  const host = url.hostname.replace(/^[|]$/g, "");
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "::1"].includes(host)) {
    throw new Error(`CLOUDAGENTFLEET_CPTR_URL must be loopback HTTP for the connector driver: ${value}`);
  }
  return { host, port: Number(url.port || 80) };
}

function isDirectWorkerEntrypoint(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  const normalized = entry.replaceAll("\\", "/");
  return (
    normalized.endsWith("/main.ts")
    || normalized.endsWith("/worker.mjs")
    || normalized.endsWith("/cloudagentfleet-worker.mjs")
  );
}

if (isDirectWorkerEntrypoint()) {
  runWorker().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
