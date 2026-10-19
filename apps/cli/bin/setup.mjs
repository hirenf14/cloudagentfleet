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
  await checkLocalHub(config.port, env.CLOUDAGENTFLEET_AUTH_TOKEN, dependencies.fetchImpl ?? fetch);
  const target = `http://127.0.0.1:${config.port}`;
  runTailscale(["serve", "--bg", target], runner);
  console.log(`Serving the single Cloud Agent Fleet Hub privately at ${target} through Tailscale.`);
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
  console.log("Tailscale Serve routes reset; the Cloud Agent Fleet Hub is no longer served.");
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
    tmux: canRun("tmux") || (wsl && wslCanRun(["-e", "bash", "-lc", "command -v tmux"])),
    docker: canRun("docker"),
    claudeCli: canRun("claude") || (wsl && wslCanRun(["-e", "bash", "-lc", "command -v claude"])),
    cptr: windows && wsl && !inWsl
      ? wslCanRun(["-e", "bash", "-lc", "command -v cptr"])
      : canRun("cptr", ["--help"]),
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

const cptrLicenseUrl = "https://github.com/open-webui/computer/blob/main/LICENSE";
const cptrTailnetPort = 8443;

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
export function cptrInstallCommand(available) {
  if (available("pipx --version")) return "pipx install cptr";
  if (available("uv --version")) return "uv tool install cptr";
  for (const python of ["python3", "python", "py"]) {
    if (available(`${python} -m pip --version`)) return `${python} -m pip install --user cptr`;
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
  );
  if (!installCommand) {
    console.log("No pipx, uv, or pip was found where the Worker runs. Install Python 3.10+ (and pipx), then rerun setup.");
    return false;
  }
  if (!await confirm(`Install Open WebUI Computer with \`${installCommand}\`?`, true)) return false;
  const result = runWhereWorkerRuns(environment, installCommand, { timeout: 10 * 60 * 1000, capture: false });
  if (result.status !== 0) return false;
  if (runWhereWorkerRuns(environment, "cptr --help").status !== 0) {
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

function runWorker(config) {
  const env = workerEnvironment(config);
  const workerScript = resolveWorkerScript();
  const runtimeRoot = dirname(workerScript);
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
  console.log("Cloud Agent Fleet setup\n=======================\n");
  printEnvironment(environment);
  if (!environment.node || !environment.git) throw new Error("Node.js and Git are required");

  const selectedBackends = parseBackendList(
    await ask("\nBackends on this machine (codeman, cptr, or codeman,cptr)", "codeman"),
  );
  const useCodeman = selectedBackends.includes("codeman");
  const useCptr = selectedBackends.includes("cptr");

  if (useCodeman && !environment.codeman) {
    const installed = await installCodeman(environment);
    if (installed) environment.codeman = true;
  }
  if (useCodeman && !environment.codeman) {
    console.log(
      "Codeman is not on PATH yet. The Worker will install/start it on run "
      + "(set manageCodeman/installCodeman false in worker.json to opt out).",
    );
  }
  if (useCodeman && !environment.cursorCli) {
    const installed = await installCursorCli(environment);
    if (installed) environment.cursorCli = true;
  }
  if (useCptr && !environment.cptr) {
    environment.cptr = await installCptr(environment);
  }

  const controllerUrl = await ask("\nController URL", "http://127.0.0.1:8787");
  const nodeId = await ask("Worker ID", hostname().toLowerCase().replaceAll(/[^a-z0-9-]/g, "-"));
  const name = await ask("Worker display name", hostname());
  const workspacePolicy = await selectFolders();
  const codemanMode = useCodeman
    ? await ask(`Codeman mode (${modes.join(", ")})`, "claude")
    : "claude";
  if (!modes.includes(codemanMode)) throw new Error(`Unsupported Codeman mode: ${codemanMode}`);
  const codemanUrl = useCodeman ? await ask("Codeman URL", "http://127.0.0.1:3000") : "http://127.0.0.1:3000";
  const cptrUrl = useCptr
    ? safeEndpoint(await ask("Open WebUI Computer local URL", "http://127.0.0.1:8000"), "Open WebUI Computer URL")
    : undefined;
  const authToken = process.env.CLOUDAGENTFLEET_AUTH_TOKEN;
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
    backends: selectedBackends,
    codemanMode,
    codemanUrl,
    manageCodeman: useCodeman,
    installCodeman: useCodeman,
    ...(cptrUrl ? { cptrUrl, manageCptr: true } : {}),
  };

  mkdirSync(dirname(configPath), { recursive: true });
  writeSafeJson(configPath, config);
  console.log(`\nSaved Worker configuration: ${configPath}`);
  console.log(`Discovered ${config.workspaces.length} workspace(s).`);

  if (useCptr) {
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
      "The Worker prints a one-time setup token on cptr's first start; open the host from the dashboard and visit /?token=<token>.",
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
    runWorker(config);
  } else {
    console.log("Run `cloudagentfleet run` to start the Worker.");
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
  const backend = optionValue(parsed, "backend") ?? "codeman";
  if (!backends.includes(backend)) {
    throw new Error(`--backend must be one of: ${backends.join(", ")}`);
  }
  const selectedMode = optionValue(parsed, "mode") ?? parsed.positionals[0]
    ?? await ask("Connection mode (connector or tailscale-url)", "connector");
  if (selectedMode !== "connector" && selectedMode !== "tailscale-url") {
    throw new Error("--mode must be connector or tailscale-url");
  }
  if (backend === "cptr" && selectedMode !== "tailscale-url") {
    throw new Error("Open WebUI Computer (cptr) supports only tailscale-url mode");
  }
  const linkOnly = parsed.values.has("link-only");
  if (linkOnly && backend !== "cptr") throw new Error("--link-only applies only to --backend cptr");

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
    console.log(`Updated Worker configuration with CLOUDAGENTFLEET_CODEMAN_INSTANCE_ID=${registration.id}. Restart the Worker to apply it.`);
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
    "  --backend <codeman|cptr>                   default codeman; cptr = Open WebUI Computer (tailscale-url only)",
    "  --link-only                                cptr: open it directly instead of through the Hub",
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
    "Serve the single Cloud Agent Fleet Hub privately through Tailscale Serve.",
    "",
    "Usage:",
    "  cloudagentfleet hub serve [--port <1-65535>]",
    "  cloudagentfleet hub status [--port <1-65535>]",
    "  cloudagentfleet hub stop  [--port <1-65535>]",
    "",
    "The Controller must already be running on 127.0.0.1 (default port 8787).",
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
      path: join(homedir(), ".config", "systemd", "user", "cloudagentfleet-worker.service"),
      name: "cloudagentfleet-worker.service",
    };
  }
  if (process.platform === "darwin") {
    return {
      kind: "launchd",
      path: join(homedir(), "Library", "LaunchAgents", "com.cloudagentfleet.worker.plist"),
      name: "com.cloudagentfleet.worker",
    };
  }
  return { kind: "schtasks", path: null, name: "Cloud Agent Fleet Worker" };
}

/**
 * One-time move from the pre-rename install layout (~/.hosted-agents and the
 * hosted-agents user service). Safe to remove once no pre-0.2 installs remain.
 */
function migrateLegacyInstall() {
  const legacyDir = join(homedir(), ".hosted-agents");
  const currentDir = dirname(configPath);
  if (existsSync(legacyDir) && !existsSync(currentDir)) {
    renameSync(legacyDir, currentDir);
    console.log(`Moved configuration from ${legacyDir} to ${currentDir}`);
  }
  const legacyService = process.platform === "linux"
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
  if (!legacyService || !existsSync(legacyService.path)) return;
  if (legacyService.kind === "systemd") {
    command("systemctl", ["--user", "disable", "--now", legacyService.name], { capture: true });
  } else {
    command("launchctl", ["unload", legacyService.path], { capture: true });
  }
  unlinkSync(legacyService.path);
  if (legacyService.kind === "systemd") {
    command("systemctl", ["--user", "daemon-reload"], { capture: true });
  }
  console.log(`Removed legacy Worker service ${legacyService.name}; run \`cloudagentfleet worker install\` to reinstall it.`);
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
      "Description=Cloud Agent Fleet Worker",
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
      `<key>ProgramArguments</key><array><string>${xml(executable)}</string><string>${xml(script)}</string><string>${action}</string></array>`,
      "<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>",
      "</dict></plist>",
      "",
    ].join("\n"), { mode: 0o600 });
    serviceCommand("launchctl", ["load", "-w", service.path]);
  } else {
    const taskCommand = `"${executable.replaceAll('"', '""')}" "${script.replaceAll('"', '""')}" ${action}`;
    serviceCommand("schtasks.exe", [
      "/Create", "/TN", service.name, "/TR", taskCommand, "/SC", "ONLOGON", "/RL", "LIMITED", "/F",
    ]);
  }
  console.log(`Installed user-level Worker service: ${service.name}`);
}

/**
 * Native command for each service action. `status` reports instead of
 * failing, because an inactive service is a valid answer.
 */
function workerServiceArgs(service, action) {
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

function workerServiceAction(action) {
  if (action === "install") {
    installWorkerService();
    return;
  }
  if (!["start", "stop", "status", "remove"].includes(action)) {
    throw new Error(`Unknown worker command: ${action} (use install, start, stop, status, or remove)`);
  }
  const service = workerServicePaths();
  const [executable, args] = workerServiceArgs(service, action);
  if (action === "status") {
    const result = command(executable, args, { capture: false });
    if (result.status !== 0) console.log(`Worker service ${service.name} is not running or not installed.`);
    return;
  }
  serviceCommand(executable, args);
  if (action === "remove" && service.path && existsSync(service.path)) {
    unlinkSync(service.path);
    if (service.kind === "systemd") serviceCommand("systemctl", ["--user", "daemon-reload"]);
  }
  console.log(`Worker service ${action} complete.`);
}

function serviceCommand(executable, args) {
  const result = command(executable, args, { capture: false });
  if (result.status !== 0) throw new Error(`${executable} ${args.join(" ")} failed`);
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
    "  cloudagentfleet setup [--run]  Detect, select, configure, and optionally run",
    "  cloudagentfleet run              Run the saved Codeman-backed Worker",
    "  cloudagentfleet worker <install|start|status|stop|remove>  Manage the user service",
    "  cloudagentfleet start            Select Worker, workspace, agent, and prompt",
    "  cloudagentfleet enroll           Register a Codeman instance and verify health",
    "  cloudagentfleet hub <serve|status|stop>  Manage private Tailscale Hub serving",
    "  cloudagentfleet doctor           Print local prerequisites",
    "",
    "The setup flow asks before installing Codeman and never performs provider login.",
  ].join("\n"));
}

function isDirectCliEntrypoint() {
  const entry = process.argv[1];
  if (!entry) return false;
  const normalized = entry.replaceAll("\\", "/");
  return (
    normalized.endsWith("/cloudagentfleet.mjs")
    || resolve(entry) === resolve(fileURLToPath(import.meta.url))
  );
}

if (isDirectCliEntrypoint()) {
  try {
    const commandName = process.argv[2] ?? "help";
    migrateLegacyInstall();
    if (commandName === "setup") await setup();
    else if (commandName === "run") runSavedWorker();
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
