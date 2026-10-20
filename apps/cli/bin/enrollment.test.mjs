import assert from "node:assert/strict";
import test from "node:test";
import { resolve } from "node:path";
import {
  cptrInstallCommand,
  enrollInstance,
  parseBackendList,
  parseCptrAccess,
  workerEnvironment,
  workerProcesses,
  windowsWorkerTaskXml,
  wslWorkerCommandLine,
  parseComponentPicks,
  parseInitRole,
  defaultHubConfig,
  hubEnvironment,
  parseAgentProfiles,
  parseOptions,
  safeEndpoint,
  systemdEnvironmentLine,
  parseHubOptions,
  runTailscale,
  serveHub,
  statusHub,
  stopHub,
  discoverWorkspaces,
  workspacePolicyFromOptions,
} from "./setup.mjs";

test("enrollment options preserve repeatable workspace and agent flags", () => {
  const parsed = parseOptions([
    "connector",
    "--instance-id",
    "codeman-a",
    "--workspace-root",
    "C:/workspaces/a",
    "--workspace-root=C:/workspaces/b",
    "--agent-mode",
    "claude,shell",
    "--agent-profile",
    "custom:Custom Agent:codex:false",
  ]);

  assert.deepEqual(workspacePolicyFromOptions(parsed), {
    mode: "folders",
    roots: [resolve("C:/workspaces/a"), resolve("C:/workspaces/b")],
  });
  assert.deepEqual(parseAgentProfiles(parsed), [
    { id: "claude", name: "Claude Code", mode: "claude", ready: true },
    { id: "shell", name: "shell", mode: "shell", ready: true },
    { id: "custom", name: "Custom Agent", mode: "codex", ready: false },
  ]);
});

test("enrollment endpoint validation rejects unsafe URLs", () => {
  assert.equal(safeEndpoint("https://codeman.example.test/", "URL"), "https://codeman.example.test");
  assert.throws(
    () => safeEndpoint("http://public.example.test", "URL"),
    /must use HTTPS/,
  );
  assert.throws(
    () => safeEndpoint("https://user:pass@codeman.example.test", "URL"),
    /embedded credentials/,
  );
  // Loopback is allowed in tailscale-url mode, like the Hub, for a Hub on the same machine.
  assert.equal(safeEndpoint("http://127.0.0.1:8000", "URL", true), "http://127.0.0.1:8000");
  assert.throws(
    () => safeEndpoint("http://100.100.10.20:3000", "URL", true),
    /must use HTTPS/,
  );
  assert.equal(
    safeEndpoint("https://100.100.10.20:3000", "URL", true),
    "https://100.100.10.20:3000",
  );
  assert.throws(
    () => safeEndpoint("https://codeman.example.test", "URL", true),
    /Tailscale/,
  );
});

test("workspace discovery assigns distinct stable IDs to nested folders", () => {
  const workspaces = discoverWorkspaces({
    mode: "folders",
    roots: [resolve("C:/workspaces/project")],
  }, true);
  assert.equal(new Set(workspaces.map((workspace) => workspace.id)).size, workspaces.length);
});

test("Hub serving accepts only loopback configuration and numeric ports", () => {
  assert.deepEqual(parseHubOptions(["--port", "9443"], {
    CLOUDAGENTFLEET_HOST: "127.0.0.1",
  }), {
    host: "127.0.0.1",
    port: 9443,
    hostPort: 9444,
  });
  assert.equal(parseHubOptions(["--host-port", "9000"], {}).hostPort, 9000);
  assert.throws(() => parseHubOptions(["--host-port", "x"], {}), /Host UI port must be a number/);
  assert.throws(
    () => parseHubOptions(["--port", "9443;tailscale serve funnel"], {}),
    /port must be a number/,
  );
  assert.throws(
    () => parseHubOptions([], { CLOUDAGENTFLEET_HOST: "0.0.0.0" }),
    /requires a loopback bind address/,
  );
});

test("Hub lifecycle invokes Tailscale with argument arrays and one loopback origin", async () => {
  const calls = [];
  const runner = (command, args, options) => {
    calls.push({ command, args, options });
    return { status: 0, stdout: "Serve status", stderr: "" };
  };
  const env = { CLOUDAGENTFLEET_HOST: "127.0.0.1", CLOUDAGENTFLEET_PORT: "8787" };
  const fetchImpl = async (url, options) => {
    assert.equal(url, "http://127.0.0.1:8787/healthz");
    assert.deepEqual(options.headers, {});
    return { ok: true };
  };

  await serveHub([], { env, runner, fetchImpl });
  statusHub([], { env, runner });
  stopHub([], { env, runner });

  assert.deepEqual(calls.map(({ args }) => args), [
    ["version"],
    ["status"],
    ["serve", "--bg", "http://127.0.0.1:8787"],
    ["serve", "--bg", "--https=8443", "http://127.0.0.1:8788"],
    ["version"],
    ["status"],
    ["serve", "status"],
    ["version"],
    ["serve", "--https=443", "off"],
    ["serve", "--https=8443", "off"],
  ]);
  assert.ok(calls.every(({ options }) => options.shell === false));
});

test("Hub serving reports missing Tailscale and refuses an unhealthy Hub", async () => {
  assert.throws(
    () => runTailscale(["status"], () => ({ error: { code: "ENOENT" } })),
    /Tailscale CLI was not found/,
  );

  const calls = [];
  await assert.rejects(
    serveHub([], {
      env: { CLOUDAGENTFLEET_HOST: "127.0.0.1", CLOUDAGENTFLEET_PORT: "8787" },
      runner: (_command, args, options) => {
        calls.push({ args, options });
        return { status: 0, stdout: "", stderr: "" };
      },
      fetchImpl: async () => ({ ok: false, status: 503 }),
    }),
    /Hub is not reachable/,
  );
  assert.deepEqual(calls.map(({ args }) => args), [["version"], ["status"]]);
});

test("enroll rejects an unknown backend before prompting", async () => {
  await assert.rejects(
    () => enrollInstance(["tailscale-url", "--backend", "unknown"]),
    /--backend must be one of: codeman, cptr/,
  );
});

test("enroll allows cptr over the connector but not link-only there", async () => {
  await assert.rejects(
    () => enrollInstance(["connector", "--backend", "cptr", "--link-only"]),
    /--link-only needs a tailscale-url instance/,
  );
  assert.equal(parseCptrAccess(" Connector "), "connector");
  assert.equal(parseCptrAccess("tailnet"), "tailnet");
  assert.throws(() => parseCptrAccess("funnel"), /connector or tailnet/);
});

test("enroll accepts --link-only only for cptr", async () => {
  await assert.rejects(
    () => enrollInstance(["tailscale-url", "--link-only"]),
    /--link-only applies only to --backend cptr/,
  );
});

test("parseBackendList accepts codeman and cptr only", () => {
  assert.deepEqual(parseBackendList("codeman"), ["codeman"]);
  assert.deepEqual(parseBackendList(" CPTR , codeman,cptr "), ["cptr", "codeman"]);
  assert.throws(() => parseBackendList(""), /at least one backend/);
  assert.throws(() => parseBackendList("codeman,docker"), /Unsupported backend: docker/);
});

test("cptrInstallCommand prefers isolated installers over user pip", () => {
  const only = (...ok) => (probe) => ok.some((prefix) => probe.startsWith(prefix));
  assert.equal(cptrInstallCommand(only("pipx", "uv", "python3")), "pipx install cptr");
  assert.equal(cptrInstallCommand(only("uv", "python3")), "uv tool install cptr");
  assert.equal(cptrInstallCommand(only("py ")), "py -m pip install --user cptr");
  assert.equal(cptrInstallCommand(only()), undefined);
  // With Claude Code present, cptr gets the SDK it needs to drive it as a chat agent.
  assert.equal(cptrInstallCommand(only("uv"), { withClaude: true }), "uv tool install cptr --with claude-agent-sdk");
  assert.equal(cptrInstallCommand(only("pipx"), { withClaude: true }), "pipx install cptr && pipx inject cptr claude-agent-sdk");
  assert.equal(cptrInstallCommand(only("python3"), { withClaude: true }), "python3 -m pip install --user cptr claude-agent-sdk");
});

test("workerEnvironment turns off Codeman management on a cptr-only machine", () => {
  const env = workerEnvironment({
    nodeId: "laptop",
    name: "Laptop",
    controllerUrl: "http://127.0.0.1:8787",
    execution: "local",
    workspacePolicy: { mode: "folders", roots: ["/src"] },
    workspaces: [],
    backends: ["cptr"],
    codemanMode: "claude",
    codemanUrl: "http://127.0.0.1:3000",
    manageCodeman: false,
    installCodeman: false,
    cptrUrl: "http://127.0.0.1:8000",
    manageCptr: true,
  });
  assert.equal(env.CLOUDAGENTFLEET_BACKENDS, "cptr");
  assert.equal(env.CLOUDAGENTFLEET_MANAGE_CODEMAN, "false");
  assert.equal(env.CLOUDAGENTFLEET_CODEMAN_INSTALL, "false");
  assert.equal(env.CLOUDAGENTFLEET_CPTR_URL, "http://127.0.0.1:8000");
  assert.equal(env.CLOUDAGENTFLEET_MANAGE_CPTR, "true");
  assert.equal(env.CLOUDAGENTFLEET_CPTR_INSTANCE_ID, "laptop-cptr");

  const legacy = workerEnvironment({
    nodeId: "desk",
    name: "Desk",
    controllerUrl: "http://127.0.0.1:8787",
    execution: "local",
    workspacePolicy: { mode: "folders", roots: [] },
    workspaces: [],
    codemanMode: "claude",
    codemanUrl: "http://127.0.0.1:3000",
  });
  assert.equal(legacy.CLOUDAGENTFLEET_BACKENDS, "codeman");
  assert.equal(legacy.CLOUDAGENTFLEET_MANAGE_CODEMAN, "true");
  assert.equal(legacy.CLOUDAGENTFLEET_CPTR_URL, undefined);
});

test("the Worker service records the installer's PATH for systemd", () => {
  assert.equal(
    systemdEnvironmentLine("PATH", "/home/a/.local/bin:/usr/bin"),
    'Environment="PATH=/home/a/.local/bin:/usr/bin"',
  );
  assert.equal(systemdEnvironmentLine("PATH", '/odd "dir"/50%\\x'), 'Environment="PATH=/odd \\"dir\\"/50%%\\\\x"');
});

test("Codeman in WSL with cptr on Windows runs two Workers", () => {
  const config = {
    nodeId: "laptop",
    name: "Laptop",
    controllerUrl: "http://127.0.0.1:8787",
    execution: "wsl",
    cptrExecution: "local",
    backends: ["codeman", "cptr"],
    workspacePolicy: { mode: "folders", roots: ["E:\\work"] },
    workspaces: [],
    codemanMode: "shell",
    codemanUrl: "http://127.0.0.1:3000",
    cptrUrl: "http://127.0.0.1:8001",
  };
  const [wsl, windows] = workerProcesses(config);
  assert.equal(workerProcesses(config).length, 2);
  assert.deepEqual([wsl.nodeId, wsl.execution, wsl.backends], ["laptop", "wsl", ["codeman"]]);
  assert.equal(workerEnvironment(wsl).CLOUDAGENTFLEET_CPTR_URL, undefined);
  assert.equal(workerEnvironment(wsl).CLOUDAGENTFLEET_WORKSPACE_ROOTS, "/mnt/e/work");
  assert.deepEqual([windows.nodeId, windows.execution, windows.backends], ["laptop-windows", "local", ["cptr"]]);
  const env = workerEnvironment(windows);
  assert.equal(env.CLOUDAGENTFLEET_BACKENDS, "cptr");
  assert.equal(env.CLOUDAGENTFLEET_CPTR_INSTANCE_ID, "laptop-cptr");
  assert.equal(env.CLOUDAGENTFLEET_CPTR_URL, "http://127.0.0.1:8001");
  assert.equal(env.CLOUDAGENTFLEET_WORKSPACE_ROOTS, "E:\\work");

  // One placement (or a single backend) keeps one Worker.
  assert.equal(workerProcesses({ ...config, cptrExecution: "wsl" }).length, 1);
  assert.equal(workerProcesses({ ...config, backends: ["cptr"], execution: "local" }).length, 1);
  assert.equal(workerProcesses({ ...config, cptrExecution: undefined }).length, 1);
});

test("the Windows Worker task needs no admin and runs headless with restarts", () => {
  const task = windowsWorkerTaskXml("PC\\op & co", "C:\\node\\node.exe", ["C:\\caf\\cli.mjs", "run", "--restart"]);
  assert.ok(task.includes("<LogonTrigger><Enabled>true</Enabled><UserId>PC\\op &amp; co</UserId></LogonTrigger>"));
  assert.ok(task.includes("<RunLevel>LeastPrivilege</RunLevel>"));
  assert.ok(task.includes("<Command>conhost.exe</Command>"));
  assert.ok(task.includes(
    "<Arguments>&quot;--headless&quot; &quot;C:\\node\\node.exe&quot; &quot;C:\\caf\\cli.mjs&quot; "
    + "&quot;run&quot; &quot;--restart&quot;</Arguments>",
  ));
});

test("the WSL Worker command exports its settings to node", () => {
  const line = wslWorkerCommandLine("E:/caf/dist/worker.mjs", { CLOUDAGENTFLEET_NODE_ID: "it's-me" });
  assert.equal(
    line,
    "cd '/mnt/e/caf/dist' && export CLOUDAGENTFLEET_NODE_ID='it'\"'\"'s-me' && exec node '/mnt/e/caf/dist/worker.mjs'",
  );
});

test("init's checklist accepts numbers or names and needs a backend", () => {
  assert.deepEqual(parseComponentPicks("1,2"), ["codeman", "cptr"]);
  assert.deepEqual(parseComponentPicks("cptr, claude 1"), ["codeman", "cptr", "claude"]);
  assert.deepEqual(parseComponentPicks("2,4"), ["cptr", "cursor"]);
  assert.throws(() => parseComponentPicks("3,4"), /needs at least one/);
  assert.throws(() => parseComponentPicks("9"), /Unknown choice/);
});

test("init offers only the roles this install contains", () => {
  assert.equal(parseInitRole("Both", ["hub", "worker", "both"]), "both");
  assert.equal(parseInitRole("worker", ["worker"]), "worker");
  assert.throws(() => parseInitRole("hub", ["worker"]), /Choose one of: worker/);
});

test("the Hub service keeps its state in the user's folder", () => {
  const config = defaultHubConfig("/home/op");
  assert.deepEqual(hubEnvironment(config), {
    CLOUDAGENTFLEET_HOST: "127.0.0.1",
    CLOUDAGENTFLEET_PORT: "8787",
    CLOUDAGENTFLEET_DATA_PATH: config.dataPath,
  });
  assert.equal(hubEnvironment({ ...config, publicUrl: "https://hub.example.ts.net" }).CLOUDAGENTFLEET_PUBLIC_URL, "https://hub.example.ts.net");
  assert.match(config.dataPath.replaceAll("\\", "/"), /\/home\/op\/\.cloudagentfleet\/hub\.json$/);
});

test("each service's Windows task carries its own description", () => {
  assert.ok(windowsWorkerTaskXml("PC\op", "node.exe", ["cli.mjs", "hub", "run"], "Cloud Agent Fleet Hub")
    .includes("<Description>Cloud Agent Fleet Hub</Description>"));
});
