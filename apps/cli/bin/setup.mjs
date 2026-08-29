import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const configPath = join(homedir(), ".hosted-agents", "worker.json");
const modes = ["claude", "shell", "opencode", "codex", "gemini", "antigravity", "pi", "grok", "deepseek"];

function command(commandName, args = [], options = {}) {
  return spawnSync(commandName, args, {
    encoding: "utf8",
    timeout: options.timeout ?? 3000,
    stdio: options.capture === false ? "inherit" : ["ignore", "pipe", "pipe"],
    shell: options.shell ?? (process.platform === "win32"),
  });
}

function canRun(commandName, args = ["--version"]) {
  return command(commandName, args).status === 0;
}

function wslCanRun(args = ["-e", "true"]) {
  const probe = args.length === 2 && args[0] === "-e" && args[1] === "true"
    ? ["-e", "bash", "-lc", "printf hosted-agents-wsl-ready"]
    : args;
  const result = process.platform === "win32"
    ? command("wsl.exe", probe, { timeout: 5000, shell: false })
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
  const answer = await rl.question(`${question}${defaultValue ? ` [${defaultValue}]` : ""}: `);
  return answer.trim() || defaultValue;
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

function discoverWorkspaces(policy, codemanReady) {
  const roots = policy.mode === "system" ? [process.cwd()] : policy.roots;
  const paths = new Set();
  for (const root of roots) {
    paths.add(resolve(root));
    for (const child of listDirectories(root)) paths.add(resolve(child));
  }
  return [...paths].map((canonicalPath) => ({
    id: Buffer.from(canonicalPath).toString("base64url").slice(0, 24),
    name: canonicalPath.split(/[\\/]/).filter(Boolean).at(-1) ?? "workspace",
    canonicalPath,
    health: "ready",
    providers: { codeman: codemanReady ? "ready" : "missing" },
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
    ? ["-e", "bash", "-lc", "curl -fsSL https://getcodeman.com/install | bash"]
    : ["-lc", "curl -fsSL https://getcodeman.com/install | bash"];
  const result = command(environment.execution === "wsl" ? "wsl.exe" : "bash", args, {
    timeout: 10 * 60 * 1000,
    capture: false,
    shell: environment.execution !== "wsl",
  });
  return result.status === 0;
}

function startCodeman(environment) {
  const args = environment.execution === "wsl" ? ["-e", "bash", "-lc", "codeman web -d"] : ["-lc", "codeman web -d"];
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
    CODEMAN_URL: config.codemanUrl,
  };
}

function runWorker(config) {
  const env = workerEnvironment(config);
  const workerScript = join(repoRoot, "apps/node-agent/src/main.ts");
  if (config.execution !== "wsl") {
    return spawn(process.execPath, ["--experimental-strip-types", workerScript], {
      cwd: repoRoot,
      env: { ...process.env, ...env },
      stdio: "inherit",
    });
  }

  const commandLine = [
    `cd ${shellQuote(toWslPath(repoRoot))}`,
    ...Object.entries(env).map(([key, value]) => `${key}=${shellQuote(value)}`),
    `exec node --experimental-strip-types apps/node-agent/src/main.ts`,
  ].join(" && ");
  return spawn("wsl.exe", ["-e", "bash", "-lc", commandLine], {
    cwd: repoRoot,
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
    workspaces: discoverWorkspaces(workspacePolicy, environment.codeman),
    codemanMode,
    codemanUrl,
  };

  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
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

function runSavedWorker() {
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  runWorker(config);
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
    "Hosted Agents CLI",
    "",
    "Usage:",
    "  hosted-agents setup [--run]  Detect, select, configure, and optionally run",
    "  hosted-agents run              Run the saved Codeman-backed Worker",
    "  hosted-agents start            Select Worker, workspace, agent, and prompt",
    "  hosted-agents check            Print local prerequisites",
    "",
    "The setup flow asks before installing Codeman and never performs provider login.",
  ].join("\n"));
}

const rl = createInterface({ input: process.stdin, output: process.stdout });
try {
  const commandName = process.argv[2] ?? "help";
  if (commandName === "setup") await setup();
  else if (commandName === "run") runSavedWorker();
  else if (commandName === "start") await startJob();
  else if (commandName === "check") printEnvironment(detectEnvironment());
  else help();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  rl.close();
}
