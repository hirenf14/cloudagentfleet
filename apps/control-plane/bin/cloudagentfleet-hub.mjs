#!/usr/bin/env node
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(fileURLToPath(import.meta.url));
const bundled = join(root, "..", "dist", "server.mjs");
const source = join(root, "..", "src", "server.ts");

const entry = await import("node:fs").then((fs) => (fs.existsSync(bundled) ? bundled : source));
const args = entry.endsWith(".ts")
  ? ["--experimental-strip-types", entry, ...process.argv.slice(2)]
  : [entry, ...process.argv.slice(2)];

const child = spawn(process.execPath, args, { stdio: "inherit" });
child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 1);
});
