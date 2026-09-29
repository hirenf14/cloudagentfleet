import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  clearBootstrapPlaintext,
  resolveUiAuth,
  setUiPassword,
} from "./auth.ts";

test("generates a bootstrap Hub password and reveals it until changed", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "hosted-agents-auth-"));
  const previousHash = process.env.HOSTED_AGENTS_UI_PASSWORD_HASH;
  const previousPassword = process.env.HOSTED_AGENTS_UI_PASSWORD;
  delete process.env.HOSTED_AGENTS_UI_PASSWORD_HASH;
  delete process.env.HOSTED_AGENTS_UI_PASSWORD;
  try {
    const first = resolveUiAuth({ dataDir });
    assert.equal(first.auth.enabled, true);
    assert.ok(first.revealPassword);
    assert.match(first.revealPassword!, /[A-Za-z0-9_-]{16,}/);

    const second = resolveUiAuth({ dataDir });
    assert.equal(second.revealPassword, first.revealPassword);
    assert.equal(second.auth.enabled, true);

    const stored = JSON.parse(readFileSync(join(dataDir, "hub-ui-auth.json"), "utf8")) as {
      hash: string;
      password?: string;
    };
    assert.ok(stored.hash.startsWith("scrypt$"));
    assert.equal(stored.password, first.revealPassword);

    setUiPassword(dataDir, "operator-chosen-password");
    const afterChange = resolveUiAuth({ dataDir });
    assert.equal(afterChange.revealPassword, undefined);
    assert.equal(afterChange.auth.enabled, true);
    assert.equal(afterChange.auth.verifyPassword("test", "operator-chosen-password"), true);
  } finally {
    if (previousHash === undefined) delete process.env.HOSTED_AGENTS_UI_PASSWORD_HASH;
    else process.env.HOSTED_AGENTS_UI_PASSWORD_HASH = previousHash;
    if (previousPassword === undefined) delete process.env.HOSTED_AGENTS_UI_PASSWORD;
    else process.env.HOSTED_AGENTS_UI_PASSWORD = previousPassword;
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("env password stops revealing the bootstrap plaintext", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "hosted-agents-auth-"));
  const previousHash = process.env.HOSTED_AGENTS_UI_PASSWORD_HASH;
  const previousPassword = process.env.HOSTED_AGENTS_UI_PASSWORD;
  delete process.env.HOSTED_AGENTS_UI_PASSWORD_HASH;
  delete process.env.HOSTED_AGENTS_UI_PASSWORD;
  try {
    const bootstrap = resolveUiAuth({ dataDir });
    assert.ok(bootstrap.revealPassword);
    const withEnv = resolveUiAuth({
      dataDir,
      password: "from-environment",
    });
    assert.equal(withEnv.revealPassword, undefined);
    assert.equal(withEnv.auth.verifyPassword("test", "from-environment"), true);
    clearBootstrapPlaintext(dataDir);
  } finally {
    if (previousHash === undefined) delete process.env.HOSTED_AGENTS_UI_PASSWORD_HASH;
    else process.env.HOSTED_AGENTS_UI_PASSWORD_HASH = previousHash;
    if (previousPassword === undefined) delete process.env.HOSTED_AGENTS_UI_PASSWORD;
    else process.env.HOSTED_AGENTS_UI_PASSWORD = previousPassword;
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("ephemeral mode without dataDir leaves auth disabled", () => {
  const previousHash = process.env.HOSTED_AGENTS_UI_PASSWORD_HASH;
  const previousPassword = process.env.HOSTED_AGENTS_UI_PASSWORD;
  delete process.env.HOSTED_AGENTS_UI_PASSWORD_HASH;
  delete process.env.HOSTED_AGENTS_UI_PASSWORD;
  try {
    const resolved = resolveUiAuth({});
    assert.equal(resolved.auth.enabled, false);
    assert.equal(resolved.revealPassword, undefined);
  } finally {
    if (previousHash === undefined) delete process.env.HOSTED_AGENTS_UI_PASSWORD_HASH;
    else process.env.HOSTED_AGENTS_UI_PASSWORD_HASH = previousHash;
    if (previousPassword === undefined) delete process.env.HOSTED_AGENTS_UI_PASSWORD;
    else process.env.HOSTED_AGENTS_UI_PASSWORD = previousPassword;
  }
});
