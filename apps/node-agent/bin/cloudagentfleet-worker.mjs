#!/usr/bin/env node
/**
 * Local monorepo launcher. Published packages ship the compiled
 * dist/cloudagentfleet-worker.mjs CLI bundle instead of this file.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(fileURLToPath(import.meta.url));
const bundled = join(root, "..", "dist", "cloudagentfleet-worker.mjs");
const source = join(root, "..", "src", "main.ts");
const args = existsSync(bundled)
  ? [bundled, ...process.argv.slice(2)]
  : ["--experimental-strip-types", source, ...process.argv.slice(2)];
const child = spawn(process.execPath, args, { stdio: "inherit" });
child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 1);
});
