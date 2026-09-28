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
const artifactName = `hosted-agents-${platform}-${architecture}`;
const artifactRoot = join(root, "dist", "standalone", artifactName);
const nodeName = platform === "win32" ? "node.exe" : "node";

await mkdir(dirname(artifactRoot), { recursive: true });
await rm(artifactRoot, { recursive: true, force: true });
await cp(release, artifactRoot, { recursive: true });
await cp(process.execPath, join(artifactRoot, nodeName));

const launcher = platform === "win32"
  ? `@echo off\r\n"%~dp0${nodeName}" "%~dp0apps\\cli\\bin\\hosted-agents.mjs" %*\r\n`
  : `#!/usr/bin/env sh\nset -eu\nROOT="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"\nexec "$ROOT/${nodeName}" "$ROOT/apps/cli/bin/hosted-agents.mjs" "$@"\n`;
const launcherPath = join(artifactRoot, platform === "win32" ? "hosted-agents.cmd" : "hosted-agents");
await writeFile(launcherPath, launcher);
if (platform !== "win32") await chmod(launcherPath, 0o755);
if (platform === "win32") {
  await writeFile(
    join(artifactRoot, "install.ps1"),
    [
      "$ErrorActionPreference = 'Stop'",
      "$target = Join-Path $env:LOCALAPPDATA 'HostedAgents'",
      "New-Item -ItemType Directory -Force -Path $target | Out-Null",
      "Copy-Item -Recurse -Force (Join-Path $PSScriptRoot '*') $target",
      "Write-Host \"Installed Hosted Agents to $target\"",
      "Write-Host \"Run $target\\hosted-agents.cmd setup\"",
      "",
    ].join("\r\n"),
  );
} else {
  await writeFile(
    join(artifactRoot, "install.sh"),
    [
      "#!/usr/bin/env sh",
      "set -eu",
      "TARGET=\"${XDG_DATA_HOME:-$HOME/.local/share}/hosted-agents\"",
      "mkdir -p \"$TARGET\" \"$HOME/.local/bin\"",
      "cp -R \"$(CDPATH= cd -- \"$(dirname -- \"$0\")\" && pwd)\"/. \"$TARGET\"/",
      "ln -sf \"$TARGET/hosted-agents\" \"$HOME/.local/bin/hosted-agents\"",
      "printf 'Installed Hosted Agents to %s\\n' \"$TARGET\"",
      "",
    ].join("\n"),
  );
  await chmod(join(artifactRoot, "install.sh"), 0o755);
}

const manifest = {
  name: "hosted-agents",
  version: process.env.HOSTED_AGENTS_VERSION ?? "0.1.0",
  platform,
  architecture,
  node: nodeName,
  entrypoint: platform === "win32" ? "hosted-agents.cmd" : "hosted-agents",
  providerSetup: "Run hosted-agents setup; Codeman and provider login remain user-owned.",
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

const archiveExtension = platform === "win32" ? "tar.gz" : "tar.gz";
const archiveName = `${artifactName}.${archiveExtension}`;
const archive = join(dirname(artifactRoot), archiveName);
await execFileAsync("tar", ["-czf", archiveName, "-C", ".", basename(artifactRoot)], {
  cwd: dirname(artifactRoot),
});
console.log(`Standalone artifact written to ${archive}`);
