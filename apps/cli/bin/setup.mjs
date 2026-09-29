import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, hostname } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

const executableRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const runtimeRoot = existsSync(join(executableRoot, "runtime"))
  ? executableRoot
  : repoRoot;
const configPath = join(homedir(), ".hosted-agents", "worker.json");
const instancesConfigPath = join(homedir(), ".hosted-agents", "instances.json");
const modes = ["claude", "shell", "opencode", "codex", "gemini", "antigravity", "pi", "grok", "deepseek"];
const defaultAgentNames = { claude: "Claude Code" };
const tailscaleCommand = process.platform === "win32" ? "tailscale.exe" : "tailscale";
const loopbackHosts = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
const wslDistro = process.env.HOSTED_AGENTS_WSL_DISTRO?.trim() || "Ubuntu";

function command(commandName, args = [], options = {}) {
  return spawnSync(commandName, args, {
    encoding: "utf8",
    timeout: options.timeout ?? 3000,
    stdio: options.capture === false ? "inherit" : ["ignore", "pipe", "pipe"],
    shell: options.shell ?? false,
  });
}

function canRun(commandName, args = ["--version"]) {
  return command(commandName, args).status === 0;
}

export function parseHubOptions(args = [], env = process.env) {
  const parsed = parseOptions(args);
  if (parsed.positionals.length > 0) {
    throw new Error(`Unexpected Hub option: ${parsed.positionals[0]}`);
  }
  const host = optionValue(parsed, "host") ?? env.HOSTED_AGENTS_HOST ?? "127.0.0.1";
  const rawPort = optionValue(parsed, "port") ?? env.HOSTED_AGENTS_PORT ?? "8787";
  if (!/^\d+$/.test(rawPort)) throw new Error("Hub port must be a number between 1 and 65535");
  const port = Number(rawPort);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
    throw new Error("Hub port must be a number between 1 and 65535");
  }
  if (!loopbackHosts.has(host.toLowerCase())) {
    throw new Error(
      `Hub private serving requires a loopback bind address; got "${host}". `
      + "Set HOSTED_AGENTS_HOST=127.0.0.1 and restart the Controller.",
    );
  }
  return { host, port };
}

function tailscaleFailure(result) {
  const detail = result?.stderr?.trim() || result?.stdout?.trim();
  return detail ? `: ${detail}` : "";
}

export function runTailscale(args, runner = command) {
  const result = runner(tailscaleCommand, args, { shell: false });
  if (result?.error?.code === "ENOENT") {
    throw new Error(
      "Tailscale CLI was not found. Install Tailscale, sign in to the tailnet, "
      + "and ensure tailscale is available on PATH.",
    );
  }
  if (result?.error) {
    throw new Error(`Could not run Tailscale CLI: ${result.error.message}`);
  }
  if (result?.status !== 0) {
    throw new Error(
      `Tailscale command failed (${args.join(" ")})${tailscaleFailure(result)}. `
      + "Confirm Tailscale is running and this machine is connected to the tailnet.",
    );
  }
  return result;
}

async function checkLocalHub(port, authToken, fetchImpl = fetch) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5_000);
  try {
    const response = await fetchImpl(`http://127.0.0.1:${port}/healthz`, {
      headers: authToken ? { authorization: `Bearer ${authToken}` } : {},
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`returned HTTP ${response.status}`);
    }
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error(`Hub health check timed out at http://127.0.0.1:${port}/healthz`);
    }
    throw new Error(
      `Hub is not reachable at http://127.0.0.1:${port}. `
      + "Start the Controller on loopback before enabling Tailscale Serve.",
      { cause: error },
    );
  } finally {
    clearTimeout(timeout);
  }
}

export async function serveHub(args = [], dependencies = {}) {
  const env = dependencies.env ?? process.env;
  const config = parseHubOptions(args, env);
  const runner = dependencies.runner ?? command;
  runTailscale(["version"], runner);
  runTailscale(["status"], runner);
  await checkLocalHub(config.port, env.HOSTED_AGENTS_AUTH_TOKEN, dependencies.fetchImpl ?? fetch);
  const target = `http://127.0.0.1:${config.port}`;
  runTailscale(["serve", "--bg", target], runner);
  console.log(`Serving the single Hosted Agents Hub privately at ${target} through Tailscale.`);
  console.log("Codeman instances remain private; no per-instance public domains were created.");
  return config;
}

export function statusHub(args = [], dependencies = {}) {
  const env = dependencies.env ?? process.env;
  const config = parseHubOptions(args, env);
  const runner = dependencies.runner ?? command;
  runTailscale(["version"], runner);
  runTailscale(["status"], runner);
  const result = runTailscale(["serve", "status"], runner);
  console.log(`Hub loopback target: http://127.0.0.1:${config.port}`);
  console.log(result.stdout?.trim() || "Tailscale Serve returned no configured routes.");
  return config;
}

export function stopHub(args = [], dependencies = {}) {
  const env = dependencies.env ?? process.env;
  const config = parseHubOptions(args, env);
  const runner = dependencies.runner ?? command;
  runTailscale(["version"], runner);
  runTailscale(["serve", "reset"], runner);
  console.log("Tailscale Serve routes reset; the Hosted Agents Hub is no longer served.");
  return config;
}

function wslCanRun(args = ["-e", "true"]) {
  const probe = args.length === 2 && args[0] === "-e" && args[1] === "true"
    ? ["-e", "bash", "-lc", "printf hosted-agents-wsl-ready"]
    : args;
  const result = process.platform === "win32"
    ? command("wsl.exe", ["-d", wslDistro, ...probe], { timeout: 5000, shell: false })
    : undefined;
  return result?.status === 0 && (
    args.length === 2
      ? result.stdout?.includes("hosted-agents-wsl-ready") === true
      : Boolean(result.stdout?.trim())
  );
}

function detectEnvironment() {
  const windows = process.platform === "win32";
  const wsl = Boolean(process.env.WSL_DISTRO_NAME) || wslCanRun();
  const inWsl = Boolean(process.env.WSL_DISTRO_NAME);
  const codemanLocal = canRun("codeman") || canRun("aicodeman");
  const codemanWsl = !inWsl && wsl && wslCanRun(["-e", "bash", "-lc", "command -v codeman"]);
  const cursorLocal = canRun("agent") || canRun("cursor-agent");
  const cursorWsl = !inWsl && wsl && wslCanRun(["-e", "bash", "-lc", "command -v agent || command -v cursor-agent"]);
  return {
    platform: process.platform === "darwin" ? "macos" : windows ? "windows" : "linux",
    wsl,
    inWsl,
    execution: windows && wsl && !inWsl ? "wsl" : "local",
    node: true,
    git: canRun("git"),
    codeman: codemanLocal || codemanWsl,
    codemanLocal,
    codemanWsl,
    cursorCli: cursorLocal || cursorWsl,
    tmux: canRun("tmux") || (wsl && wslCanRun(["-e", "bash", "-lc", "command -v tmux"])),
    docker: canRun("docker"),
    claudeCli: canRun("claude") || (wsl && wslCanRun(["-e", "bash", "-lc", "command -v claude"])),
  };
}

function printEnvironment(environment) {
  console.log(`Platform: ${environment.platform}${environment.inWsl ? " (WSL)" : ""}`);
  console.log(`Execution target: ${environment.execution}`);
  for (const [name, value] of Object.entries(environment)) {
    if (["platform", "execution", "inWsl", "codemanLocal", "codemanWsl"].includes(name)) continue;
    console.log(`  ${value ? "[ok]" : "[--]"} ${name}`);
  }
}

async function ask(question, defaultValue = "") {
  const answer = await readline().question(`${question}${defaultValue ? ` [${defaultValue}]` : ""}: `);
  return answer.trim() || defaultValue;
}

let rl;

function readline() {
  return rl ??= createInterface({ input: process.stdin, output: process.stdout });
}

async function confirm(question, defaultValue = false) {
  const answer = (await ask(`${question} ${defaultValue ? "[Y/n]" : "[y/N]"}`)).toLowerCase();
  return answer ? answer === "y" || answer === "yes" : defaultValue;
}

function listDirectories(root) {
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
      .map((entry) => join(root, entry.name))
      .slice(0, 30);
  } catch {
    return [];
  }
}

async function selectFolders() {
  const cwd = process.cwd();
  const choices = listDirectories(cwd);
  console.log(`\nWorkspace roots (current directory: ${cwd})`);
  choices.forEach((choice, index) => console.log(`  ${index + 1}. ${choice}`));
  console.log("  Type paths separated by ';', or press Enter for the current directory.");
  const answer = await ask("Approved folder roots", cwd);
  if (answer === "*") return { mode: "system", roots: [] };

  const selected = answer
    .split(";")
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => {
      const numeric = Number(value);
      return Number.isInteger(numeric) && numeric >= 1 && numeric <= choices.length
        ? choices[numeric - 1]
        : resolve(value);
    });
  return { mode: "folders", roots: [...new Set(selected)] };
}

async function selectOption(label, options) {
  if (options.length === 0) throw new Error(`No ${label} available`);
  console.log(`\n${label}`);
  options.forEach((option, index) => console.log(`  ${index + 1}. ${option.label}`));
  const answer = await ask(`Select ${label.toLowerCase()}`, "1");
  const index = Number(answer) - 1;
  if (!Number.isInteger(index) || !options[index]) throw new Error(`Invalid ${label} selection`);
  return options[index].value;
}

export function discoverWorkspaces(policy, codemanReady, cursorReady = false, claudeReady = false) {
  const roots = policy.mode === "system" ? [process.cwd()] : policy.roots;
  const paths = new Set();
  for (const root of roots) {
    paths.add(resolve(root));
    for (const child of listDirectories(root)) paths.add(resolve(child));
  }
  return [...paths].map((canonicalPath) => ({
    id: `ws_${createHash("sha256").update(canonicalPath).digest("hex").slice(0, 20)}`,
    name: canonicalPath.split(/[\\/]/).filter(Boolean).at(-1) ?? "workspace",
    canonicalPath,
    health: "ready",
    providers: {
      codeman: codemanReady ? "ready" : "missing",
      cursor: cursorReady ? "ready" : "missing",
      claude: claudeReady ? "ready" : "missing",
    },
  }));
}

async function installCodeman(environment) {
  if (environment.platform === "windows" && !environment.wsl) {
    console.log("WSL is required for Codeman on Windows. Install it from an elevated PowerShell:");
    console.log("  wsl --install");
    return false;
  }
  const ok = await confirm("Install Codeman using its official installer?", true);
  if (!ok) return false;

  const args = environment.execution === "wsl"
    ? ["-d", wslDistro, "-e", "bash", "-lc", "curl -fsSL https://getcodeman.com/install | bash"]
    : ["-lc", "curl -fsSL https://getcodeman.com/install | bash"];
  const result = command(environment.execution === "wsl" ? "wsl.exe" : "bash", args, {
    timeout: 10 * 60 * 1000,
    capture: false,
    shell: environment.execution !== "wsl",
  });
  return result.status === 0;
}

async function installCursorCli(environment) {
  if (environment.platform === "windows" && !environment.wsl) {
    console.log("Cursor Agent CLI requires WSL on Windows. Install WSL first, then rerun setup.");
    return false;
  }
  const ok = await confirm("Install the official Cursor Agent CLI?", true);
  if (!ok) return false;

  const args = environment.execution === "wsl"
    ? ["-d", wslDistro, "-e", "bash", "-lc", "curl https://cursor.com/install -fsS | bash"]
    : ["-lc", "curl https://cursor.com/install -fsS | bash"];
  const result = command(environment.execution === "wsl" ? "wsl.exe" : "bash", args, {
    timeout: 10 * 60 * 1000,
    capture: false,
    shell: environment.execution !== "wsl",
  });
  return result.status === 0;
}

function startCodeman(environment) {
  const args = environment.execution === "wsl"
    ? ["-d", wslDistro, "-e", "bash", "-lc", "codeman web -d"]
    : ["-lc", "codeman web -d"];
  const result = command(environment.execution === "wsl" ? "wsl.exe" : "bash", args, {
    timeout: 30_000,
    capture: false,
    shell: environment.execution !== "wsl",
  });
  return result.status === 0;
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\"'\"'")}'`;
}

function toWslPath(value) {
  const match = value.match(/^([A-Za-z]):[\\/](.*)$/);
  return match ? `/mnt/${match[1].toLowerCase()}/${match[2].replaceAll("\\", "/")}` : value;
}

function workerEnvironment(config) {
  const workspaces = config.execution === "wsl"
    ? config.workspaces.map((workspace) => ({ ...workspace, canonicalPath: toWslPath(workspace.canonicalPath) }))
    : config.workspaces;
  const roots = config.execution === "wsl"
    ? config.workspacePolicy.roots.map(toWslPath)
    : config.workspacePolicy.roots;
  return {
    HOSTED_AGENTS_NODE_ID: config.nodeId,
    HOSTED_AGENTS_NODE_NAME: config.name,
    HOSTED_AGENTS_CONTROLLER_URL: config.controllerUrl,
    HOSTED_AGENTS_AUTH_TOKEN: config.authToken ?? "",
    HOSTED_AGENTS_WORKSPACE_MODE: config.workspacePolicy.mode,
    HOSTED_AGENTS_WORKSPACE_ROOTS: roots.join(";"),
    HOSTED_AGENTS_WORKSPACES: JSON.stringify(workspaces),
    HOSTED_AGENTS_CODEMAN_MODE: config.codemanMode,
    CODEMAN_INSTANCE_ID: config.codemanInstanceId ?? config.nodeId,
    CODEMAN_URL: config.codemanUrl,
  };
}

function runWorker(config) {
  const env = workerEnvironment(config);
  const packagedWorker = join(runtimeRoot, "runtime/worker.mjs");
  const workerScript = existsSync(packagedWorker)
    ? packagedWorker
    : join(repoRoot, "apps/node-agent/src/main.ts");
  if (config.execution !== "wsl") {
    return spawn(
      process.execPath,
      [workerScript.endsWith(".ts") ? "--experimental-strip-types" : "", workerScript].filter(Boolean),
      {
      cwd: runtimeRoot,
      env: { ...process.env, ...env },
      stdio: "inherit",
      },
    );
  }

  const commandLine = [
    `cd ${shellQuote(toWslPath(runtimeRoot))}`,
    ...Object.entries(env).map(([key, value]) => `${key}=${shellQuote(value)}`),
    `exec node ${workerScript.endsWith(".ts") ? "--experimental-strip-types " : ""}${shellQuote(toWslPath(workerScript))}`,
  ].join(" && ");
  return spawn("wsl.exe", ["-d", wslDistro, "-e", "bash", "-lc", commandLine], {
    cwd: runtimeRoot,
    stdio: "inherit",
  });
}

async function setup() {
  const environment = detectEnvironment();
  console.log("Hosted Agents setup\n===================\n");
  printEnvironment(environment);
  if (!environment.node || !environment.git) throw new Error("Node.js and Git are required");

  if (!environment.codeman) {
    const installed = await installCodeman(environment);
    if (installed) environment.codeman = true;
  }
  if (!environment.codeman) {
    console.log("Codeman is not ready. Install it before starting the Worker.");
  }
  if (!environment.cursorCli) {
    const installed = await installCursorCli(environment);
    if (installed) environment.cursorCli = true;
  }

  const controllerUrl = await ask("\nController URL", "http://127.0.0.1:8787");
  const nodeId = await ask("Worker ID", hostname().toLowerCase().replaceAll(/[^a-z0-9-]/g, "-"));
  const name = await ask("Worker display name", hostname());
  const workspacePolicy = await selectFolders();
  const codemanMode = await ask(`Codeman mode (${modes.join(", ")})`, "claude");
  if (!modes.includes(codemanMode)) throw new Error(`Unsupported Codeman mode: ${codemanMode}`);
  const codemanUrl = await ask("Codeman URL", "http://127.0.0.1:3000");
  const authToken = process.env.HOSTED_AGENTS_AUTH_TOKEN;
  const config = {
    nodeId,
    name,
    controllerUrl,
    authToken,
    execution: environment.execution,
    workspacePolicy,
    workspaces: discoverWorkspaces(
      workspacePolicy,
      environment.codeman,
      environment.cursorCli,
      environment.claudeCli,
    ),
    codemanMode,
    codemanUrl,
  };

  mkdirSync(dirname(configPath), { recursive: true });
  writeSafeJson(configPath, config);
  console.log(`\nSaved Worker configuration: ${configPath}`);
  console.log(`Discovered ${config.workspaces.length} workspace(s).`);

  if (environment.codeman && await confirm("Start Codeman now?", true)) {
    if (!startCodeman(environment)) console.log("Codeman did not start; run `codeman web` manually.");
  }
  if (process.argv.includes("--run")) {
    if (!environment.codeman) throw new Error("Cannot run Worker without Codeman");
    runWorker(config);
  } else {
    console.log("Run `hosted-agents run` to start the real Worker.");
  }
}

function writeSafeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.tmp`;
  const serialized = `${JSON.stringify(value, null, 2)}\n`;
  writeFileSync(temporaryPath, serialized, { mode: 0o600 });
  try {
    renameSync(temporaryPath, path);
  } catch {
    writeFileSync(path, serialized, { mode: 0o600 });
    try {
      unlinkSync(temporaryPath);
    } catch {
      // Best-effort cleanup only.
    }
  }
  chmodSync(path, 0o600);
}

export function parseOptions(args) {
  const values = new Map();
  const positionals = [];
  const booleans = new Set(["help", "no-health"]);
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (!argument.startsWith("--")) {
      positionals.push(argument);
      continue;
    }
    const equals = argument.indexOf("=");
    const name = (equals < 0 ? argument.slice(2) : argument.slice(2, equals)).trim();
    const inlineValue = equals < 0 ? undefined : argument.slice(equals + 1);
    if (!name) throw new Error("Invalid empty option");
    let value = inlineValue;
    if (value === undefined && !booleans.has(name)) {
      value = args[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`Option --${name} requires a value`);
      index += 1;
    }
    const entries = values.get(name) ?? [];
    entries.push(value ?? "true");
    values.set(name, entries);
  }
  return { positionals, values };
}

function optionValues(parsed, ...names) {
  return names.flatMap((name) => parsed.values.get(name) ?? []);
}

function optionValue(parsed, ...names) {
  return optionValues(parsed, ...names).at(-1);
}

function assertNonEmpty(value, field) {
  const result = value?.trim();
  if (!result) throw new Error(`${field} is required`);
  return result;
}

export function safeEndpoint(value, field, tailscale = false) {
  const endpoint = assertNonEmpty(value, field);
  let parsed;
  try {
    parsed = new URL(endpoint);
  } catch {
    throw new Error(`${field} must be a valid URL`);
  }
  if (parsed.username || parsed.password) {
    throw new Error(`${field} must not contain embedded credentials`);
  }
  const loopback = ["localhost", "127.0.0.1", "::1", "[::1]"].includes(parsed.hostname);
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && loopback)) {
    throw new Error(`${field} must use HTTPS, or HTTP on loopback for local development`);
  }
  if (tailscale && parsed.protocol !== "https:") {
    throw new Error(`${field} must use HTTPS in tailscale-url mode`);
  }
  if (tailscale && !isTailnetHostname(parsed.hostname)) {
    throw new Error(`${field} must use a *.ts.net or Tailscale 100.64.0.0/10 hostname`);
  }
  return parsed.toString().replace(/\/+$/, "");
}

function isTailnetHostname(hostname) {
  if (hostname.endsWith(".ts.net") || hostname.endsWith(".ts.net.")) return true;
  const parts = hostname.split(".");
  if (parts.length !== 4 || parts.some((part) => !/^\d+$/.test(part))) return false;
  const [first, second] = parts.map(Number);
  return first === 100 && second >= 64 && second <= 127;
}

export function workspacePolicyFromOptions(parsed) {
  const mode = optionValue(parsed, "workspace-mode") ?? "folders";
  if (mode !== "folders" && mode !== "system") {
    throw new Error("--workspace-mode must be folders or system");
  }
  const roots = optionValues(parsed, "workspace-root", "workspace-roots")
    .flatMap((value) => value.split(";"))
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => resolve(value));
  if (mode === "folders" && roots.length === 0) {
    throw new Error("At least one --workspace-root is required in folders mode");
  }
  return { mode, roots: [...new Set(roots)] };
}

function profileForMode(mode, name = mode, id = mode, ready = true) {
  if (!modes.includes(mode)) throw new Error(`Unsupported agent mode: ${mode}`);
  return { id: assertNonEmpty(id, "agent profile id"), name: assertNonEmpty(name, "agent profile name"), mode, ready };
}

export function parseAgentProfiles(parsed) {
  const profiles = [];
  for (const value of optionValues(parsed, "agent-mode")) {
    for (const mode of value.split(",").map((entry) => entry.trim()).filter(Boolean)) {
      profiles.push(profileForMode(mode, defaultAgentNames[mode] ?? mode));
    }
  }
  for (const value of optionValues(parsed, "agent-profile")) {
    const [id, name, mode, ready = "true"] = value.split(":");
    profiles.push(profileForMode(
      assertNonEmpty(mode, "agent profile mode"),
      name ?? id,
      id,
      ready !== "false",
    ));
  }
  return profiles.length > 0 ? profiles : undefined;
}

function parseCapabilities(parsed) {
  const values = optionValues(parsed, "capability").flatMap((value) => value.split(","));
  const capabilities = values.map((value) => value.trim()).filter(Boolean);
  return [...new Set(capabilities.length > 0 ? capabilities : ["codeman"])];
}

async function jsonRequest(url, options, label) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const text = await response.text();
    let body = {};
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = { error: text };
      }
    }
    return { response, body };
  } catch (error) {
    if (error?.name === "AbortError") throw new Error(`${label} timed out after 20 seconds`);
    throw new Error(`${label} failed: ${error instanceof Error ? error.message : "network error"}`);
  } finally {
    clearTimeout(timeout);
  }
}

function authHeaders() {
  const token = process.env.HOSTED_AGENTS_AUTH_TOKEN?.trim();
  return token ? { authorization: `Bearer ${token}` } : {};
}

function controllerError(body, response) {
  return typeof body?.error === "string"
    ? body.error
    : `HTTP ${response.status}`;
}

function loadSavedInstances() {
  try {
    const value = JSON.parse(readFileSync(instancesConfigPath, "utf8"));
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

function saveInstanceRegistration(registration) {
  const instances = loadSavedInstances().filter((instance) => instance.id !== registration.id);
  const { credentials: _credentials, ...safeRegistration } = registration;
  instances.push({
    ...safeRegistration,
    savedAt: new Date().toISOString(),
  });
  writeSafeJson(instancesConfigPath, instances);
}

function linkWorkerInstance(nodeId, instanceId) {
  try {
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    if (config.nodeId !== nodeId) return false;
    config.codemanInstanceId = instanceId;
    writeSafeJson(configPath, config);
    return true;
  } catch {
    return false;
  }
}

function printHealth(instance, mode) {
  if (instance.status !== "online") {
    const hint = mode === "connector"
      ? `Start the Worker for node ${instance.nodeId ?? "configured in the registration"} and retry health verification.`
      : "Confirm the Tailscale URL is reachable and Codeman is running.";
    throw new Error(`Health verification returned ${instance.status}. ${hint}`);
  }
  console.log(`Health verified: ${instance.label} is online.`);
  console.log(`  workspaces: ${instance.workspaces?.length ?? 0}`);
  console.log(`  agents: ${instance.agents?.length ?? 0}`);
}

export async function enrollInstance(argv = process.argv.slice(3)) {
  const parsed = parseOptions(argv);
  if (parsed.values.has("help")) {
    printEnrollmentHelp();
    return;
  }
  const selectedMode = optionValue(parsed, "mode") ?? parsed.positionals[0]
    ?? await ask("Connection mode (connector or tailscale-url)", "connector");
  if (selectedMode !== "connector" && selectedMode !== "tailscale-url") {
    throw new Error("--mode must be connector or tailscale-url");
  }

  const controllerUrl = safeEndpoint(
    optionValue(parsed, "controller-url", "controller")
      ?? process.env.HOSTED_AGENTS_CONTROLLER_URL
      ?? await ask("Controller URL", "http://127.0.0.1:8787"),
    "Controller URL",
  );
  const id = assertNonEmpty(
    optionValue(parsed, "instance-id", "id") ?? await ask("Codeman instance ID"),
    "Instance ID",
  );
  const label = assertNonEmpty(
    optionValue(parsed, "name", "label") ?? await ask("Codeman instance name", id),
    "Instance name",
  );
  const codemanUsername = optionValue(parsed, "username")
    ?? process.env.HOSTED_AGENTS_CODEMAN_USERNAME;
  const codemanPassword = optionValue(parsed, "password")
    ?? process.env.HOSTED_AGENTS_CODEMAN_PASSWORD;
  if (
    selectedMode !== "tailscale-url"
    && (codemanUsername !== undefined || codemanPassword !== undefined)
  ) {
    throw new Error("Codeman credentials are only supported for tailscale-url mode");
  }
  if (
    selectedMode === "tailscale-url"
    && ((codemanUsername === undefined) !== (codemanPassword === undefined))
  ) {
    throw new Error("--username and --password must be provided together");
  }
  const agents = parseAgentProfiles(parsed);
  const workspaceOptions = optionValues(
    parsed,
    "workspace-mode",
    "workspace-root",
    "workspace-roots",
  );
  const registration = {
    id,
    label,
    connectionMode: selectedMode,
    ...(selectedMode === "connector"
      ? {
          nodeId: assertNonEmpty(
            optionValue(parsed, "node-id", "worker-id")
              ?? process.env.HOSTED_AGENTS_NODE_ID
              ?? await ask("Enrolled Worker node ID"),
            "Worker node ID",
          ),
        }
      : {
          endpoint: safeEndpoint(
            optionValue(parsed, "url", "endpoint", "tailscale-url")
              ?? await ask("Tailscale Codeman URL"),
            "Tailscale Codeman URL",
            true,
          ),
        }),
    capabilities: parseCapabilities(parsed),
    ...(agents ? { agents } : {}),
    ...(selectedMode === "connector" || workspaceOptions.length > 0
      ? {
          workspacePolicy: selectedMode === "connector" && workspaceOptions.length === 0
            ? await selectFolders()
            : workspacePolicyFromOptions(parsed),
        }
      : {}),
    ...(selectedMode === "tailscale-url" && codemanUsername !== undefined
      ? {
          credentials: {
            username: codemanUsername,
            password: codemanPassword ?? "",
          },
        }
      : {}),
  };
  const headers = { ...authHeaders(), accept: "application/json", "content-type": "application/json" };
  const registered = await jsonRequest(`${controllerUrl}/api/instances`, {
    method: "POST",
    headers,
    body: JSON.stringify(registration),
  }, "Instance registration");
  if (!registered.response.ok) {
    throw new Error(`Instance registration failed: ${controllerError(registered.body, registered.response)}`);
  }
  const instance = registered.body?.instance;
  if (!instance) throw new Error("Instance registration returned no instance");
  saveInstanceRegistration(registration);
  const linked = selectedMode === "connector" ? linkWorkerInstance(registration.nodeId, registration.id) : false;
  console.log(`Registered Codeman instance ${registration.label} (${registration.id}) in ${selectedMode} mode.`);
  if (linked) {
    console.log(`Updated Worker configuration with CODEMAN_INSTANCE_ID=${registration.id}. Restart the Worker to apply it.`);
  }
  if (parsed.values.has("no-health")) {
    console.log("Health verification skipped by --no-health.");
    return instance;
  }

  const health = await jsonRequest(
    `${controllerUrl}/api/instances/${encodeURIComponent(registration.id)}/health`,
    { method: "POST", headers: { ...authHeaders(), accept: "application/json" } },
    "Instance health verification",
  );
  if (!health.response.ok) {
    const hint = selectedMode === "connector"
      ? "The Worker must be online and configured with the same CODEMAN_INSTANCE_ID."
      : "The Tailscale URL must be reachable and expose Codeman's /api/v1/status endpoint.";
    throw new Error(
      `Instance registered, but health verification failed: ${controllerError(health.body, health.response)}. ${hint}`,
    );
  }
  if (!health.body?.instance) throw new Error("Health verification returned no instance");
  printHealth(health.body?.instance, selectedMode);
  return health.body.instance;
}

function printEnrollmentHelp() {
  console.log([
    "Register a Codeman instance with the Controller.",
    "",
    "Usage:",
    "  hosted-agents enroll [connector|tailscale-url] [options]",
    "",
    "Options:",
    "  --mode <connector|tailscale-url>",
    "  --instance-id <id> --name <name>",
    "  --node-id <enrolled-worker-id>             connector mode",
    "  --url <https-url>                          tailscale-url mode",
    "  --username <name> --password <secret>      direct Codeman auth",
    "  --workspace-mode <folders|system>",
    "  --workspace-root <path>                   repeatable; use ';' to separate",
    "  --agent-mode <mode[,mode...]>              repeatable",
    "  --agent-profile <id:name:mode[:ready]>     repeatable",
    "  --capability <name[,name...]>              repeatable",
    "  --no-health                                register without verification",
    "",
    "Credentials are read from HOSTED_AGENTS_AUTH_TOKEN and are never saved in the instance file.",
  ].join("\n"));
}

function printHubHelp() {
  console.log([
    "Serve the single Hosted Agents Hub privately through Tailscale Serve.",
    "",
    "Usage:",
    "  hosted-agents hub serve [--port <1-65535>]",
    "  hosted-agents hub status [--port <1-65535>]",
    "  hosted-agents hub stop  [--port <1-65535>]",
    "",
    "The Controller must already be running on 127.0.0.1 (default port 8787).",
    "Serve uses one tailnet origin for the Hub and never publishes Codeman instances.",
  ].join("\n"));
}

async function hubCommand(args) {
  const action = args[0] ?? "help";
  if (action === "help" || args.includes("--help")) {
    printHubHelp();
    return;
  }
  if (action === "serve") {
    await serveHub(args.slice(1));
    return;
  }
  if (action === "status") {
    statusHub(args.slice(1));
    return;
  }
  if (action === "stop") {
    stopHub(args.slice(1));
    return;
  }
  throw new Error(`Unknown Hub command: ${action}`);
}

function runSavedWorker() {
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  runWorker(config);
}

function workerServicePaths() {
  if (process.platform === "linux") {
    return {
      kind: "systemd",
      path: join(homedir(), ".config", "systemd", "user", "hosted-agents-worker.service"),
      name: "hosted-agents-worker.service",
    };
  }
  if (process.platform === "darwin") {
    return {
      kind: "launchd",
      path: join(homedir(), "Library", "LaunchAgents", "com.hosted-agents.worker.plist"),
      name: "com.hosted-agents.worker",
    };
  }
  return { kind: "schtasks", path: null, name: "Hosted Agents Worker" };
}

function workerServiceCommand() {
  return [process.execPath, fileURLToPath(import.meta.url), "run"];
}

function installWorkerService() {
  if (!existsSync(configPath)) throw new Error(`Worker configuration not found: ${configPath}`);
  const service = workerServicePaths();
  const [executable, script, action] = workerServiceCommand();
  if (service.kind === "systemd") {
    mkdirSync(dirname(service.path), { recursive: true });
    writeFileSync(service.path, [
      "[Unit]",
      "Description=Hosted Agents Worker",
      "After=network-online.target",
      "",
      "[Service]",
      `ExecStart=${shellQuote(executable)} ${shellQuote(script)} ${action}`,
      "Restart=on-failure",
      "RestartSec=5",
      "",
      "[Install]",
      "WantedBy=default.target",
      "",
    ].join("\n"), { mode: 0o600 });
    command("systemctl", ["--user", "daemon-reload"], { capture: false });
    runServiceCommand(service, "enable");
    runServiceCommand(service, "start");
  } else if (service.kind === "launchd") {
    mkdirSync(dirname(service.path), { recursive: true });
    const xml = (value) => String(value)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;");
    writeFileSync(service.path, [
      "<?xml version=\"1.0\" encoding=\"UTF-8\"?>",
      "<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">",
      "<plist version=\"1.0\"><dict>",
      "<key>Label</key><string>com.hosted-agents.worker</string>",
      `<key>ProgramArguments</key><array><string>${xml(executable)}</string><string>${xml(script)}</string><string>${action}</string></array>`,
      "<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>",
      "</dict></plist>",
      "",
    ].join("\n"), { mode: 0o600 });
    runServiceCommand(service, "load");
  } else {
    const taskCommand = `"${executable.replaceAll('"', '""')}" "${script.replaceAll('"', '""')}" ${action}`;
    runServiceCommand(service, "create", taskCommand);
  }
  console.log(`Installed user-level Worker service: ${service.name}`);
}

function runServiceCommand(service, action, extra) {
  if (service.kind === "systemd") {
    const result = command("systemctl", ["--user", action, service.name], { capture: false });
    if (result.status !== 0) throw new Error(`systemd ${action} failed`);
    return;
  }
  if (service.kind === "launchd") {
    const result = command("launchctl", [action, service.path], { capture: false });
    if (result.status !== 0) throw new Error(`launchd ${action} failed`);
    return;
  }
  const args = action === "create"
    ? ["/Create", "/TN", service.name, "/TR", extra, "/SC", "ONLOGON", "/RL", "LIMITED", "/F"]
    : action === "delete"
      ? ["/Delete", "/TN", service.name, "/F"]
      : ["/" + action[0].toUpperCase() + action.slice(1), "/TN", service.name];
  const result = command("schtasks.exe", args, { capture: false });
  if (result.status !== 0) throw new Error(`Task Scheduler ${action} failed`);
}

function workerServiceAction(action) {
  const service = workerServicePaths();
  if (action === "install") {
    installWorkerService();
    return;
  }
  if (service.kind === "systemd") {
    runServiceCommand(service, action);
  } else if (service.kind === "launchd") {
    if (action === "stop") runServiceCommand(service, "unload");
    else if (action === "start") runServiceCommand(service, "load");
    else if (action === "remove") runServiceCommand(service, "unload");
    else runServiceCommand(service, "list");
  } else if (action === "remove") {
    runServiceCommand(service, "delete");
  } else {
    runServiceCommand(service, action);
  }
  if (action === "remove" && service.path && existsSync(service.path)) unlinkSync(service.path);
  console.log(`Worker service ${action} complete.`);
}

async function startJob() {
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  const headers = {
    accept: "application/json",
    "content-type": "application/json",
    ...(config.authToken
      ? { authorization: `Bearer ${config.authToken}` }
      : process.env.HOSTED_AGENTS_AUTH_TOKEN
        ? { authorization: `Bearer ${process.env.HOSTED_AGENTS_AUTH_TOKEN}` }
        : {}),
  };
  const baseUrl = config.controllerUrl.replace(/\/+$/, "");
  const workersResponse = await fetch(`${baseUrl}/api/workers`, { headers });
  if (!workersResponse.ok) throw new Error(`Controller worker list failed with HTTP ${workersResponse.status}`);
  const workersBody = await workersResponse.json();
  const workers = (workersBody.workers ?? []).filter((worker) => worker.status === "online");
  const nodeId = await selectOption(
    "Online Workers",
    workers.map((worker) => ({ label: `${worker.name} (${worker.id})`, value: worker })),
  );
  const workspaceId = await selectOption(
    "Workspaces",
    nodeId.workspaces
      .filter((workspace) => workspace.health === "ready")
      .map((workspace) => ({ label: `${workspace.name} — ${workspace.canonicalPath}`, value: workspace })),
  );
  const provider = await selectOption(
    "Agents",
    Object.entries(workspaceId.providers)
      .filter(([, readiness]) => readiness === "ready")
      .map(([value]) => ({ label: value, value })),
  );
  const prompt = await ask("Prompt");
  if (!prompt) throw new Error("Prompt is required");

  const response = await fetch(`${baseUrl}/api/jobs`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      provider,
      nodeId: nodeId.id,
      workspaceId: workspaceId.id,
      prompt,
      idempotencyKey: randomUUID(),
    }),
  });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error ?? `Job creation failed with HTTP ${response.status}`);
  console.log(`Started job ${body.job.id} on ${nodeId.name} / ${workspaceId.name} using ${provider}.`);
}

function help() {
  console.log([
    "Cloud Agent Fleet CLI",
    "",
    "Usage:",
    "  cloudagentfleet setup [--run]  Detect, select, configure, and optionally run",
    "  cloudagentfleet run              Run the saved Codeman-backed Worker",
    "  cloudagentfleet worker <install|start|status|stop|remove>  Manage the user service",
    "  cloudagentfleet start            Select Worker, workspace, agent, and prompt",
    "  cloudagentfleet enroll           Register a Codeman instance and verify health",
    "  cloudagentfleet hub <serve|status|stop>  Manage private Tailscale Hub serving",
    "  cloudagentfleet doctor           Print local prerequisites",
    "",
    "Compatibility alias: hosted-agents",
    "The setup flow asks before installing Codeman and never performs provider login.",
  ].join("\n"));
}

if (
  process.argv[1]
  && (
    resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
    || process.argv[1].endsWith("hosted-agents.mjs")
  )
) {
  try {
    const commandName = process.argv[2] ?? "help";
    if (commandName === "setup") await setup();
    else if (commandName === "run") runSavedWorker();
    else if (commandName === "worker") workerServiceAction(process.argv[3] ?? "status");
    else if (commandName === "doctor" || commandName === "check") printEnvironment(detectEnvironment());
    else if (commandName === "start") await startJob();
    else if (commandName === "enroll" || commandName === "register") await enrollInstance();
    else if (commandName === "hub") await hubCommand(process.argv.slice(3));
    else help();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  } finally {
    rl?.close();
  }
}
