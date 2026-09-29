import { createHash } from "node:crypto";
import { chmod, cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const release = join(root, "dist", "release");
const platform = process.platform;
const architecture = process.arch;
const artifactName = `cloudagentfleet-${platform}-${architecture}`;
const artifactRoot = join(root, "dist", "standalone", artifactName);
const nodeName = platform === "win32" ? "node.exe" : "node";
const launcherName = platform === "win32" ? "cloudagentfleet.cmd" : "cloudagentfleet";
const entryScript = "apps/cli/bin/hosted-agents.mjs";

await mkdir(dirname(artifactRoot), { recursive: true });
await rm(artifactRoot, { recursive: true, force: true });
await cp(release, artifactRoot, { recursive: true });
await cp(process.execPath, join(artifactRoot, nodeName));

const launcher = platform === "win32"
  ? `@echo off\r\n"%~dp0${nodeName}" "%~dp0${entryScript.replace(/\//g, "\\")}" %*\r\n`
  : `#!/usr/bin/env sh\nset -eu\nROOT="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"\nexec "$ROOT/${nodeName}" "$ROOT/${entryScript}" "$@"\n`;
const launcherPath = join(artifactRoot, launcherName);
await writeFile(launcherPath, launcher);
if (platform !== "win32") await chmod(launcherPath, 0o755);

const compatibilityLauncher = platform === "win32"
  ? `@echo off\r\n"%~dp0${launcherName}" %*\r\n`
  : `#!/usr/bin/env sh\nset -eu\nROOT="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"\nexec "$ROOT/${launcherName}" "$@"\n`;
const compatibilityName = platform === "win32" ? "hosted-agents.cmd" : "hosted-agents";
await writeFile(join(artifactRoot, compatibilityName), compatibilityLauncher);
if (platform !== "win32") await chmod(join(artifactRoot, compatibilityName), 0o755);

const manifest = {
  name: "cloudagentfleet",
  version: process.env.HOSTED_AGENTS_VERSION ?? "0.1.0",
  platform,
  architecture,
  node: nodeName,
  entrypoint: launcherName,
  providerSetup: "Run cloudagentfleet setup; Codeman and provider login remain user-owned.",
};
await writeFile(join(artifactRoot, "release-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);

async function filesIn(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await filesIn(path));
    else files.push(path);
  }
  return files;
}

const checksums = [];
for (const path of (await filesIn(artifactRoot)).sort()) {
  const digest = createHash("sha256").update(await readFile(path)).digest("hex");
  checksums.push(`${digest}  ${path.slice(`${artifactRoot}${platform === "win32" ? "\\" : "/"}`.length)}`);
}
await writeFile(join(artifactRoot, "SHA256SUMS"), `${checksums.join("\n")}\n`);

const archiveName = `${artifactName}.tar.gz`;
const archive = join(dirname(artifactRoot), archiveName);
await execFileAsync("tar", ["-czf", archiveName, "-C", ".", basename(artifactRoot)], {
  cwd: dirname(artifactRoot),
});
console.log(`Standalone artifact written to ${archive}`);
