import { build } from "esbuild";
import { cp, mkdir, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = join(root, "dist", "release");

await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });

async function bundle(entryPoint, outfile) {
  await build({
    entryPoints: [join(root, entryPoint)],
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
    sourcemap: true,
    outfile: join(output, outfile),
    absWorkingDir: root,
    logLevel: "info",
  });
}

await bundle("apps/node-agent/src/main.ts", "apps/cli/runtime/worker.mjs");

await mkdir(join(output, "apps", "cli", "bin"), { recursive: true });
await cp(
  join(root, "apps", "cli", "bin", "hosted-agents.mjs"),
  join(output, "apps", "cli", "bin", "hosted-agents.mjs"),
);
await cp(
  join(root, "apps", "cli", "bin", "setup.mjs"),
  join(output, "apps", "cli", "bin", "setup.mjs"),
);

console.log(`Worker release runtime written to ${output}`);
