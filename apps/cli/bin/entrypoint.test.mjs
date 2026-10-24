import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

test("the CLI runs when started through npm's bin symlink", () => {
  // npm links <prefix>/bin/cloudagentfleet (no .mjs) to the script; the CLI used to exit silently there.
  const dir = mkdtempSync(join(tmpdir(), "cloudagentfleet-bin-"));
  const link = join(dir, "cloudagentfleet");
  symlinkSync(fileURLToPath(new URL("./setup.mjs", import.meta.url)), link);
  try {
    const run = spawnSync(process.execPath, [link, "help"], { encoding: "utf8" });
    assert.equal(run.status, 0);
    assert.match(run.stdout, /Cloud Agent Fleet CLI/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
