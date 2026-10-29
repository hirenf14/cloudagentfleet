import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, hostname } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

const thisFile = fileURLToPath(import.meta.url);
const thisDir = dirname(thisFile);
const configPath = join(homedir(), ".cloudagentfleet", "worker.json");
const instancesConfigPath = join(homedir(), ".cloudagentfleet", "instances.json");
/** Backends the Hub registry knows; keep in sync with packages/host-adapters. */
const backends = ["codeman", "cptr"];
const modes = ["claude", "shell", "opencode", "codex", "gemini", "antigravity", "pi", "grok", "deepseek"];
const defaultAgentNames = { claude: "Claude Code" };
const tailscaleCommand = process.platform === "win32" ? "tailscale.exe" : "tailscale";
const loopbackHosts = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
const wslDistro = process.env.CLOUDAGENTFLEET_WSL_DISTRO?.trim() || "Ubuntu";

function resolveWorkerScript() {
  const candidates = [
    // npm / built package: sibling CLI bundle next to cloudagentfleet.mjs
    join(thisDir, "cloudagentfleet-worker.mjs"),
    // monorepo checkout without a release build
    join(thisDir, "..", "..", "node-agent", "src", "main.ts"),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(
    "Unable to locate the Worker runtime. Install @cloudagentfleet/worker from npm, "
    + "or run pnpm build:release in a checkout.",
  );
}


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
  const host = optionValue(parsed, "host") ?? env.CLOUDAGENTFLEET_HOST ?? "127.0.0.1";
  const rawPort = optionValue(parsed, "port") ?? env.CLOUDAGENTFLEET_PORT ?? "8787";
  if (!/^\d+$/.test(rawPort)) throw new Error("Hub port must be a number between 1 and 65535");
  const port = Number(rawPort);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
    throw new Error("Hub port must be a number between 1 and 65535");
  }
  if (!loopbackHosts.has(host.toLowerCase())) {
    throw new Error(
      `Hub private serving requires a loopback bind address; got "${host}". `
      + "Set CLOUDAGENTFLEET_HOST=127.0.0.1 and restart the Controller.",
    );
  }
  const rawHostPort = optionValue(parsed, "host-port") ?? env.CLOUDAGENTFLEET_HOST_PORT ?? String(port + 1);
  const hostPort = Number(rawHostPort);
  if (!/^\d+$/.test(rawHostPort) || !Number.isSafeInteger(hostPort) || hostPort < 1 || hostPort > 65535) {
    throw new Error("Host UI port must be a number between 1 and 65535");
  }
  return { host, port, hostPort };
}

/** Tailscale Serve HTTPS ports: the dashboard on 443, proxied host UIs on their own origin. */
const hubServePort = 443;
const hostUiServePort = 8443;

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
  await checkLocalHub(config.port, env.CLOUDAGENTFLEET_AUTH_TOKEN, dependencies.fetchImpl ?? fetch);
  const target = `http://127.0.0.1:${config.port}`;
  runTailscale(["serve", "--bg", target], runner);
  runTailscale(["serve", "--bg", `--https=${hostUiServePort}`, `http://127.0.0.1:${config.hostPort}`], runner);
  console.log(`Serving the Cloud Agent Fleet Hub privately at ${target} through Tailscale (https port ${hubServePort}).`);
  console.log(`Host UIs are served on their own origin (https port ${hostUiServePort}); grant operators both ports.`);
  console.log("Backend instances remain private; no per-instance public domains were created.");
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
  console.log(`Host UI loopback target: http://127.0.0.1:${config.hostPort}`);
  console.log(result.stdout?.trim() || "Tailscale Serve returned no configured routes.");
  return config;
}

export function stopHub(args = [], dependencies = {}) {
  const env = dependencies.env ?? process.env;
  const config = parseHubOptions(args, env);
  const runner = dependencies.runner ?? command;
  runTailscale(["version"], runner);
  // Remove only the Hub's own routes; other Serve routes on this node (for
  // example a published Open WebUI Computer) are left alone.
  runTailscale(["serve", `--https=${hubServePort}`, "off"], runner);
  runTailscale(["serve", `--https=${hostUiServePort}`, "off"], runner);
  console.log("The Cloud Agent Fleet Hub is no longer served through Tailscale.");
  return config;
}

function wslCanRun(args = ["-e", "true"]) {
  const probe = args.length === 2 && args[0] === "-e" && args[1] === "true"
    ? ["-e", "bash", "-lc", "printf cloudagentfleet-wsl-ready"]
    : args;
  const result = process.platform === "win32"
    ? command("wsl.exe", ["-d", wslDistro, ...probe], { timeout: 5000, shell: false })
    : undefined;
  return result?.status === 0 && (
    args.length === 2
      ? result.stdout?.includes("cloudagentfleet-wsl-ready") === true
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
    tmux: canRun("tmux", ["-V"]) || (wsl && wslCanRun(["-e", "bash", "-lc", "command -v tmux"])),
    docker: canRun("docker"),
    claudeCli: canRun("claude") || (wsl && wslCanRun(["-e", "bash", "-lc", "command -v claude"])),
    cptr: windows && wsl && !inWsl
      ? wslCanRun(["-e", "bash", "-lc", "command -v cptr"])
      : canRun("cptr", ["--help"]),
  };
}

/**
 * Where Open WebUI Computer runs. On Windows it runs natively by default so
 * it sees Windows folders; Codeman still needs WSL (tmux).
 */
async function chooseCptrExecution(environment) {
  if (environment.platform !== "windows" || environment.inWsl || !environment.wsl) return environment.execution;
  const place = (await ask("Run Open WebUI Computer natively on Windows or in WSL (windows, wsl)", "windows"))
    .trim()
    .toLowerCase();
  if (place !== "windows" && place !== "wsl") throw new Error("Answer windows or wsl");
  return place === "windows" ? "local" : "wsl";
}

/**
 * The Worker processes a saved config runs. A Windows machine with Codeman
 * in WSL and cptr on Windows runs two: the WSL Worker keeps the node id, and
 * a native Worker `<node>-windows` serves cptr.
 */
export function workerProcesses(config) {
  const backends = Array.isArray(config.backends) && config.backends.length > 0 ? config.backends : ["codeman"];
  const cptrExecution = config.cptrExecution ?? config.execution;
  if (!backends.includes("codeman") || !backends.includes("cptr") || cptrExecution === config.execution) {
    return [{ ...config, backends }];
  }
  const { cptrUrl: _cptrUrl, ...codemanConfig } = config;
  return [
    { ...codemanConfig, backends: ["codeman"] },
    {
      ...config,
      execution: cptrExecution,
      backends: ["cptr"],
      nodeId: `${config.nodeId}-windows`,
      name: `${config.name} (Windows)`,
      cptrInstanceId: config.cptrInstanceId ?? `${config.nodeId}-cptr`,
    },
  ];
}

/** Absolute path of cptr where it runs, since Worker services have a minimal PATH. */
function findCptrCommand(placement) {
  if (placement.execution === "wsl" || process.platform !== "win32") {
    return runWhereWorkerRuns(placement, "command -v cptr").stdout?.trim().split("\n").at(-1) || undefined;
  }
  const found = command("where.exe", ["cptr"], { shell: false }).stdout?.trim().split(/\r?\n/)[0];
  if (found) return found;
  // `pip install --user` puts cptr.exe in a Scripts folder that is often not on PATH.
  const candidates = [join(homedir(), ".local", "bin", "cptr.exe")];
  for (const python of ["py", "python3", "python"]) {
    const scripts = command(python, ["-c", "import sysconfig; print(sysconfig.get_path('scripts', 'nt_user'))"], {
      shell: false,
      timeout: 10_000,
    }).stdout?.trim();
    if (scripts) candidates.push(join(scripts, "cptr.exe"));
  }
  return candidates.find((candidate) => existsSync(candidate));
}

/** First loopback port from `start` that nothing listens on (WSL forwards its ports to Windows). */
async function freeLocalPort(start) {
  const { createServer } = await import("node:net");
  for (let port = start; port < start + 50; port += 1) {
    const free = await new Promise((resolvePort) => {
      const server = createServer();
      server.once("error", () => resolvePort(false));
      server.listen(port, "127.0.0.1", () => server.close(() => resolvePort(true)));
    });
    if (free) return port;
  }
  return start;
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

const cptrLicenseUrl = "https://github.com/open-webui/computer/blob/main/LICENSE";
const cptrTailnetPort = 8444;

/** Runs a script where the Worker runs: WSL when setup chose it, else the native shell. */
function runWhereWorkerRuns(environment, script, options = {}) {
  const runOptions = { timeout: options.timeout ?? 15_000, capture: options.capture ?? true, shell: false };
  if (environment.execution === "wsl") {
    return command("wsl.exe", ["-d", wslDistro, "-e", "bash", "-lc", script], runOptions);
  }
  if (process.platform === "win32") return command("cmd.exe", ["/d", "/s", "/c", script], runOptions);
  return command("bash", ["-lc", script], runOptions);
}

/** Prefers isolated installers (pipx, uv) over a user-level pip install. */
/**
 * Prefers isolated installers (pipx, uv) over a user-level pip install. With
 * Claude Code present, also installs claude-agent-sdk into cptr's
 * environment so cptr can use it as a chat agent.
 */
export function cptrInstallCommand(available, { withClaude = false } = {}) {
  if (available("pipx --version")) {
    return withClaude ? "pipx install cptr && pipx inject cptr claude-agent-sdk" : "pipx install cptr";
  }
  if (available("uv --version")) {
    return withClaude ? "uv tool install cptr --with claude-agent-sdk" : "uv tool install cptr";
  }
  for (const python of ["python3", "python", "py"]) {
    if (available(`${python} -m pip --version`)) {
      return `${python} -m pip install --user cptr${withClaude ? " claude-agent-sdk" : ""}`;
    }
  }
  return undefined;
}

async function installCptr(environment) {
  console.log(
    "\nOpen WebUI Computer (cptr) is third-party software under its own Open Use License:\n"
    + `  ${cptrLicenseUrl}\n`
    + "Cloud Agent Fleet does not bundle or modify it. It needs Python 3.10+.",
  );
  const installCommand = cptrInstallCommand(
    (probe) => runWhereWorkerRuns(environment, probe).status === 0,
    { withClaude: environment.claudeCli },
  );
  if (!installCommand) {
    console.log("No pipx, uv, or pip was found where the Worker runs. Install Python 3.10+ (and pipx), then rerun setup.");
    return false;
  }
  if (!await confirm(`Install Open WebUI Computer with \`${installCommand}\`?`, true)) return false;
  const result = runWhereWorkerRuns(environment, installCommand, { timeout: 10 * 60 * 1000, capture: false });
  if (result.status !== 0) return false;
  if (!findCptrCommand(environment)) {
    console.log("cptr installed but is not on PATH yet; add the installer's bin directory to PATH, then rerun setup.");
    return false;
  }
  return true;
}

/** Publishes the loopback cptr on this machine's tailnet name; returns its URL. */
function exposeCptrOnTailnet(cptrUrl) {
  const port = new URL(cptrUrl).port || "80";
  runTailscale(["serve", "--bg", `--https=${cptrTailnetPort}`, `http://127.0.0.1:${port}`]);
  const status = JSON.parse(runTailscale(["status", "--json"]).stdout || "{}");
  const dnsName = String(status?.Self?.DNSName ?? "").replace(/\.$/, "");
  if (!dnsName) throw new Error("Tailscale did not report this machine's DNS name");
  return `https://${dnsName}:${cptrTailnetPort}`;
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

export function workerEnvironment(config) {
  const workspaces = config.execution === "wsl"
    ? config.workspaces.map((workspace) => ({ ...workspace, canonicalPath: toWslPath(workspace.canonicalPath) }))
    : config.workspaces;
  const roots = config.execution === "wsl"
    ? config.workspacePolicy.roots.map(toWslPath)
    : config.workspacePolicy.roots;
  const backends = Array.isArray(config.backends) && config.backends.length > 0 ? config.backends : ["codeman"];
  const manageCodeman = backends.includes("codeman") && config.manageCodeman !== false;
  const installCodeman = manageCodeman && config.installCodeman !== false;
  return {
    CLOUDAGENTFLEET_BACKENDS: backends.join(","),
    ...(config.cptrUrl
      ? {
          CLOUDAGENTFLEET_CPTR_URL: config.cptrUrl,
          CLOUDAGENTFLEET_MANAGE_CPTR: config.manageCptr === false ? "false" : "true",
          CLOUDAGENTFLEET_CPTR_INSTANCE_ID: config.cptrInstanceId ?? `${config.nodeId}-cptr`,
          ...(config.cptrCommand ? { CLOUDAGENTFLEET_CPTR_COMMAND: config.cptrCommand } : {}),
        }
      : {}),
    CLOUDAGENTFLEET_NODE_ID: config.nodeId,
    CLOUDAGENTFLEET_NODE_NAME: config.name,
    CLOUDAGENTFLEET_CONTROLLER_URL: config.controllerUrl,
    CLOUDAGENTFLEET_AUTH_TOKEN: config.authToken ?? "",
    CLOUDAGENTFLEET_WORKSPACE_MODE: config.workspacePolicy.mode,
    CLOUDAGENTFLEET_WORKSPACE_ROOTS: roots.join(";"),
    CLOUDAGENTFLEET_WORKSPACES: JSON.stringify(workspaces),
    CLOUDAGENTFLEET_CODEMAN_MODE: config.codemanMode,
    CLOUDAGENTFLEET_MANAGE_CODEMAN: manageCodeman ? "true" : "false",
    CLOUDAGENTFLEET_CODEMAN_INSTALL: installCodeman ? "true" : "false",
    CLOUDAGENTFLEET_CODEMAN_INSTANCE_ID: config.codemanInstanceId ?? config.nodeId,
    CLOUDAGENTFLEET_CODEMAN_URL: config.codemanUrl,
  };
}

/** Starts one Worker process; with `log`, its output goes to that stream instead of ours. */
function runWorker(config, log) {
  const env = workerEnvironment(config);
  const workerScript = resolveWorkerScript();
  const runtimeRoot = dirname(workerScript);
  const stdio = log ? ["ignore", "pipe", "pipe"] : "inherit";
  const attach = (child) => {
    child.stdout?.pipe(log, { end: false });
    child.stderr?.pipe(log, { end: false });
    return child;
  };
  if (config.execution !== "wsl") {
    return attach(spawn(
      process.execPath,
      [workerScript.endsWith(".ts") ? "--experimental-strip-types" : "", workerScript].filter(Boolean),
      {
      cwd: runtimeRoot,
      env: { ...process.env, ...env },
      stdio,
      },
    ));
  }

  return attach(spawn("wsl.exe", ["-d", wslDistro, "-e", "bash", "-lc", wslWorkerCommandLine(workerScript, env)], {
    cwd: runtimeRoot,
    stdio,
  }));
}

/** The bash command that starts the Worker in WSL; its settings must be exported to reach node. */
export function wslWorkerCommandLine(workerScript, env) {
  return [
    `cd ${shellQuote(toWslPath(dirname(workerScript)))}`,
    ...Object.entries(env).map(([key, value]) => `export ${key}=${shellQuote(value)}`),
    `exec node ${workerScript.endsWith(".ts") ? "--experimental-strip-types " : ""}${shellQuote(toWslPath(workerScript))}`,
  ].join(" && ");
}

/**
 * What a machine can offer through the fleet. `init` introduces both, lets
 * the operator pick one or both, then optionally the coding agents they use.
 */
export const BACKEND_INTRO = [
  {
    id: "codeman",
    label: "Codeman",
    lines: [
      "Agent sessions in terminals. Start them from the dashboard, watch their output",
      "live, and type into them. Light, and good for running many agents side by side.",
      "(On Windows it runs in WSL.) Open source by Ark0N, MIT: github.com/Ark0N/Codeman",
    ],
  },
  {
    id: "cptr",
    label: "Open WebUI Computer",
    lines: [
      "A full workspace in the browser: files, editor, terminal, previews of running",
      "apps, and chat with coding agents. Opens inside the dashboard. By Open WebUI, Inc.,",
      "under its own license; company use falls under openwebui.com/terms.",
    ],
  },
];

export const AGENT_CHOICES = [
  { id: "claude", label: "Claude Code CLI", what: "Anthropic's coding agent" },
  { id: "cursor", label: "Cursor Agent CLI", what: "Cursor's coding agent" },
];

/** "1", "2", "3"/"both", or names: one or both backends. */
export function parseBackendChoice(value) {
  const choice = String(value).trim().toLowerCase();
  if (["1", "codeman"].includes(choice)) return ["codeman"];
  if (["2", "cptr", "open webui computer", "computer"].includes(choice)) return ["cptr"];
  if (["3", "both", "codeman,cptr", "cptr,codeman", "codeman, cptr"].includes(choice)) return ["codeman", "cptr"];
  throw new Error("Answer 1 (Codeman), 2 (Open WebUI Computer), or 3 (both).");
}

/** Optional coding agents: numbers or names, or empty / "none". */
export function parseAgentPicks(value) {
  const picks = new Set();
  for (const raw of String(value).split(/[\s,]+/).filter(Boolean)) {
    if (raw.toLowerCase() === "none") continue;
    const agent = AGENT_CHOICES[Number(raw) - 1] ?? AGENT_CHOICES.find((choice) => choice.id === raw.toLowerCase());
    if (!agent) throw new Error(`Unknown agent: ${raw} (use ${AGENT_CHOICES.map((choice, index) => `${index + 1} ${choice.id}`).join(", ")}, or none)`);
    picks.add(agent.id);
  }
  return AGENT_CHOICES.map((choice) => choice.id).filter((id) => picks.has(id));
}

/** Official installers, per place (`wsl`/unix shells, or native Windows). */
const AGENT_INSTALLERS = {
  claude: {
    label: "Claude Code CLI",
    binary: "claude",
    unix: "curl -fsSL https://claude.ai/install.sh | bash",
    windows: "powershell -NoProfile -ExecutionPolicy Bypass -Command \"irm https://claude.ai/install.ps1 | iex\"",
    login: "claude   (then follow its sign-in)",
  },
  cursor: {
    label: "Cursor Agent CLI",
    binary: "agent",
    unix: "curl https://cursor.com/install -fsS | bash",
    windows: undefined,
    login: "agent login",
  },
};

const UV_INSTALL = {
  unix: "curl -LsSf https://astral.sh/uv/install.sh | sh",
  windows: "powershell -NoProfile -ExecutionPolicy Bypass -Command \"irm https://astral.sh/uv/install.ps1 | iex\"",
};

function isNativeWindows(place) {
  return process.platform === "win32" && place !== "wsl";
}

/** Whether `binary` runs where a backend will run (WSL or this machine). */
function placeHas(place, binary) {
  const probe = isNativeWindows(place) ? `where ${binary}` : `command -v ${binary}`;
  return runWhereWorkerRuns({ execution: place }, probe).status === 0;
}

function placeLabel(place) {
  if (place === "wsl") return "WSL";
  return process.platform === "win32" ? "Windows" : "this machine";
}

/**
 * The install steps for the picked components, each where it will run.
 * Codeman runs in WSL on Windows; cptr where `cptrPlace` says; agents go to
 * every place a picked backend runs, since that is where they are launched.
 */
function planInstalls(environment, picks, cptrPlace) {
  const steps = [];
  const notes = [];
  const codemanPlace = environment.execution;
  const places = [...new Set([
    ...(picks.includes("codeman") ? [codemanPlace] : []),
    ...(picks.includes("cptr") ? [cptrPlace] : []),
  ])];
  if (picks.includes("codeman") && !environment.codeman) {
    if (environment.platform === "windows" && !environment.wsl) {
      notes.push("Codeman needs WSL on Windows: run `wsl --install` in an administrator PowerShell, restart, then run `cloudagentfleet init` again.");
    } else {
      steps.push({ label: "Codeman (official installer)", place: codemanPlace, command: "curl -fsSL https://getcodeman.com/install | bash" });
    }
  }
  for (const id of ["claude", "cursor"]) {
    if (!picks.includes(id)) continue;
    const installer = AGENT_INSTALLERS[id];
    for (const place of places) {
      if (placeHas(place, installer.binary)) continue;
      const commandLine = isNativeWindows(place) ? installer.windows : installer.unix;
      if (commandLine) {
        steps.push({ label: `${installer.label} in ${placeLabel(place)}`, place, command: commandLine, agent: id });
      } else {
        notes.push(`${installer.label} for ${placeLabel(place)}: install it from https://cursor.com/cli, then run init again.`);
      }
    }
  }
  if (picks.includes("cptr") && !findCptrCommand({ ...environment, execution: cptrPlace })) {
    const withClaude = picks.includes("claude") || placeHas(cptrPlace, "claude");
    let installCommand = cptrInstallCommand(
      (probe) => runWhereWorkerRuns({ execution: cptrPlace }, probe).status === 0,
      { withClaude },
    );
    if (!installCommand) {
      // No Python package tool yet: uv brings its own Python.
      steps.push({
        label: `uv (Python tool installer, for Open WebUI Computer) in ${placeLabel(cptrPlace)}`,
        place: cptrPlace,
        command: isNativeWindows(cptrPlace) ? UV_INSTALL.windows : UV_INSTALL.unix,
      });
      const uv = isNativeWindows(cptrPlace) ? "\"%USERPROFILE%\\.local\\bin\\uv.exe\"" : "\"$HOME/.local/bin/uv\"";
      installCommand = `${uv} tool install cptr${withClaude ? " --with claude-agent-sdk" : ""}`;
    }
    steps.push({ label: `Open WebUI Computer in ${placeLabel(cptrPlace)}`, place: cptrPlace, command: installCommand, cptr: true });
  }
  return { steps, notes };
}

/** Installers drop tools in ~/.local/bin; let this process (and the services it installs) find them. */
function addUserBinToPath() {
  const userBin = join(homedir(), ".local", "bin");
  const separator = process.platform === "win32" ? ";" : ":";
  const entries = (process.env.PATH ?? "").split(separator);
  if (!entries.includes(userBin)) process.env.PATH = [userBin, ...entries].join(separator);
}

function slugify(value) {
  return value.toLowerCase().replaceAll(/[^a-z0-9-]+/g, "-").replaceAll(/^-+|-+$/g, "") || "machine";
}

/**
 * Configures this machine's Worker. Plain `setup` asks about each detail;
 * guided setup (`init`) shows one checklist, installs everything picked in a
 * single confirmed pass, asks only for the Hub, name, and folders, and returns
 * the saved configuration without starting anything.
 */
async function setup(options = {}) {
  const guided = options.guided === true;
  const environment = detectEnvironment();
  console.log(guided ? "This machine's Worker\n---------------------\n" : "Cloud Agent Fleet setup\n=======================\n");
  if (!guided) printEnvironment(environment);
  if (!environment.node || !environment.git) throw new Error("Node.js and Git are required");

  let selectedBackends;
  let picks = [];
  let cptrExecution;
  if (guided) {
    const installedMark = {
      codeman: environment.codeman,
      cptr: environment.cptr,
      claude: environment.claudeCli,
      cursor: environment.cursorCli,
    };
    console.log("This machine can offer one or both of:\n");
    BACKEND_INTRO.forEach((backend, index) => {
      console.log(`  ${index + 1}. ${backend.label}${installedMark[backend.id] ? " (installed)" : ""}`);
      for (const line of backend.lines) console.log(`     ${line}`);
      console.log("");
    });
    console.log("  3. Both\n");
    selectedBackends = parseBackendChoice(await ask("Which should this machine offer? (1, 2, or 3)", "3"));
    console.log("\nCoding agents (optional; Codeman and Open WebUI Computer launch them):");
    AGENT_CHOICES.forEach((agent, index) => {
      console.log(`  ${index + 1}. ${agent.label}${installedMark[agent.id] ? " (installed)" : ""} — ${agent.what}`);
    });
    const agentDefaults = AGENT_CHOICES.filter((agent) => installedMark[agent.id]).map((agent) => agent.id);
    const agents = parseAgentPicks(await ask("Which do you want? (numbers, or none; nothing is uninstalled)", agentDefaults.join(",") || "none"));
    picks = [...selectedBackends, ...agents];
    if (selectedBackends.includes("cptr")) cptrExecution = await chooseCptrExecution(environment);
    const { steps, notes } = planInstalls(environment, picks, cptrExecution ?? environment.execution);
    for (const note of notes) console.log(`Note: ${note}`);
    if (steps.length > 0) {
      if (picks.includes("cptr")) {
        console.log(`\nOpen WebUI Computer is third-party software under its own license: ${cptrLicenseUrl}`);
      }
      console.log("\nTo install:");
      for (const step of steps) console.log(`  • ${step.label}\n      ${step.command}`);
      if (await confirm("Install these now?", true)) {
        for (const step of steps) {
          console.log(`\nInstalling ${step.label} …`);
          const result = runWhereWorkerRuns({ execution: step.place }, step.command, { timeout: 15 * 60 * 1000, capture: false });
          console.log(result.status === 0 ? `Installed ${step.label}.` : `${step.label} did not install (exit ${result.status}); continuing.`);
        }
        addUserBinToPath();
        Object.assign(environment, detectEnvironment());
      }
    } else {
      console.log("\nEverything picked is already installed.");
    }
  } else {
    selectedBackends = parseBackendList(
      await ask("\nBackends on this machine (codeman, cptr, or codeman,cptr)", "codeman"),
    );
  }
  const useCodeman = selectedBackends.includes("codeman");
  const useCptr = selectedBackends.includes("cptr");

  if (!guided && useCodeman && !environment.codeman) {
    const installed = await installCodeman(environment);
    if (installed) environment.codeman = true;
  }
  if (useCodeman && !environment.codeman) {
    console.log(
      "Codeman is not on PATH yet. The Worker will install/start it on run "
      + "(set manageCodeman/installCodeman false in worker.json to opt out).",
    );
  }
  if (!guided && useCodeman && !environment.cursorCli) {
    const installed = await installCursorCli(environment);
    if (installed) environment.cursorCli = true;
  }
  if (!guided && useCptr) cptrExecution = await chooseCptrExecution(environment);
  const cptrPlacement = { ...environment, execution: cptrExecution ?? environment.execution };
  if (useCptr && cptrPlacement.execution !== environment.execution) {
    environment.cptr = Boolean(findCptrCommand(cptrPlacement));
  }
  if (!guided && useCptr && !environment.cptr) {
    environment.cptr = await installCptr(cptrPlacement);
  }
  // Record cptr's absolute path: Worker services run with a minimal PATH.
  const cptrCommand = useCptr ? findCptrCommand(cptrPlacement) : undefined;
  if (useCptr && !cptrCommand) {
    console.log("Open WebUI Computer is not installed yet; the Worker will keep running Codeman and retry cptr on each start.");
  }

  const controllerUrl = options.controllerUrl
    ?? await ask(guided ? "\nHub URL (the address you open the dashboard at)" : "\nController URL", "http://127.0.0.1:8787");
  const name = await ask(guided ? "Name for this machine" : "Worker display name", hostname());
  const nodeId = guided ? slugify(name) : await ask("Worker ID", hostname().toLowerCase().replaceAll(/[^a-z0-9-]/g, "-"));
  const workspacePolicy = await selectFolders();
  const codemanMode = useCodeman && !guided
    ? await ask(`Codeman mode (${modes.join(", ")})`, "claude")
    : environment.claudeCli ? "claude" : "shell";
  if (!modes.includes(codemanMode)) throw new Error(`Unsupported Codeman mode: ${codemanMode}`);
  const codemanUrl = useCodeman && !guided ? await ask("Codeman URL", "http://127.0.0.1:3000") : "http://127.0.0.1:3000";
  const defaultCptrUrl = `http://127.0.0.1:${await freeLocalPort(8000)}`;
  const cptrUrl = useCptr
    ? safeEndpoint(guided ? defaultCptrUrl : await ask("Open WebUI Computer local URL", defaultCptrUrl), "Open WebUI Computer URL")
    : undefined;
  // The cptr driver: through this Worker's outbound connector (no inbound
  // port), or directly over the tailnet.
  const cptrAccess = useCptr
    ? guided ? "connector" : parseCptrAccess(await ask("How should the Hub reach Open WebUI Computer (connector, tailnet)", "connector"))
    : undefined;
  // The Hub stores a generated Worker token in its data folder (hub-worker-token).
  const authToken = options.authToken
    || process.env.CLOUDAGENTFLEET_AUTH_TOKEN
    || (await ask(
      guided
        ? "Worker token (run `cloudagentfleet hub token` on the Hub machine)"
        : "Hub Worker token (from the Hub's hub-worker-token file; Enter to skip)",
      "",
    )).trim()
    || undefined;
  const config = {
    nodeId,
    name,
    controllerUrl,
    authToken,
    // The single-Worker placement: Codeman's when it is used, else cptr's.
    execution: useCodeman ? environment.execution : cptrPlacement.execution,
    ...(useCptr ? { cptrExecution: cptrPlacement.execution } : {}),
    workspacePolicy,
    workspaces: discoverWorkspaces(
      workspacePolicy,
      environment.codeman,
      environment.cursorCli,
      environment.claudeCli,
    ),
    backends: selectedBackends,
    codemanMode,
    codemanUrl,
    manageCodeman: useCodeman,
    installCodeman: useCodeman,
    ...(cptrUrl ? { cptrUrl, manageCptr: true, cptrAccess, cptrInstanceId: `${nodeId}-cptr` } : {}),
    ...(cptrCommand ? { cptrCommand } : {}),
  };

  mkdirSync(dirname(configPath), { recursive: true });
  writeSafeJson(configPath, config);
  console.log(`\nSaved Worker configuration: ${configPath}`);
  console.log(`Discovered ${config.workspaces.length} workspace(s).`);

  const processes = workerProcesses(config);
  if (processes.length > 1) {
    console.log(
      "\nCodeman runs in WSL and Open WebUI Computer natively on Windows: the Worker service starts "
      + `two Workers, ${processes[0].nodeId} (WSL) and ${processes[1].nodeId} (Windows).`,
    );
  }
  if (guided) {
    const logins = picks
      .filter((id) => AGENT_INSTALLERS[id])
      .map((id) => `  ${AGENT_INSTALLERS[id].login}`);
    if (logins.length > 0) {
      console.log(["", "Sign in to your coding agents yourself (Cloud Agent Fleet never handles provider logins):", ...logins].join("\n"));
    }
    return config;
  }

  const cptrNodeId = processes.find((entry) => entry.backends.includes("cptr"))?.nodeId ?? nodeId;
  if (useCptr && cptrAccess === "connector") {
    console.log([
      "",
      "Enroll Open WebUI Computer through this Worker once it is running:",
      `  cloudagentfleet enroll connector --backend cptr --controller-url ${controllerUrl} \\`,
      `    --node-id ${cptrNodeId} --instance-id ${nodeId}-cptr --name "${name} (Open WebUI Computer)"`,
      "(`cloudagentfleet init` does this for you.) On cptr's first start the Worker creates its account,",
      "and the dashboard signs you in.",
    ].join("\n"));
  } else if (useCptr) {
    let tailnetUrl;
    if (environment.cptr && await confirm(
      `Publish Open WebUI Computer to your tailnet with Tailscale Serve (https port ${cptrTailnetPort})?`,
      false,
    )) {
      try {
        tailnetUrl = exposeCptrOnTailnet(cptrUrl);
        console.log(`Open WebUI Computer is served privately at ${tailnetUrl}`);
      } catch (error) {
        console.log(`Tailscale Serve did not start: ${error instanceof Error ? error.message : error}`);
      }
    }
    console.log([
      "",
      "Enroll Open WebUI Computer with the Hub once the Worker has started it:",
      `  cloudagentfleet enroll tailscale-url --backend cptr --controller-url ${controllerUrl} \\`,
      `    --instance-id ${nodeId}-cptr --name "${name} (Open WebUI Computer)" \\`,
      `    --url ${tailnetUrl ?? "https://<this-machine>.<tailnet>.ts.net:<port>"}`,
      ...(tailnetUrl ? [] : [`  (If the Hub runs on this machine, --url ${cptrUrl} also works.)`]),
    ].join("\n"));
  }

  if (useCodeman && environment.codeman && await confirm("Start Codeman now?", true)) {
    if (!startCodeman(environment)) {
      console.log("Codeman did not start; Worker will start it on run when manageCodeman is on.");
    }
  }
  if (process.argv.includes("--run")) {
    if (useCodeman && !environment.codeman) {
      console.log("Worker will install/start Codeman under the hood …");
    }
    await superviseChildren(processes.map((entry) => runWorker(entry)));
  } else {
    console.log("Run `cloudagentfleet run` to start the Worker, or `cloudagentfleet worker install` to run it as a service.");
  }
  return config;
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

export function parseCptrAccess(value) {
  const access = String(value).trim().toLowerCase();
  if (access !== "connector" && access !== "tailnet") {
    throw new Error("Open WebUI Computer access must be connector or tailnet");
  }
  return access;
}

export function parseBackendList(value) {
  const selected = [...new Set(String(value).split(",").map((item) => item.trim().toLowerCase()).filter(Boolean))];
  if (selected.length === 0) throw new Error("Choose at least one backend");
  const unknown = selected.filter((item) => !backends.includes(item));
  if (unknown.length > 0) throw new Error(`Unsupported backend: ${unknown.join(", ")} (use ${backends.join(", ")})`);
  return selected;
}

export function parseOptions(args) {
  const values = new Map();
  const positionals = [];
  const booleans = new Set(["help", "no-health", "link-only"]);
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
  const loopback = loopbackHosts.has(parsed.hostname);
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && loopback)) {
    throw new Error(`${field} must use HTTPS, or HTTP on loopback for local development`);
  }
  // Matches the Hub: a tailnet HTTPS host, or a loopback URL when the Hub runs
  // on the same machine (local development).
  if (tailscale && !loopback && parsed.protocol !== "https:") {
    throw new Error(`${field} must use HTTPS in tailscale-url mode`);
  }
  if (tailscale && !loopback && !isTailnetHostname(parsed.hostname)) {
    throw new Error(`${field} must use a *.ts.net or Tailscale 100.64.0.0/10 hostname, or loopback when the Hub runs on this machine`);
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

function parseCapabilities(parsed, backend = "codeman") {
  const values = optionValues(parsed, "capability").flatMap((value) => value.split(","));
  const capabilities = values.map((value) => value.trim()).filter(Boolean);
  return [...new Set(capabilities.length > 0 ? capabilities : [backend])];
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
  const token = process.env.CLOUDAGENTFLEET_AUTH_TOKEN?.trim();
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

/** Points the local Worker's driver for this backend at the enrolled connector instance. */
function linkWorkerInstance(nodeId, instanceId, backend = "codeman") {
  try {
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    const owner = workerProcesses(config).find((entry) => entry.nodeId === nodeId);
    if (!owner || !owner.backends.includes(backend)) return false;
    // Already the instance the Worker serves: nothing to change or restart.
    const current = backend === "cptr"
      ? config.cptrInstanceId ?? `${config.nodeId}-cptr`
      : config.codemanInstanceId ?? config.nodeId;
    if (current === instanceId) return false;
    if (backend === "cptr") config.cptrInstanceId = instanceId;
    else config.codemanInstanceId = instanceId;
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
  const backend = optionValue(parsed, "backend") ?? "codeman";
  if (!backends.includes(backend)) {
    throw new Error(`--backend must be one of: ${backends.join(", ")}`);
  }
  const selectedMode = optionValue(parsed, "mode") ?? parsed.positionals[0]
    ?? await ask("Connection mode (connector or tailscale-url)", "connector");
  if (selectedMode !== "connector" && selectedMode !== "tailscale-url") {
    throw new Error("--mode must be connector or tailscale-url");
  }
  const linkOnly = parsed.values.has("link-only");
  if (linkOnly && backend !== "cptr") throw new Error("--link-only applies only to --backend cptr");
  if (linkOnly && selectedMode !== "tailscale-url") {
    throw new Error("--link-only needs a tailscale-url instance; the connector driver always proxies cptr");
  }

  const controllerUrl = safeEndpoint(
    optionValue(parsed, "controller-url", "controller")
      ?? process.env.CLOUDAGENTFLEET_CONTROLLER_URL
      ?? await ask("Controller URL", "http://127.0.0.1:8787"),
    "Controller URL",
  );
  const id = assertNonEmpty(
    optionValue(parsed, "instance-id", "id") ?? await ask("Instance ID"),
    "Instance ID",
  );
  const label = assertNonEmpty(
    optionValue(parsed, "name", "label") ?? await ask("Instance name", id),
    "Instance name",
  );
  const codemanUsername = optionValue(parsed, "username")
    ?? process.env.CLOUDAGENTFLEET_CODEMAN_USERNAME;
  const codemanPassword = optionValue(parsed, "password")
    ?? process.env.CLOUDAGENTFLEET_CODEMAN_PASSWORD;
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
    backend,
    connectionMode: selectedMode,
    ...(selectedMode === "connector"
      ? {
          nodeId: assertNonEmpty(
            optionValue(parsed, "node-id", "worker-id")
              ?? process.env.CLOUDAGENTFLEET_NODE_ID
              ?? await ask("Enrolled Worker node ID"),
            "Worker node ID",
          ),
        }
      : {
          endpoint: safeEndpoint(
            optionValue(parsed, "url", "endpoint", "tailscale-url")
              ?? await ask("Tailscale URL"),
            "Tailscale URL",
            true,
          ),
        }),
    capabilities: [...new Set([...parseCapabilities(parsed, backend), ...(linkOnly ? ["link"] : [])])],
    ...(agents ? { agents } : {}),
    // cptr manages its own workspaces; the Hub never mediates them, so there
    // is no folder policy to ask for.
    ...((selectedMode === "connector" && backend !== "cptr") || workspaceOptions.length > 0
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
  const linked = selectedMode === "connector" ? linkWorkerInstance(registration.nodeId, registration.id, backend) : false;
  const backendLabel = backend === "cptr" ? "Open WebUI Computer" : "Codeman";
  console.log(`Registered ${backendLabel} instance ${registration.label} (${registration.id}) in ${selectedMode} mode.`);
  if (linked) {
    const variable = backend === "cptr" ? "CLOUDAGENTFLEET_CPTR_INSTANCE_ID" : "CLOUDAGENTFLEET_CODEMAN_INSTANCE_ID";
    console.log(`Updated Worker configuration with ${variable}=${registration.id}. Restart the Worker to apply it.`);
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
  const healthStatus = health.body?.instance?.status;
  if (!health.response.ok || healthStatus !== "online") {
    const hint = selectedMode === "connector"
      ? "The Worker must be online and configured with the same CLOUDAGENTFLEET_CODEMAN_INSTANCE_ID."
      : backend === "cptr"
        ? "The Tailscale URL must reach Open WebUI Computer's /api/health (run cptr with --host 0.0.0.0 or behind Tailscale Serve)."
        : "The Tailscale URL must be reachable and expose Codeman's /api/v1/status endpoint.";
    const reason = health.response.ok
      ? `instance is ${healthStatus ?? "unknown"}`
      : controllerError(health.body, health.response);
    throw new Error(`Instance registered, but health verification failed: ${reason}. ${hint}`);
  }
  if (!health.body?.instance) throw new Error("Health verification returned no instance");
  printHealth(health.body?.instance, selectedMode);
  return health.body.instance;
}

function printEnrollmentHelp() {
  console.log([
    "Register a host instance (default backend: Codeman) with the Controller.",
    "",
    "Usage:",
    "  cloudagentfleet enroll [connector|tailscale-url] [options]",
    "",
    "Options:",
    "  --backend <codeman|cptr>                   default codeman; cptr = Open WebUI Computer (connector or tailscale-url)",
    "  --link-only                                cptr over tailscale-url: open it directly, not through the Hub",
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
    "Credentials are read from CLOUDAGENTFLEET_AUTH_TOKEN and are never saved in the instance file.",
  ].join("\n"));
}

function printHubHelp() {
  console.log([
    "Run the Cloud Agent Fleet Hub, and serve it privately through Tailscale Serve.",
    "",
    "Usage:",
    "  cloudagentfleet hub service <install|start|status|stop|remove>  The Hub as a user service",
    "  cloudagentfleet hub run [--restart] [--log]  The Hub in this terminal",
    "  cloudagentfleet hub token                    The Worker token new machines need",
    "  cloudagentfleet hub serve [--port <1-65535>] [--host-port <1-65535>]",
    "  cloudagentfleet hub status [--port <1-65535>]   Tailscale Serve status",
    "  cloudagentfleet hub stop  [--port <1-65535>]    Stop Tailscale Serve",
    "",
    "`cloudagentfleet init` sets all of this up. Settings: ~/.cloudagentfleet/hub-config.json.",
    "Serve uses one tailnet origin for the Hub and never publishes host instances.",
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
  if (action === "run") {
    await runSavedHub({ restart: args.includes("--restart"), log: args.includes("--log") });
    return;
  }
  if (action === "service") {
    serviceAction("hub", args[1] ?? "status");
    return;
  }
  if (action === "token") {
    const token = readHubWorkerToken();
    if (!token) throw new Error("No Worker token yet: start the Hub once (cloudagentfleet init), or use the CLOUDAGENTFLEET_AUTH_TOKEN you set for it.");
    console.log(token);
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

/**
 * `run --restart` restarts failed Workers itself after 5 seconds, and
 * `run --log` appends their output to ~/.cloudagentfleet/worker.log. The
 * Windows task uses both: its hidden console host neither shows output nor
 * passes exit codes on to Task Scheduler.
 */
async function runSavedWorker(options = {}) {
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  await runService("worker", (output) => workerProcesses(config).map((entry) => runWorker(entry, output)), options);
}

/** `hub run`: the Hub with its saved settings, supervised like the Worker. */
async function runSavedHub(options = {}) {
  const config = readHubConfig();
  await runService("hub", (output) => [runHub(config, output)], options);
}

/**
 * Runs a service's processes until they exit; with `restart`, as the service
 * itself (pid file, no duplicates, restart after a failure).
 */
async function runService(role, startProcesses, { restart = false, log = false } = {}) {
  const { label } = SERVICE_ROLES[role];
  const pidFile = servicePidPath(role);
  if (restart) {
    const running = readServicePid(role);
    if (running && running !== process.pid && processAlive(running)) {
      console.error(`The ${label} service is already running (pid ${running}).`);
      return;
    }
    mkdirSync(dirname(pidFile), { recursive: true });
    writeFileSync(pidFile, String(process.pid), { mode: 0o600 });
  }
  const logPath = join(dirname(configPath), `${role}.log`);
  const output = log ? createWriteStream(logPath, { flags: "a", mode: 0o600 }) : undefined;
  if (output) console.log(`${label} output: ${logPath}`);
  try {
    for (;;) {
      output?.write(`\n--- ${new Date().toISOString()} starting ${label} ---\n`);
      const exitCode = await superviseChildren(startProcesses(output));
      if (!restart || stopRequested || exitCode === 0) return;
      (output ?? process.stderr).write(`The ${label} exited with code ${exitCode}; restarting in 5 seconds.\n`);
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 5000));
    }
  } finally {
    if (restart && readServicePid(role) === process.pid) unlinkSync(pidFile);
  }
}

function servicePidPath(role) {
  return join(dirname(configPath), `${role}.pid`);
}

function readServicePid(role) {
  try {
    return Number.parseInt(readFileSync(servicePidPath(role), "utf8"), 10) || undefined;
  } catch {
    return undefined;
  }
}

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Ending a Windows task stops only its console host; the service's processes
 * (for the Worker also cptr and the WSL Worker) keep running, so end the tree.
 */
function stopWindowsServiceTree(role) {
  const pid = readServicePid(role);
  if (!pid) return;
  if (processAlive(pid)) command("taskkill.exe", ["/PID", String(pid), "/T", "/F"], { timeout: 15_000 });
  try {
    unlinkSync(servicePidPath(role));
  } catch {
    // Already gone.
  }
}

let supervisedChildren = [];
let stopRequested = false;
let stopForwarding = false;

function forwardStop(signal) {
  for (const child of supervisedChildren) {
    if (child.exitCode === null && child.signalCode === null) child.kill(signal);
  }
}

/**
 * Makes `cloudagentfleet run` stand in for its processes: stop signals reach
 * every process, and the first one to exit stops the rest and sets our exit
 * status, so a service manager (systemd Restart=on-failure, launchd
 * KeepAlive) sees a failure as a failure and restarts them together.
 * Resolves with that exit status.
 */
function superviseChildren(children) {
  supervisedChildren = children;
  if (!stopForwarding) {
    stopForwarding = true;
    for (const signal of ["SIGINT", "SIGTERM"]) {
      process.on(signal, () => {
        stopRequested = true;
        forwardStop(signal);
      });
    }
  }
  return new Promise((resolveExit) => {
    let settled = false;
    const settle = (exitCode) => {
      if (settled) return;
      settled = true;
      process.exitCode = exitCode;
      forwardStop("SIGTERM");
      resolveExit(exitCode);
    };
    for (const child of children) {
      child.once("error", (error) => {
        console.error(`Could not start: ${error.message}`);
        settle(1);
      });
      child.once("exit", (code, signal) => {
        settle(code ?? (signal === "SIGINT" || signal === "SIGTERM" ? 0 : 1));
      });
    }
  });
}

/** The user services this CLI installs; the Hub and the Worker can share a machine. */
const SERVICE_ROLES = {
  worker: {
    label: "Worker",
    systemd: "cloudagentfleet-worker.service",
    launchd: "com.cloudagentfleet.worker",
    task: "Cloud Agent Fleet Worker",
    args: ["run"],
    config: () => configPath,
    setupHint: "Run `cloudagentfleet init` (or `cloudagentfleet setup`) first.",
  },
  hub: {
    label: "Hub",
    systemd: "cloudagentfleet-hub.service",
    launchd: "com.cloudagentfleet.hub",
    task: "Cloud Agent Fleet Hub",
    args: ["hub", "run"],
    config: () => hubConfigPath,
    setupHint: "Run `cloudagentfleet init` and choose hub first.",
  },
};

function servicePaths(role) {
  const definition = SERVICE_ROLES[role];
  if (process.platform === "linux") {
    return {
      kind: "systemd",
      path: join(homedir(), ".config", "systemd", "user", definition.systemd),
      name: definition.systemd,
    };
  }
  if (process.platform === "darwin") {
    return {
      kind: "launchd",
      path: join(homedir(), "Library", "LaunchAgents", `${definition.launchd}.plist`),
      name: definition.launchd,
    };
  }
  return { kind: "schtasks", path: null, name: definition.task };
}

/**
 * One-time move of the pre-rename config directory (~/.hosted-agents). Safe on
 * every command, including `run`, which the legacy service still invokes.
 */
function migrateLegacyConfig() {
  const legacyDir = join(homedir(), ".hosted-agents");
  const currentDir = dirname(configPath);
  if (existsSync(legacyDir) && !existsSync(currentDir)) {
    renameSync(legacyDir, currentDir);
    console.log(`Moved configuration from ${legacyDir} to ${currentDir}`);
  }
}

/** The pre-rename user service, if still installed (Windows kept its task name). */
function legacyWorkerService() {
  const service = process.platform === "linux"
    ? {
        kind: "systemd",
        path: join(homedir(), ".config", "systemd", "user", "hosted-agents-worker.service"),
        name: "hosted-agents-worker.service",
      }
    : process.platform === "darwin"
      ? {
          kind: "launchd",
          path: join(homedir(), "Library", "LaunchAgents", "com.hosted-agents.worker.plist"),
          name: "com.hosted-agents.worker",
        }
      : undefined;
  return service && existsSync(service.path) ? service : undefined;
}

/**
 * Removes the legacy service. Called only after the replacement is installed,
 * and never from `run`: the legacy service itself execs `run`, so removing
 * it there would stop the Worker with nothing to replace it.
 */
function removeLegacyWorkerService() {
  const legacy = legacyWorkerService();
  if (!legacy) return;
  if (legacy.kind === "systemd") {
    command("systemctl", ["--user", "disable", "--now", legacy.name], { capture: true });
  } else {
    command("launchctl", ["unload", legacy.path], { capture: true });
  }
  unlinkSync(legacy.path);
  if (legacy.kind === "systemd") command("systemctl", ["--user", "daemon-reload"], { capture: true });
  console.log(`Replaced legacy Worker service ${legacy.name}.`);
}

/**
 * systemd `Environment=` line. Services start with a minimal PATH, so the
 * Worker records the installer's PATH: Codeman sessions and cptr agents must
 * find claude, codex and agent the way the user's shell does.
 */
export function systemdEnvironmentLine(name, value) {
  const escaped = `${name}=${value}`.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("%", "%%");
  return `Environment="${escaped}"`;
}

/**
 * Task Scheduler definition for a Windows service. A logon trigger scoped to
 * the current user needs no administrator rights (`schtasks /SC ONLOGON`
 * does), and a headless console host keeps a window from opening at logon.
 */
export function windowsWorkerTaskXml(user, executable, args, description = "Cloud Agent Fleet Worker") {
  const xml = (value) => String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
  const quote = (value) => `"${String(value).replaceAll('"', '\\"')}"`;
  return [
    '<?xml version="1.0" encoding="UTF-16"?>',
    '<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">',
    `  <RegistrationInfo><Description>${xml(description)}</Description></RegistrationInfo>`,
    `  <Triggers><LogonTrigger><Enabled>true</Enabled><UserId>${xml(user)}</UserId></LogonTrigger></Triggers>`,
    "  <Principals><Principal id=\"Author\">",
    `    <UserId>${xml(user)}</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel>`,
    "  </Principal></Principals>",
    "  <Settings>",
    "    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>",
    "    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>",
    "    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>",
    "    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>",
    "  </Settings>",
    "  <Actions Context=\"Author\"><Exec>",
    "    <Command>conhost.exe</Command>",
    `    <Arguments>${xml(["--headless", executable, ...args].map(quote).join(" "))}</Arguments>`,
    "  </Exec></Actions>",
    "</Task>",
    "",
  ].join("\r\n");
}

/** Installs and starts a role's user service (systemd, launchd, or Task Scheduler). */
function installService(role) {
  const definition = SERVICE_ROLES[role];
  if (!existsSync(definition.config())) {
    throw new Error(`${definition.label} configuration not found: ${definition.config()}. ${definition.setupHint}`);
  }
  const service = servicePaths(role);
  const executable = process.execPath;
  const script = fileURLToPath(import.meta.url);
  const args = definition.args;
  if (service.kind === "systemd") {
    mkdirSync(dirname(service.path), { recursive: true });
    writeFileSync(service.path, [
      "[Unit]",
      `Description=Cloud Agent Fleet ${definition.label}`,
      "After=network-online.target",
      "",
      "[Service]",
      `ExecStart=${[executable, script].map(shellQuote).join(" ")} ${args.join(" ")}`,
      ...(process.env.PATH ? [systemdEnvironmentLine("PATH", process.env.PATH)] : []),
      "Restart=on-failure",
      "RestartSec=5",
      "",
      "[Install]",
      "WantedBy=default.target",
      "",
    ].join("\n"), { mode: 0o600 });
    serviceCommand("systemctl", ["--user", "daemon-reload"]);
    serviceCommand("systemctl", ["--user", "enable", "--now", service.name]);
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
      `<key>Label</key><string>${service.name}</string>`,
      `<key>ProgramArguments</key><array>${[executable, script, ...args].map((value) => `<string>${xml(value)}</string>`).join("")}</array>`,
      ...(process.env.PATH
        ? [`<key>EnvironmentVariables</key><dict><key>PATH</key><string>${xml(process.env.PATH)}</string></dict>`]
        : []),
      "<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>",
      "</dict></plist>",
      "",
    ].join("\n"), { mode: 0o600 });
    serviceCommand("launchctl", ["load", "-w", service.path]);
  } else {
    const user = process.env.USERDOMAIN ? `${process.env.USERDOMAIN}\\${process.env.USERNAME}` : process.env.USERNAME;
    const taskPath = join(dirname(configPath), `${role}-task.xml`);
    const taskXml = windowsWorkerTaskXml(user, executable, [script, ...args, "--restart", "--log"], service.name);
    // schtasks reads task XML as UTF-16 with a byte order mark.
    writeFileSync(taskPath, `﻿${taskXml}`, { encoding: "utf16le", mode: 0o600 });
    serviceCommand("schtasks.exe", ["/Create", "/TN", service.name, "/XML", taskPath, "/F"]);
    // A logon task waits for the next logon; start it now, like systemd and launchd do.
    serviceCommand("schtasks.exe", ["/Run", "/TN", service.name]);
  }
  console.log(`Installed and started the user-level ${definition.label} service: ${service.name}`);
  if (role === "worker") removeLegacyWorkerService();
}

/**
 * Native command for each service action. `status` reports instead of
 * failing, because an inactive service is a valid answer.
 */
function serviceArgs(service, action) {
  if (service.kind === "systemd") {
    const verb = { start: "start", stop: "stop", status: "status", remove: "disable" }[action];
    return ["systemctl", ["--user", verb, ...(action === "remove" ? ["--now"] : []), service.name]];
  }
  if (service.kind === "launchd") {
    if (action === "status") return ["launchctl", ["list", service.name]];
    return ["launchctl", [action === "start" ? "load" : "unload", "-w", service.path]];
  }
  const verb = { start: "/Run", stop: "/End", status: "/Query", remove: "/Delete" }[action];
  return ["schtasks.exe", [verb, "/TN", service.name, ...(action === "remove" ? ["/F"] : [])]];
}

function serviceAction(role, action) {
  const { label } = SERVICE_ROLES[role];
  if (action === "install") {
    installService(role);
    return;
  }
  if (!["start", "stop", "status", "remove"].includes(action)) {
    throw new Error(`Unknown ${role} service command: ${action} (use install, start, stop, status, or remove)`);
  }
  const service = servicePaths(role);
  const [executable, args] = serviceArgs(service, action);
  if (action === "status") {
    const result = command(executable, args, { capture: false });
    if (result.status !== 0) console.log(`${label} service ${service.name} is not running or not installed.`);
    return;
  }
  if (service.kind === "schtasks" && action === "remove") {
    command("schtasks.exe", ["/End", "/TN", service.name]);
  }
  serviceCommand(executable, args);
  if (service.kind === "schtasks" && (action === "stop" || action === "remove")) stopWindowsServiceTree(role);
  if (action === "remove" && service.path && existsSync(service.path)) {
    unlinkSync(service.path);
    if (service.kind === "systemd") serviceCommand("systemctl", ["--user", "daemon-reload"]);
  }
  console.log(`${label} service ${action} complete.`);
}

function workerServiceAction(action) {
  serviceAction("worker", action);
}

function serviceCommand(executable, args) {
  const result = command(executable, args, { capture: false });
  if (result.status !== 0) throw new Error(`${executable} ${args.join(" ")} failed`);
}

// ── Hub ─────────────────────────────────────────────────────

/** Saved Hub settings (`init` writes them); the Hub's own state lives in its data folder. */
const hubConfigPath = join(dirname(configPath), "hub-config.json");

export function defaultHubConfig(home = homedir()) {
  return {
    host: "127.0.0.1",
    port: 8787,
    dataPath: join(home, ".cloudagentfleet", "hub.json"),
  };
}

function readHubConfig() {
  let saved = {};
  try {
    saved = JSON.parse(readFileSync(hubConfigPath, "utf8"));
  } catch {
    // No saved settings yet.
  }
  // The Hub honours CLOUDAGENTFLEET_DATA_PATH, so `hub token` does too.
  const dataPath = process.env.CLOUDAGENTFLEET_DATA_PATH;
  return { ...defaultHubConfig(), ...saved, ...(dataPath ? { dataPath } : {}) };
}

export function hubEnvironment(config) {
  return {
    CLOUDAGENTFLEET_HOST: config.host,
    CLOUDAGENTFLEET_PORT: String(config.port),
    CLOUDAGENTFLEET_DATA_PATH: config.dataPath,
    ...(config.publicUrl ? { CLOUDAGENTFLEET_PUBLIC_URL: config.publicUrl } : {}),
    ...(config.hostUiUrl ? { CLOUDAGENTFLEET_HOST_UI_URL: config.hostUiUrl } : {}),
  };
}

/** The Hub beside this CLI (the Hub install), or from a source checkout. */
function resolveHubScript() {
  return [
    join(thisDir, "cloudagentfleet-hub.mjs"),
    join(thisDir, "..", "..", "control-plane", "src", "server.ts"),
  ].find((candidate) => existsSync(candidate));
}

function workerInstalled() {
  try {
    resolveWorkerScript();
    return true;
  } catch {
    return false;
  }
}

function runHub(config, log) {
  const script = resolveHubScript();
  if (!script) throw new Error("The Hub is not part of this install. Install @cloudagentfleet/hub on the machine that should run it.");
  const child = spawn(
    process.execPath,
    [script.endsWith(".ts") ? "--experimental-strip-types" : "", script].filter(Boolean),
    {
      cwd: homedir(),
      env: { ...process.env, ...hubEnvironment(config) },
      stdio: log ? ["ignore", "pipe", "pipe"] : "inherit",
    },
  );
  child.stdout?.pipe(log, { end: false });
  child.stderr?.pipe(log, { end: false });
  return child;
}

function hubDataDir(config = readHubConfig()) {
  return dirname(config.dataPath);
}

/** The Worker token Workers present to this Hub (generated by the Hub on first start). */
function readHubWorkerToken(config = readHubConfig()) {
  try {
    return readFileSync(join(hubDataDir(config), "hub-worker-token"), "utf8").trim() || undefined;
  } catch {
    return undefined;
  }
}

/** The generated Hub password, until the operator sets their own. */
function readHubPassword(config = readHubConfig()) {
  try {
    const value = JSON.parse(readFileSync(join(hubDataDir(config), "hub-ui-auth.json"), "utf8"));
    return typeof value.password === "string" ? value.password : undefined;
  } catch {
    return undefined;
  }
}

async function waitForHub(baseUrl, timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/healthz`, { signal: AbortSignal.timeout(2_000) });
      if (response.ok) return true;
    } catch {
      // Not up yet.
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 750));
  }
  return false;
}

/** This machine's tailnet name (`laptop.tailnet.ts.net`), when Tailscale is running. */
function tailnetName() {
  try {
    const status = JSON.parse(runTailscale(["status", "--json"]).stdout || "{}");
    return String(status?.Self?.DNSName ?? "").replace(/\.$/, "") || undefined;
  } catch {
    return undefined;
  }
}

// ── Guided setup ────────────────────────────────────────────

/**
 * `cloudagentfleet init`: one guided flow for a new machine. It offers the
 * roles this install contains (Hub, Worker, or both), sets them up as user
 * services, enrolls the machine with the Hub, and ends with the dashboard
 * address and what to do next.
 */
async function init() {
  const hasHub = Boolean(resolveHubScript());
  const hasWorker = workerInstalled();
  if (!hasHub && !hasWorker) throw new Error("This install contains neither the Hub nor the Worker.");
  console.log([
    "Cloud Agent Fleet",
    "=================",
    "",
    "A fleet has one Hub (the dashboard you sign in to) and a Worker on every machine",
    "whose agents you want to reach.",
    "",
  ].join("\n"));

  // A Hub install sets up the Hub, and runs a Worker on the same machine only
  // when asked (a server usually has no agents). A Worker install is a Worker.
  const hub = hasHub ? await initHub() : undefined;
  const addWorker = !hasHub || (hasWorker && await confirm(
    "\nAlso run a Worker on this machine, so its own agents show up in the dashboard?",
    existsSync(configPath),
  ));
  const worker = addWorker ? await initWorker(hub) : undefined;
  if (hub && !worker) {
    console.log("\nNo Worker on this machine. Run `cloudagentfleet init` again any time to add one.");
  }

  console.log(["", "Done.", ""].join("\n"));
  if (hub) {
    console.log(`Dashboard:  ${hub.dashboardUrl}`);
    console.log(hub.password
      ? `Password:   ${hub.password}  (stored in ${join(hubDataDir(), "hub-ui-auth.json")}; set CLOUDAGENTFLEET_UI_PASSWORD to choose your own)`
      : "Password:   the one you set with CLOUDAGENTFLEET_UI_PASSWORD");
    console.log([
      "",
      "Add another machine: install @cloudagentfleet/worker there (or the worker archive),",
      "run `cloudagentfleet init`, and give it:",
      `  Hub URL:       ${hub.workerUrl}`,
      "  Worker token:  run `cloudagentfleet hub token` on this machine",
    ].join("\n"));
  }
  if (worker) {
    console.log("");
    console.log(worker.enrolled
      ? `This machine (${worker.name}) is enrolled and appears in the dashboard.`
      : `This machine (${worker.name}) is set up but not fully enrolled; see the messages above.`);
  }
  console.log([
    "",
    "Next: open the dashboard, pick a machine, and start a session or open its own UI.",
    "Guide: https://techoblix.github.io/cloudagentfleet/docs/getting-started.html",
  ].join("\n"));
}

async function initHub() {
  const config = readHubConfig();
  if (!existsSync(hubConfigPath)) {
    // The Hub uses two ports (dashboard and host UIs); take the first free pair.
    let port = config.port;
    while (port < config.port + 40 && (await freeLocalPort(port) !== port || await freeLocalPort(port + 1) !== port + 1)) {
      port += 2;
    }
    if (port !== config.port) console.log(`Port ${config.port} is in use; the Hub will use ${port} (and ${port + 1} for host UIs).`);
    config.port = port;
  }
  writeSafeJson(hubConfigPath, config);
  const baseUrl = `http://127.0.0.1:${config.port}`;
  if (await waitForHub(baseUrl, 1_500)) {
    console.log(`A Hub is already answering at ${baseUrl}; installing the service for the next logon.`);
  }
  installService("hub");
  if (!await waitForHub(baseUrl)) {
    throw new Error(`The Hub did not start at ${baseUrl}. See ${join(dirname(configPath), "hub.log")} or run \`cloudagentfleet hub run\`.`);
  }
  console.log(`The Hub is running at ${baseUrl}.`);
  let dashboardUrl = `${baseUrl}/_fleet/`;
  let workerUrl = baseUrl;
  const name = tailnetName();
  if (name && await confirm("Publish the Hub privately on your tailnet with Tailscale Serve (recommended)?", true)) {
    try {
      await serveHub([]);
      dashboardUrl = `https://${name}/_fleet/`;
      workerUrl = `https://${name}`;
    } catch (error) {
      console.log(`Tailscale Serve did not start: ${error instanceof Error ? error.message : error}`);
    }
  } else if (!name) {
    console.log("Tailscale is not running here, so the Hub stays on this machine only. Run `cloudagentfleet hub serve` later to reach it from your other devices.");
  }
  return {
    controllerUrl: baseUrl,
    token: readHubWorkerToken(config),
    password: readHubPassword(config),
    dashboardUrl,
    workerUrl,
  };
}

async function initWorker(hub) {
  const config = await setup({
    guided: true,
    ...(hub ? { controllerUrl: hub.controllerUrl, authToken: hub.token } : {}),
  });
  installService("worker");
  return { ...config, enrolled: await enrollWorkerConfig(config) };
}

/** Re-runs an instance's health check until it is online. */
async function waitForInstanceOnline(controllerUrl, instanceId, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${controllerUrl}/api/instances/${encodeURIComponent(instanceId)}/health`, {
        method: "POST",
        headers: { ...authHeaders(), accept: "application/json" },
        signal: AbortSignal.timeout(10_000),
      });
      if (response.ok && (await response.json())?.instance?.status === "online") {
        console.log(`${instanceId} is online.`);
        return true;
      }
    } catch {
      // Still starting.
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 3_000));
  }
  return false;
}

/** Waits until a freshly started Worker has registered with the Hub (it can enroll instances only then). */
async function waitForNode(controllerUrl, nodeId, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${controllerUrl}/api/workers`, {
        headers: { ...authHeaders(), accept: "application/json" },
        signal: AbortSignal.timeout(3_000),
      });
      const body = response.ok ? await response.json() : undefined;
      if (body?.workers?.some((worker) => worker.id === nodeId || worker.nodeId === nodeId)) return true;
    } catch {
      // The Hub or the Worker is still starting.
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 1_000));
  }
  return false;
}

/** Enrolls the instances a saved Worker config serves; true when all of them enrolled. */
async function enrollWorkerConfig(config) {
  if (config.authToken) process.env.CLOUDAGENTFLEET_AUTH_TOKEN = config.authToken;
  let enrolledAll = true;
  for (const entry of workerProcesses(config)) {
    console.log(`Waiting for the Worker ${entry.nodeId} to connect to the Hub …`);
    if (!await waitForNode(config.controllerUrl, entry.nodeId)) {
      console.log(
        `The Worker ${entry.nodeId} did not connect. Check ${join(dirname(configPath), "worker.log")} `
        + "or `cloudagentfleet worker status`, then run init again.",
      );
      enrolledAll = false;
      continue;
    }
    const common = ["--controller-url", config.controllerUrl, "--node-id", entry.nodeId, "--no-health"];
    const enrollments = [];
    if (entry.backends.includes("codeman")) {
      const env = workerEnvironment(entry);
      const policy = env.CLOUDAGENTFLEET_WORKSPACE_MODE === "system"
        ? ["--workspace-mode", "system"]
        : env.CLOUDAGENTFLEET_WORKSPACE_ROOTS.split(";").filter(Boolean).flatMap((root) => ["--workspace-root", root]);
      enrollments.push([
        "connector", "--backend", "codeman", ...common,
        "--instance-id", config.codemanInstanceId ?? config.nodeId,
        "--name", config.name,
        ...(policy.length > 0 ? policy : ["--workspace-mode", "system"]),
      ]);
    }
    if (entry.backends.includes("cptr") && config.cptrAccess === "connector") {
      enrollments.push([
        "connector", "--backend", "cptr", ...common,
        "--instance-id", config.cptrInstanceId ?? `${config.nodeId}-cptr`,
        "--name", `${config.name} (Open WebUI Computer)`,
      ]);
    }
    for (const argv of enrollments) {
      try {
        const instance = await enrollInstance(argv);
        // Enrolled before its backend finished starting: check until it answers.
        if (instance?.id && !await waitForInstanceOnline(config.controllerUrl, instance.id)) {
          console.log(`${instance.label} is enrolled but not answering yet; it will turn online once it has started.`);
        }
      } catch (error) {
        enrolledAll = false;
        console.log(`Enrollment did not finish: ${error instanceof Error ? error.message : error}`);
        console.log("Fix the cause, then run `cloudagentfleet init` again (it is safe to rerun).");
      }
    }
  }
  return enrolledAll;
}

async function startJob() {
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  const headers = {
    accept: "application/json",
    "content-type": "application/json",
    ...(config.authToken
      ? { authorization: `Bearer ${config.authToken}` }
      : process.env.CLOUDAGENTFLEET_AUTH_TOKEN
        ? { authorization: `Bearer ${process.env.CLOUDAGENTFLEET_AUTH_TOKEN}` }
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
    "  cloudagentfleet init             Guided setup: pick Hub/Worker/both and what to install, enroll, done",
    "  cloudagentfleet setup [--run]  Configure only this machine's Worker, step by step",
    "  cloudagentfleet run              Run the saved Codeman-backed Worker",
    "  cloudagentfleet worker <install|start|status|stop|remove>  Manage the user service",
    "  cloudagentfleet start            Select Worker, workspace, agent, and prompt",
    "  cloudagentfleet enroll           Register a Codeman instance and verify health",
    "  cloudagentfleet hub service <install|start|status|stop|remove>  Run the Hub as a user service",
    "  cloudagentfleet hub token        Print the Worker token new machines need",
    "  cloudagentfleet hub run          Run the Hub in this terminal",
    "  cloudagentfleet hub <serve|status|stop>  Publish the Hub privately with Tailscale Serve",
    "  cloudagentfleet doctor           Print local prerequisites",
    "",
    "The setup flow asks before installing Codeman and never performs provider login.",
  ].join("\n"));
}

function isDirectCliEntrypoint() {
  const entry = process.argv[1];
  if (!entry) return false;
  // npm installs the bin as a symlink without the .mjs (…/bin/cloudagentfleet), so compare real paths.
  let real = resolve(entry);
  try {
    real = realpathSync(entry);
  } catch {
    // Keep the given path when it can't be resolved.
  }
  return (
    real.replaceAll("\\", "/").endsWith("/cloudagentfleet.mjs")
    || real === resolve(fileURLToPath(import.meta.url))
  );
}

if (isDirectCliEntrypoint()) {
  try {
    const commandName = process.argv[2] ?? "help";
    migrateLegacyConfig();
    if (commandName !== "run" && legacyWorkerService()) {
      console.log("A legacy hosted-agents Worker service is still installed; run `cloudagentfleet worker install` to replace it.");
    }
    if (commandName === "init") await init();
    else if (commandName === "setup") await setup();
    else if (commandName === "run") await runSavedWorker({ restart: process.argv.includes("--restart"), log: process.argv.includes("--log") });
    else if (commandName === "worker") workerServiceAction(process.argv[3] ?? "status");
    else if (commandName === "doctor") printEnvironment(detectEnvironment());
    else if (commandName === "start") await startJob();
    else if (commandName === "enroll") await enrollInstance();
    else if (commandName === "hub") await hubCommand(process.argv.slice(3));
    else help();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  } finally {
    rl?.close();
  }
}
