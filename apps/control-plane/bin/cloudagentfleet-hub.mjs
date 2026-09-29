#!/usr/bin/env node
/**
 * Local monorepo launcher. Published packages ship the compiled
 * dist/cloudagentfleet-hub.mjs CLI bundle instead of this file.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(fileURLToPath(import.meta.url));
const bundled = join(root, "..", "dist", "cloudagentfleet-hub.mjs");
if (existsSync(bundled)) {
  const child = spawn(process.execPath, [bundled, ...process.argv.slice(2)], { stdio: "inherit" });
  child.on("exit", (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    process.exit(code ?? 1);
  });
} else {
  const source = join(root, "..", "src", "server.ts");
  const child = spawn(process.execPath, ["--experimental-strip-types", source, ...process.argv.slice(2)], {
    stdio: "inherit",
  });
  child.on("exit", (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    process.exit(code ?? 1);
  });
}
