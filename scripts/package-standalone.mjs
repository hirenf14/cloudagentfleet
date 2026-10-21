import { createHash } from "node:crypto";
import { chmod, cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

/**
 * Builds the two standalone archives for this platform. Each one carries a
 * private Node runtime and launchers, so nothing else needs installing:
 *
 *   cloudagentfleet-hub-<platform>-<arch>     the Hub with its dashboard, the CLI, and the
 *                                             Worker (it runs only if `init` is told to)
 *   cloudagentfleet-worker-<platform>-<arch>  the Worker and the CLI
 *
 * Run `pnpm build:release` first.
 */
const execFileAsync = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cliBundle = join(root, "dist", "cli-bundle");
const platform = process.platform;
const architecture = process.arch;
const nodeName = platform === "win32" ? "node.exe" : "node";
const version = JSON.parse(await readFile(join(root, "apps", "node-agent", "package.json"), "utf8")).version;

const EDITIONS = [
  {
    name: `cloudagentfleet-hub-${platform}-${architecture}`,
    edition: "hub",
    files: ["cloudagentfleet.mjs", "cloudagentfleet-hub.mjs", "cloudagentfleet-worker.mjs", "public"],
    binaries: ["cloudagentfleet", "cloudagentfleet-hub"],
  },
  {
    name: `cloudagentfleet-worker-${platform}-${architecture}`,
    edition: "worker",
    files: ["cloudagentfleet.mjs", "cloudagentfleet-worker.mjs"],
    binaries: ["cloudagentfleet"],
  },
];

function launcher(entry) {
  return platform === "win32"
    ? `@echo off\r\n"%~dp0${nodeName}" "%~dp0${entry}" %*\r\n`
    : `#!/usr/bin/env sh\nset -eu\nROOT="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"\nexec "$ROOT/${nodeName}" "$ROOT/${entry}" "$@"\n`;
}

const FIRST_STEPS = {
  hub: "Start here: run `cloudagentfleet init`. It installs the Hub as a user service, asks whether this machine should also run a Worker, and prints the dashboard address and password.",
  worker: "Start here: run `cloudagentfleet init` on this machine. It asks for your Hub's address and Worker token (run `cloudagentfleet hub token` on the Hub machine).",
};

/** The license of the Node.js being bundled: from its install, else its tagged source. */
async function nodeLicense() {
  for (const candidate of [join(dirname(process.execPath), "LICENSE"), join(dirname(process.execPath), "..", "LICENSE")]) {
    try {
      return await readFile(candidate, "utf8");
    } catch {
      // Not in this layout.
    }
  }
  const response = await fetch(`https://raw.githubusercontent.com/nodejs/node/v${process.versions.node}/LICENSE`);
  if (!response.ok) throw new Error(`Could not get the Node.js license (HTTP ${response.status})`);
  return response.text();
}

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

async function packageEdition({ name, edition, files, binaries }) {
  const artifactRoot = join(root, "dist", "standalone", name);
  await mkdir(dirname(artifactRoot), { recursive: true });
  await rm(artifactRoot, { recursive: true, force: true });
  await mkdir(artifactRoot, { recursive: true });
  for (const file of files) await cp(join(cliBundle, file), join(artifactRoot, file), { recursive: true });
  await cp(process.execPath, join(artifactRoot, nodeName));
  await cp(join(root, "LICENSE"), join(artifactRoot, "LICENSE"));
  // Node.js is MIT-licensed; redistributing its binary means shipping its notice.
  await writeFile(join(artifactRoot, "NODE-LICENSE.txt"), await nodeLicense());
  for (const binary of binaries) {
    const launcherName = platform === "win32" ? `${binary}.cmd` : binary;
    await writeFile(join(artifactRoot, launcherName), launcher(`${binary}.mjs`));
    if (platform !== "win32") await chmod(join(artifactRoot, launcherName), 0o755);
  }
  const manifest = {
    name: "cloudagentfleet",
    edition,
    version,
    platform,
    architecture,
    node: nodeName,
    binaries,
    firstSteps: FIRST_STEPS[edition],
    providerSetup: "Codeman, Open WebUI Computer, and provider logins stay user-owned; setup asks before installing anything.",
  };
  await writeFile(join(artifactRoot, "release-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(join(artifactRoot, "README.txt"), [
    `Cloud Agent Fleet ${version} (${edition}, ${platform}-${architecture})`,
    "",
    "Put this folder on your PATH (or run the launchers by path). No other install is needed;",
    "a private Node runtime is included.",
    "",
    FIRST_STEPS[edition],
    "",
    "Guide: https://hirenf14.github.io/cloudagentfleet/docs/getting-started.html",
    "",
    "Cloud Agent Fleet is MIT-licensed (LICENSE). The bundled Node.js runtime is MIT-licensed (NODE-LICENSE.txt). Codeman, Open WebUI Computer,",
    "and the coding agents are not included; init installs the ones you pick with their official",
    "installers, under their own licenses. Credits: https://hirenf14.github.io/cloudagentfleet/docs/credits.html",
    "",
  ].join(platform === "win32" ? "\r\n" : "\n"));

  const checksums = [];
  for (const path of (await filesIn(artifactRoot)).sort()) {
    const digest = createHash("sha256").update(await readFile(path)).digest("hex");
    checksums.push(`${digest}  ${path.slice(artifactRoot.length + 1).replaceAll("\\", "/")}`);
  }
  await writeFile(join(artifactRoot, "SHA256SUMS"), `${checksums.join("\n")}\n`);

  const archiveName = `${name}.tar.gz`;
  await execFileAsync("tar", ["-czf", archiveName, "-C", ".", basename(artifactRoot)], {
    cwd: dirname(artifactRoot),
  });
  console.log(`Standalone ${edition} archive: ${join(dirname(artifactRoot), archiveName)}`);
}

for (const edition of EDITIONS) await packageEdition(edition);
