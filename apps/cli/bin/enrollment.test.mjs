import assert from "node:assert/strict";
import test from "node:test";
import { resolve } from "node:path";
import {
  cptrInstallCommand,
  enrollInstance,
  parseBackendList,
  workerEnvironment,
  parseAgentProfiles,
  parseOptions,
  safeEndpoint,
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
  assert.throws(
    () => safeEndpoint("http://127.0.0.1:3000", "URL", true),
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

test("enroll keeps cptr to tailscale-url mode", async () => {
  await assert.rejects(
    () => enrollInstance(["connector", "--backend", "cptr"]),
    /supports only tailscale-url mode/,
  );
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
