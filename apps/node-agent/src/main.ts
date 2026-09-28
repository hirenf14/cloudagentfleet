import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { CodemanClient, CodemanWorkerRuntime, type CodemanMode } from "./codeman.ts";
import { validateConfig, type NodeAgentConfig } from "./index.ts";
import { ControllerTransport } from "./transport.ts";
import type {
  CodemanAgentProfile,
  WorkspaceDescriptor,
  WorkspacePolicy,
} from "../../../packages/protocol/src/index.ts";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function parseWorkspaces(): WorkspaceDescriptor[] {
  const raw = process.env.HOSTED_AGENTS_WORKSPACES ?? "[]";
  const value = JSON.parse(raw) as unknown;
  if (!Array.isArray(value)) throw new Error("HOSTED_AGENTS_WORKSPACES must be a JSON array");
  return (value as WorkspaceDescriptor[]).map((workspace) => ({
    ...workspace,
    id: `ws_${createHash("sha256").update(workspace.canonicalPath).digest("hex").slice(0, 20)}`,
  }));
}

function parsePolicy(): WorkspacePolicy {
  const mode = process.env.HOSTED_AGENTS_WORKSPACE_MODE === "system" ? "system" : "folders";
  const roots = (process.env.HOSTED_AGENTS_WORKSPACE_ROOTS ?? "")
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
}): CodemanAgentProfile[] {
  return [
    ...(providers.cursor ? [{
      id: "cursor-agent",
      name: "Cursor Agent",
      mode: "shell" as const,
      ready: providers.cursor.ready,
    }] : []),
    ...(providers.claude ? [{
      id: "claude-code",
      name: "Claude Code",
      mode: "shell" as const,
      ready: providers.claude.ready,
    }] : []),
  ];
}

function mode(): CodemanMode {
  const selected = process.env.HOSTED_AGENTS_CODEMAN_MODE ?? "claude";
  const modes: CodemanMode[] = [
    "claude",
    "shell",
    "opencode",
    "codex",
    "gemini",
    "antigravity",
    "pi",
    "grok",
    "deepseek",
  ];
  if (!modes.includes(selected as CodemanMode)) {
    throw new Error(`Unsupported HOSTED_AGENTS_CODEMAN_MODE: ${selected}`);
  }
  return selected as CodemanMode;
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
  const config = validateConfig({
    nodeId: required("HOSTED_AGENTS_NODE_ID"),
    name: process.env.HOSTED_AGENTS_NODE_NAME ?? "Hosted Agents Worker",
    platform: platform(),
    capabilities: ["codeman", ...(agentProfiles.length > 0 ? ["cursor-worker" as const] : [])],
    workspacePolicy: parsePolicy(),
    workspaces,
    controlPlaneUrl: required("HOSTED_AGENTS_CONTROLLER_URL"),
    authToken: process.env.HOSTED_AGENTS_AUTH_TOKEN,
  });
  const instanceId = process.env.CODEMAN_INSTANCE_ID ?? config.nodeId;
  const transport = new ControllerTransport({
    ...config,
    connectorInstanceId: instanceId,
    reconnect: true,
  });
  const codeman = new CodemanClient({
    baseUrl: process.env.CODEMAN_URL ?? "http://127.0.0.1:3000",
    username: process.env.CODEMAN_USERNAME,
    password: process.env.CODEMAN_PASSWORD,
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
  const stopEventForwarding = runtime.startEventForwarding();

  process.once("SIGINT", () => transport.stop());
  process.once("SIGTERM", () => transport.stop());
  try {
    await transport.start(
      (message) => runtime.handle(message),
      (request) => runtime.handleConnectorRequest(request),
    );
  } finally {
    stopEventForwarding();
  }
}

if (
  process.argv[1]?.endsWith("/main.ts")
  || process.argv[1]?.endsWith("\\main.ts")
  || process.argv[1]?.endsWith("/worker.mjs")
  || process.argv[1]?.endsWith("\\worker.mjs")
) {
  runWorker().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
