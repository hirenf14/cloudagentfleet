import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { ensureCptr, resolveCptrCommand } from "./cptr-supervisor.ts";
import { backendSupervisors, workerBackends } from "./supervisor.ts";

const TOKEN = "ab".repeat(32);

function fakeChild(): ChildProcess & { killed: boolean } {
  const child = new EventEmitter() as ChildProcess & { killed: boolean };
  Object.assign(child, {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    killed: false,
    kill() {
      child.killed = true;
      return true;
    },
  });
  return child;
}

function fakeFetch(state: { up: boolean; needsSetup: boolean }): typeof fetch {
  return (async (url: string | URL | Request) => {
    const path = new URL(String(url)).pathname;
    if (!state.up) throw new Error("ECONNREFUSED");
    if (path === "/api/health") return Response.json({ status: "ok" });
    if (path === "/api/config") return Response.json({ needs_setup: state.needsSetup });
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
}

test("ensureCptr leaves an already-running cptr alone", async () => {
  const handle = await ensureCptr({
    fetchImpl: fakeFetch({ up: true, needsSetup: false }),
    spawnImpl: () => assert.fail("must not spawn"),
    log: () => undefined,
  });
  assert.equal(handle.startedByUs, false);
});

test("ensureCptr starts cptr on loopback, captures the setup token, and owns the process", async () => {
  const directory = mkdtempSync(join(tmpdir(), "cloudagentfleet-cptr-"));
  try {
    const state = { up: false, needsSetup: true };
    const child = fakeChild();
    const spawned: string[][] = [];
    let spawnEnv: NodeJS.ProcessEnv | undefined;
    const logs: string[] = [];
    const handle = await ensureCptr({
      baseUrl: "http://127.0.0.1:8123",
      logPath: join(directory, "cptr.log"),
      autoSetup: false,
      fetchImpl: fakeFetch(state),
      spawnImpl: (command, args, options) => {
        spawned.push([command, ...args]);
        spawnEnv = options.env;
        setTimeout(() => {
          (child.stdout as PassThrough).write(`\n  ➜  http://127.0.0.1:8123/?token=${TOKEN}\n`);
          state.up = true;
        }, 5);
        return child;
      },
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, Math.min(ms, 5))),
      log: (message) => logs.push(message),
    });
    assert.deepEqual(spawned, [["cptr", "run", "--headless", "--host", "127.0.0.1", "--port", "8123"]]);
    assert.equal(spawnEnv?.PYTHONIOENCODING, "utf-8", "cptr's output must not depend on the Windows code page");
    assert.equal(handle.startedByUs, true);
    assert.ok(!logs.some((line) => line.includes(TOKEN)), "the setup token must never be printed");
    assert.ok(logs.some((line) => line.includes("cptr-setup-token")), "the token file location is printed");
    assert.equal(readFileSync(join(directory, "cptr-setup-token"), "utf8").trim(), TOKEN);
    const log = readFileSync(join(directory, "cptr.log"), "utf8");
    assert.ok(!log.includes(TOKEN), "the token is redacted from cptr.log");
    assert.match(log, /token=<redacted/);
    handle.stopIfOwned();
    assert.equal(child.killed, true);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("ensureCptr refuses to start a non-loopback cptr and explains a missing install", async () => {
  await assert.rejects(
    () => ensureCptr({
      baseUrl: "https://laptop.tailnet.ts.net",
      fetchImpl: fakeFetch({ up: false, needsSetup: false }),
      log: () => undefined,
    }),
    /only starts it on loopback HTTP/,
  );

  const directory = mkdtempSync(join(tmpdir(), "cloudagentfleet-cptr-"));
  try {
    await assert.rejects(
      () => ensureCptr({
        baseUrl: "http://127.0.0.1:8124",
        logPath: join(directory, "cptr.log"),
        fetchImpl: fakeFetch({ up: false, needsSetup: false }),
        spawnImpl: () => {
          const child = fakeChild();
          setTimeout(() => child.emit("error", Object.assign(new Error("spawn cptr ENOENT"), { code: "ENOENT" })), 1);
          return child;
        },
        sleep: (ms) => new Promise((resolve) => setTimeout(resolve, Math.min(ms, 5))),
        log: () => undefined,
      }),
      /is not installed/,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("workerBackends parses the backend list and supervisors honour manage flags", () => {
  assert.deepEqual(workerBackends({}), ["codeman"]);
  assert.deepEqual(workerBackends({ CLOUDAGENTFLEET_BACKENDS: "codeman, cptr,cptr" }), ["codeman", "cptr"]);
  assert.throws(() => workerBackends({ CLOUDAGENTFLEET_BACKENDS: "codeman,nope" }), /nope/);
  assert.deepEqual(
    backendSupervisors(["codeman", "cptr"], { env: { CLOUDAGENTFLEET_MANAGE_CODEMAN: "false" } })
      .map((supervisor) => supervisor.backend),
    ["cptr"],
  );
});

test("resolveCptrCommand finds cptr outside a service's minimal PATH", () => {
  assert.equal(resolveCptrCommand({ CLOUDAGENTFLEET_CPTR_COMMAND: "/opt/cptr/bin/cptr" }), "/opt/cptr/bin/cptr");
  const userBin = join("/home/op", ".local", "bin", "cptr");
  assert.equal(resolveCptrCommand({}, (path) => path === userBin, "/home/op", "linux"), userBin);
  assert.equal(resolveCptrCommand({}, () => false, "/home/op", "linux"), "cptr");
  const windowsBin = join("C:/Users/op", ".local", "bin", "cptr.exe");
  assert.equal(resolveCptrCommand({}, (path) => path === windowsBin, "C:/Users/op", "win32"), windowsBin);
});

test("ensureCptr completes first-run setup with a fleet account kept on this machine", async () => {
  const directory = mkdtempSync(join(tmpdir(), "cloudagentfleet-cptr-"));
  try {
    const state = { up: false, needsSetup: true };
    let setupBody: Record<string, unknown> | undefined;
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      if (new URL(String(url)).pathname === "/api/auth/setup") {
        setupBody = JSON.parse(String(init?.body));
        state.needsSetup = false;
        return Response.json({ ok: true });
      }
      return fakeFetch(state)(url, init);
    }) as typeof fetch;
    const logs: string[] = [];
    const child = fakeChild();
    await ensureCptr({
      baseUrl: "http://127.0.0.1:8125",
      logPath: join(directory, "cptr.log"),
      credentialsPath: join(directory, "cptr-credentials.json"),
      fetchImpl,
      spawnImpl: () => {
        setTimeout(() => {
          (child.stdout as PassThrough).write(`\n  ➜  http://127.0.0.1:8125/?token=${TOKEN}\n`);
          state.up = true;
        }, 5);
        return child;
      },
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, Math.min(ms, 5))),
      log: (message) => logs.push(message),
    });
    const saved = JSON.parse(readFileSync(join(directory, "cptr-credentials.json"), "utf8"));
    assert.equal(setupBody?.token, TOKEN);
    assert.equal(setupBody?.username, "fleet");
    assert.deepEqual(saved, { username: "fleet", password: setupBody?.password });
    assert.ok(String(saved.password).length >= 24);
    assert.ok(!logs.some((line) => line.includes(String(saved.password))), "the password is never logged");
    assert.throws(() => readFileSync(join(directory, "cptr-setup-token")), /ENOENT/, "no token file is left behind");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
