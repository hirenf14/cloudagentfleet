import { build } from "esbuild";
import { chmod, cp, mkdir, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const shebang = "#!/usr/bin/env node\n";

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

await rm(join(root, "dist"), { recursive: true, force: true });
await rm(join(root, "apps", "control-plane", "dist"), { recursive: true, force: true });
await rm(join(root, "apps", "node-agent", "dist"), { recursive: true, force: true });
await rm(join(root, "apps", "node-agent", "cli"), { recursive: true, force: true });
await rm(join(root, "apps", "dashboard", "dist"), { recursive: true, force: true });

const hubDist = join(root, "apps", "control-plane", "dist");
const workerDist = join(root, "apps", "node-agent", "dist");
const cliBundle = join(root, "dist", "cli-bundle");

await bundleCli(
  "apps/control-plane/src/server.ts",
  join(hubDist, "cloudagentfleet-hub.mjs"),
  { external: ["@cloudagentfleet/ui"] },
);
await bundleCli("apps/node-agent/src/main.ts", join(workerDist, "cloudagentfleet-worker.mjs"));
await bundleCli("apps/cli/bin/setup.mjs", join(workerDist, "cloudagentfleet.mjs"));

await mkdir(cliBundle, { recursive: true });
await cp(join(workerDist, "cloudagentfleet.mjs"), join(cliBundle, "cloudagentfleet.mjs"));
await cp(join(workerDist, "cloudagentfleet-worker.mjs"), join(cliBundle, "cloudagentfleet-worker.mjs"));
await cp(join(hubDist, "cloudagentfleet-hub.mjs"), join(cliBundle, "cloudagentfleet-hub.mjs"));

console.log("Compiled CLI bundles:");
console.log(`  ${hubDist}/cloudagentfleet-hub.mjs`);
console.log(`  ${workerDist}/cloudagentfleet.mjs`);
console.log(`  ${workerDist}/cloudagentfleet-worker.mjs`);
console.log(`  ${cliBundle}/ (standalone input)`);
