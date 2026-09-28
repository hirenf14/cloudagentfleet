import assert from "node:assert/strict";
import test from "node:test";
import { resolve } from "node:path";
import {
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
    HOSTED_AGENTS_HOST: "127.0.0.1",
  }), {
    host: "127.0.0.1",
    port: 9443,
  });
  assert.throws(
    () => parseHubOptions(["--port", "9443;tailscale serve funnel"], {}),
    /port must be a number/,
  );
  assert.throws(
    () => parseHubOptions([], { HOSTED_AGENTS_HOST: "0.0.0.0" }),
    /requires a loopback bind address/,
  );
});

test("Hub lifecycle invokes Tailscale with argument arrays and one loopback origin", async () => {
  const calls = [];
  const runner = (command, args, options) => {
    calls.push({ command, args, options });
    return { status: 0, stdout: "Serve status", stderr: "" };
  };
  const env = { HOSTED_AGENTS_HOST: "127.0.0.1", HOSTED_AGENTS_PORT: "8787" };
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
    ["version"],
    ["status"],
    ["serve", "status"],
    ["version"],
    ["serve", "reset"],
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
      env: { HOSTED_AGENTS_HOST: "127.0.0.1", HOSTED_AGENTS_PORT: "8787" },
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
