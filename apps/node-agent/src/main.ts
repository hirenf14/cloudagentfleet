import { CodemanClient, CodemanWorkerRuntime, type CodemanMode } from "./codeman.ts";
import { validateConfig, type NodeAgentConfig } from "./index.ts";
import { ControllerTransport } from "./transport.ts";
import type { WorkspaceDescriptor, WorkspacePolicy } from "../../../packages/protocol/src/index.ts";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function parseWorkspaces(): WorkspaceDescriptor[] {
  const raw = process.env.HOSTED_AGENTS_WORKSPACES ?? "[]";
  const value = JSON.parse(raw) as unknown;
  if (!Array.isArray(value)) throw new Error("HOSTED_AGENTS_WORKSPACES must be a JSON array");
  return value as WorkspaceDescriptor[];
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
  const workspaces = parseWorkspaces();
  const config = validateConfig({
    nodeId: required("HOSTED_AGENTS_NODE_ID"),
    name: process.env.HOSTED_AGENTS_NODE_NAME ?? "Hosted Agents Worker",
    platform: platform(),
    capabilities: ["codeman"],
    workspacePolicy: parsePolicy(),
    workspaces,
    controlPlaneUrl: required("HOSTED_AGENTS_CONTROLLER_URL"),
    authToken: process.env.HOSTED_AGENTS_AUTH_TOKEN,
  });
  const transport = new ControllerTransport(config);
  const codeman = new CodemanClient({
    baseUrl: process.env.CODEMAN_URL ?? "http://127.0.0.1:3000",
    username: process.env.CODEMAN_USERNAME,
    password: process.env.CODEMAN_PASSWORD,
  });
  const runtime = new CodemanWorkerRuntime({
    client: codeman,
    nodeId: config.nodeId,
    workspaces,
    workspacePolicy: config.workspacePolicy ?? { mode: "folders", roots: [] },
    send: (message) => transport.send(message),
    mode: mode(),
  });

  process.once("SIGINT", () => transport.stop());
  process.once("SIGTERM", () => transport.stop());
  await transport.start((message) => runtime.handle(message));
}

if (process.argv[1]?.endsWith("/main.ts") || process.argv[1]?.endsWith("\\main.ts")) {
  runWorker().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
