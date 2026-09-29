#!/usr/bin/env node
/**
 * Local monorepo launcher. Published packages ship the compiled
 * dist/cloudagentfleet.mjs CLI bundle instead of this file.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(fileURLToPath(import.meta.url));
const bundled = join(root, "..", "dist", "cloudagentfleet.mjs");
if (existsSync(bundled)) {
  const child = spawn(process.execPath, [bundled, ...process.argv.slice(2)], { stdio: "inherit" });
  child.on("exit", (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    process.exit(code ?? 1);
  });
} else {
  const monorepoCli = join(root, "..", "..", "cli", "bin", "hosted-agents.mjs");
  await import(pathToFileURL(monorepoCli).href);
}
