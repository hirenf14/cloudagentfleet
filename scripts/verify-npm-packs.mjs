import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const packages = [
  {
    name: "@cloudagentfleet/hub",
    dir: "apps/control-plane",
    required: [/^package\.json$/, /^README\.md$/, /^dist\/cloudagentfleet-hub\.mjs$/],
    optional: [/^CHANGELOG\.md$/],
    forbidden: [/src\//, /\.ts$/, /^bin\//, /\.test\./],
  },
  {
    name: "@cloudagentfleet/ui",
    dir: "apps/dashboard",
    required: [/^package\.json$/, /^README\.md$/, /^dist\/public\/[^/]+$/],
    optional: [/^CHANGELOG\.md$/],
    forbidden: [/src\//, /\.ts$/, /design-draft/, /^public\//, /^bin\//],
  },
  {
    name: "@cloudagentfleet/worker",
    dir: "apps/node-agent",
    required: [
      /^package\.json$/,
      /^README\.md$/,
      /^dist\/cloudagentfleet\.mjs$/,
      /^dist\/cloudagentfleet-worker\.mjs$/,
    ],
    optional: [/^CHANGELOG\.md$/],
    forbidden: [/src\//, /\.ts$/, /^bin\//, /^cli\//, /\.test\./],
  },
];

function listPackFiles(packageDir) {
  const result = spawnSync("npm", ["pack", packageDir, "--dry-run"], {
    cwd: root,
    encoding: "utf8",
    shell: process.platform === "win32",
  });
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || `npm pack failed for ${packageDir}`);
  }
  const output = `${result.stdout}\n${result.stderr}`;
  const files = [];
  for (const line of output.split(/\r?\n/)) {
    const match = line.match(/npm notice\s+[0-9.]+\w*\s+(.+)$/i);
    if (!match) continue;
    const path = match[1].trim().replaceAll("\\", "/");
    if (path === "Tarball Contents" || path.startsWith("Tarball ")) continue;
    if (path.includes(" ")) continue;
    files.push(path);
  }
  // Fallback: lines like "npm notice 106.0kB dist/file.mjs"
  if (files.length === 0) {
    for (const line of output.split(/\r?\n/)) {
      const match = line.match(/npm notice\s+\S+\s+(\S+\.\S+)\s*$/);
      if (match) files.push(match[1].replaceAll("\\", "/"));
    }
  }
  return [...new Set(files)].filter((file) => file !== "package.json" || true);
}

let failed = false;
for (const pkg of packages) {
  const files = listPackFiles(join(root, pkg.dir));
  console.log(`\n${pkg.name}`);
  for (const file of files) console.log(`  ${file}`);

  if (files.length === 0) {
    console.error(`FAIL ${pkg.name}: could not parse npm pack --dry-run contents`);
    failed = true;
    continue;
  }

  for (const file of files) {
    if (pkg.forbidden.some((pattern) => pattern.test(file))) {
      console.error(`FAIL ${pkg.name}: forbidden path in tarball: ${file}`);
      failed = true;
    }
    const allowed = [...pkg.required, ...pkg.optional];
    if (!allowed.some((pattern) => pattern.test(file))) {
      console.error(`FAIL ${pkg.name}: unexpected path in tarball: ${file}`);
      failed = true;
    }
  }

  for (const pattern of pkg.required) {
    if (!files.some((file) => pattern.test(file))) {
      console.error(`FAIL ${pkg.name}: missing required path matching ${pattern}`);
      failed = true;
    }
  }

  const manifest = JSON.parse(readFileSync(join(root, pkg.dir, "package.json"), "utf8"));
  if (manifest.files?.includes("src") || manifest.files?.includes("bin") || manifest.files?.includes("public")) {
    console.error(`FAIL ${pkg.name}: package.json files must be build output only (dist)`);
    failed = true;
  }
}

if (failed) {
  console.error("\nPackage contents are not release-safe.");
  process.exit(1);
}

console.log("\nAll package tarballs contain build outputs only.");
