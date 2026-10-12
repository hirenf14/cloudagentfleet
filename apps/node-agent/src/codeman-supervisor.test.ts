import assert from "node:assert/strict";
import test from "node:test";
import type { SpawnSyncReturns } from "node:child_process";
import { join } from "node:path";
import {
  codemanInstallEnabled,
  detectCodemanBinary,
  ensureCodeman,
  manageCodemanEnabled,
} from "./codeman-supervisor.ts";

function okSpawn(stdout = ""): SpawnSyncReturns<string> {
  return {
    status: 0,
    signal: null,
    output: [null, stdout, ""],
    pid: 1,
    stdout,
    stderr: "",
    error: undefined,
  };
}

function failSpawn(stderr = "fail"): SpawnSyncReturns<string> {
  return {
    status: 1,
    signal: null,
    output: [null, "", stderr],
    pid: 1,
    stdout: "",
    stderr,
    error: undefined,
  };
}

test("manageCodemanEnabled defaults to true", () => {
  assert.equal(manageCodemanEnabled({}), true);
  assert.equal(manageCodemanEnabled({ HOSTED_AGENTS_MANAGE_CODEMAN: "false" }), false);
  assert.equal(manageCodemanEnabled({ HOSTED_AGENTS_MANAGE_CODEMAN: "1" }), true);
});

test("codemanInstallEnabled defaults to true", () => {
  assert.equal(codemanInstallEnabled({}), true);
  assert.equal(codemanInstallEnabled({ HOSTED_AGENTS_CODEMAN_INSTALL: "off" }), false);
});

test("detectCodemanBinary finds PATH hit on native platforms", () => {
  const binary = detectCodemanBinary({
    platformImpl: "linux",
    runCommand: (commandName, args) => {
      assert.equal(commandName, "sh");
      assert.ok(args.includes("command -v codeman"));
      return okSpawn("/usr/local/bin/codeman\n");
    },
  });
  assert.equal(binary, "/usr/local/bin/codeman");
});

test("detectCodemanBinary falls back to ~/.local/bin when PATH misses", () => {
  const expected = join("/home/op", ".local", "bin", "codeman");
  const binary = detectCodemanBinary({
    platformImpl: "linux",
    homedirImpl: () => "/home/op",
    pathExists: (path) => path === expected,
    runCommand: () => failSpawn("not found"),
  });
  assert.equal(binary, expected);
});

test("ensureCodeman leaves a reachable Codeman alone", async () => {
  const commands: string[] = [];
  const handle = await ensureCodeman({
    baseUrl: "http://127.0.0.1:3000",
    fetchImpl: (async () => new Response("{}", { status: 200 })) as typeof fetch,
    runCommand: (commandName) => {
      commands.push(commandName);
      return failSpawn();
    },
    log: () => {},
  });
  assert.equal(handle.startedByUs, false);
  assert.deepEqual(commands, []);
  handle.stopIfOwned();
  assert.deepEqual(commands, []);
});

test("ensureCodeman starts Codeman when down and stops only when owned", async () => {
  let reachable = false;
  const commands: Array<{ commandName: string; args: string[] }> = [];
  const handle = await ensureCodeman({
    baseUrl: "http://127.0.0.1:3000",
    platformImpl: "linux",
    installIfMissing: false,
    readyTimeoutMs: 2_000,
    pollIntervalMs: 10,
    sleep: async () => {},
    log: () => {},
    fetchImpl: (async () => {
      if (!reachable) throw new Error("down");
      return new Response("{}", { status: 200 });
    }) as typeof fetch,
    runCommand: (commandName, args) => {
      commands.push({ commandName, args });
      const joined = args.join(" ");
      if (joined.includes("command -v codeman")) {
        return okSpawn("/usr/bin/codeman\n");
      }
      if (joined.includes("codeman web -d")) {
        reachable = true;
        return okSpawn();
      }
      if (joined.includes("codeman web --stop")) {
        return okSpawn();
      }
      return failSpawn(`unexpected: ${commandName} ${joined}`);
    },
  });

  assert.equal(handle.startedByUs, true);
  assert.ok(commands.some((entry) => entry.args.join(" ").includes("codeman web -d")));
  handle.stopIfOwned();
  assert.ok(commands.some((entry) => entry.args.join(" ").includes("codeman web --stop")));
});

test("ensureCodeman skips install when binary is present", async () => {
  let reachable = false;
  const commands: string[] = [];
  await ensureCodeman({
    baseUrl: "http://127.0.0.1:3000",
    platformImpl: "linux",
    installIfMissing: true,
    readyTimeoutMs: 1_000,
    pollIntervalMs: 5,
    sleep: async () => {},
    log: () => {},
    fetchImpl: (async () => {
      if (!reachable) throw new Error("down");
      return new Response("{}", { status: 200 });
    }) as typeof fetch,
    runCommand: (commandName, args) => {
      const joined = `${commandName} ${args.join(" ")}`;
      commands.push(joined);
      if (joined.includes("command -v codeman")) return okSpawn("/usr/bin/codeman\n");
      if (joined.includes("codeman web -d")) {
        reachable = true;
        return okSpawn();
      }
      return failSpawn(joined);
    },
  });
  assert.ok(!commands.some((line) => line.includes("getcodeman.com/install")));
});

test("ensureCodeman fails clearly when install is disabled and binary missing", async () => {
  await assert.rejects(
    () =>
      ensureCodeman({
        baseUrl: "http://127.0.0.1:3000",
        platformImpl: "linux",
        installIfMissing: false,
        log: () => {},
        fetchImpl: (async () => {
          throw new Error("down");
        }) as typeof fetch,
        runCommand: () => failSpawn("missing"),
        pathExists: () => false,
      }),
    /HOSTED_AGENTS_CODEMAN_INSTALL=false|not installed/i,
  );
});
