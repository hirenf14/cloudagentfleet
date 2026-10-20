import { build } from "esbuild";
import { chmod, cp, mkdir, readdir, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const shebang = "#!/usr/bin/env node\n";

/** Draft / non-production UI files that must never ship in the npm package. */
const uiPublishDeny = new Set([
  "design-draft.html",
]);

async function bundleCli(entryPoint, outfile, options = {}) {
  await mkdir(dirname(outfile), { recursive: true });
  await build({
    entryPoints: [join(root, entryPoint)],
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
    sourcemap: false,
    outfile,
    absWorkingDir: root,
    logLevel: "info",
    packages: "bundle",
    banner: { js: shebang },
    ...options,
  });
  await chmod(outfile, 0o755);
}

/** Copies the production UI files to `distPublic` (the UI package, and each Hub). */
async function stageUi(distPublic) {
  const sourcePublic = join(root, "apps", "dashboard", "public");
  await mkdir(distPublic, { recursive: true });
  const entries = await readdir(sourcePublic, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (uiPublishDeny.has(entry.name)) continue;
    if (entry.name.startsWith(".")) continue;
    await cp(join(sourcePublic, entry.name), join(distPublic, entry.name));
  }
}

/**
 * Empties an output folder but keeps the folder: on Windows a process using it
 * as its working directory, or a file watcher, makes removing it fail (EBUSY).
 */
async function emptyDir(path) {
  const entries = await readdir(path).catch(() => []);
  await Promise.all(entries.map((entry) => rm(join(path, entry), { recursive: true, force: true })));
}

await emptyDir(join(root, "dist"));
await emptyDir(join(root, "apps", "control-plane", "dist"));
await emptyDir(join(root, "apps", "node-agent", "dist"));
await emptyDir(join(root, "apps", "dashboard", "dist"));

const hubDist = join(root, "apps", "control-plane", "dist");
const workerDist = join(root, "apps", "node-agent", "dist");
const cliBundle = join(root, "dist", "cli-bundle");

// The CLI (cloudagentfleet) runs whichever roles sit beside it. The Hub
// package carries the dashboard and the Worker too, so `init` on a Hub can
// also run a Worker on that machine when the operator chooses; the Worker
// package is the Worker and the CLI only.
await bundleCli("apps/control-plane/src/server.ts", join(hubDist, "cloudagentfleet-hub.mjs"));
await bundleCli("apps/node-agent/src/main.ts", join(workerDist, "cloudagentfleet-worker.mjs"));
await bundleCli("apps/cli/bin/setup.mjs", join(workerDist, "cloudagentfleet.mjs"));
await cp(join(workerDist, "cloudagentfleet.mjs"), join(hubDist, "cloudagentfleet.mjs"));
await cp(join(workerDist, "cloudagentfleet-worker.mjs"), join(hubDist, "cloudagentfleet-worker.mjs"));
await stageUi(join(root, "apps", "dashboard", "dist", "public"));
await stageUi(join(hubDist, "public"));

await mkdir(cliBundle, { recursive: true });
await cp(hubDist, cliBundle, { recursive: true });

console.log("Compiled release packages:");
console.log(`  hub:    ${hubDist}/ (Hub, CLI, Worker, public/)`);
console.log(`  worker: ${workerDist}/cloudagentfleet.mjs`);
console.log(`  worker: ${workerDist}/cloudagentfleet-worker.mjs`);
console.log(`  ui:     apps/dashboard/dist/public/`);
console.log(`  flat:   ${cliBundle}/`);
