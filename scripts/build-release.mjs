import { build } from "esbuild";
import { cp, mkdir, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

async function bundle(entryPoint, outfile, options = {}) {
  await mkdir(dirname(outfile), { recursive: true });
  await build({
    entryPoints: [join(root, entryPoint)],
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
    sourcemap: true,
    outfile,
    absWorkingDir: root,
    logLevel: "info",
    packages: "bundle",
    ...options,
  });
}

const hubDist = join(root, "apps", "control-plane", "dist");
await rm(hubDist, { recursive: true, force: true });
await bundle("apps/control-plane/src/server.ts", join(hubDist, "server.mjs"), {
  external: ["@cloudagentfleet/ui"],
});

const workerRoot = join(root, "apps", "node-agent");
const workerDist = join(workerRoot, "dist");
const workerCli = join(workerRoot, "cli");
await rm(workerDist, { recursive: true, force: true });
await rm(workerCli, { recursive: true, force: true });
await bundle("apps/node-agent/src/main.ts", join(workerDist, "worker.mjs"));
await mkdir(workerCli, { recursive: true });
await cp(join(root, "apps", "cli", "bin", "hosted-agents.mjs"), join(workerCli, "hosted-agents.mjs"));
await cp(join(root, "apps", "cli", "bin", "setup.mjs"), join(workerCli, "setup.mjs"));

const output = join(root, "dist", "release");
await rm(output, { recursive: true, force: true });
await mkdir(join(output, "apps", "cli", "bin"), { recursive: true });
await mkdir(join(output, "apps", "cli", "runtime"), { recursive: true });
await cp(join(workerDist, "worker.mjs"), join(output, "apps", "cli", "runtime", "worker.mjs"));
await cp(join(root, "apps", "cli", "bin", "hosted-agents.mjs"), join(output, "apps", "cli", "bin", "hosted-agents.mjs"));
await cp(join(root, "apps", "cli", "bin", "setup.mjs"), join(output, "apps", "cli", "bin", "setup.mjs"));

console.log("Release builds ready for @cloudagentfleet/hub, @cloudagentfleet/ui, and @cloudagentfleet/worker");
