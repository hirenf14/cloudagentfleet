import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const CHECK_TTL_MS = 6 * 60 * 60_000;
const WATCH_FIRST_CHECK_MS = 60_000;

/**
 * The package this CLI was installed from, read from the package.json beside
 * its `dist/` folder. `installed` is false for a source checkout or a flat
 * bundle, which `cloudagentfleet update` leaves alone.
 */
export function readCliPackage(binDir) {
  try {
    const root = join(binDir, "..");
    const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    if (typeof manifest.name === "string" && typeof manifest.version === "string" && !manifest.private) {
      return { name: manifest.name, version: manifest.version, installed: root.includes("node_modules") };
    }
  } catch {
    // Not inside an npm package.
  }
  return { name: "@cloudagentfleet/worker", version: "0.0.0-dev", installed: false };
}

/** Negative when `a` is older than `b` (same rules as packages/protocol/src/version.ts). */
export function compareVersions(a, b) {
  const parse = (value) => {
    const [core = "", pre] = value.replace(/^v/, "").split("-", 2);
    return { numbers: core.split(".").map((part) => Number.parseInt(part, 10) || 0), pre };
  };
  const left = parse(a);
  const right = parse(b);
  for (let index = 0; index < Math.max(left.numbers.length, right.numbers.length); index += 1) {
    const difference = (left.numbers[index] ?? 0) - (right.numbers[index] ?? 0);
    if (difference !== 0) return difference;
  }
  if (left.pre === right.pre) return 0;
  if (left.pre === undefined) return 1;
  if (right.pre === undefined) return -1;
  return left.pre < right.pre ? -1 : 1;
}

/** The newest published version of an npm package, or undefined when it can't be read. */
export async function fetchLatestVersion(name, fetchImpl = fetch, timeoutMs = 5_000) {
  try {
    const response = await fetchImpl(`https://registry.npmjs.org/${name.replace("/", "%2f")}/latest`, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return undefined;
    const { version } = await response.json();
    return typeof version === "string" && /^[0-9A-Za-z][0-9A-Za-z.+-]*$/.test(version) ? version : undefined;
  } catch {
    return undefined;
  }
}

function readCache(cachePath) {
  try {
    return JSON.parse(readFileSync(cachePath, "utf8"));
  } catch {
    return {};
  }
}

/** What the last lookup found, without touching the network. */
export function cachedLatest(cachePath, name, now = Date.now()) {
  const entry = readCache(cachePath)[name];
  if (!entry || typeof entry.latest !== "string") return { latest: undefined, stale: true };
  return { latest: entry.latest, stale: now - Date.parse(entry.checkedAt) > CHECK_TTL_MS };
}

/** Looks the version up and remembers it; keeps the old answer when the registry can't be reached. */
export async function refreshLatest(cachePath, name, { fetchImpl, timeoutMs, now = Date.now() } = {}) {
  const latest = await fetchLatestVersion(name, fetchImpl, timeoutMs);
  if (!latest) return cachedLatest(cachePath, name, now).latest;
  try {
    mkdirSync(dirname(cachePath), { recursive: true });
    writeFileSync(cachePath, `${JSON.stringify({
      ...readCache(cachePath),
      [name]: { latest, checkedAt: new Date(now).toISOString() },
    }, null, 2)}\n`);
  } catch {
    // The cache is only an optimisation.
  }
  return latest;
}

/** The one-line "update available" hint for a command, from the cache only. */
export function updateNotice(pkg, cachePath) {
  if (process.env.CLOUDAGENTFLEET_UPDATE_CHECK === "0") return undefined;
  const { latest } = cachedLatest(cachePath, pkg.name);
  if (!latest || compareVersions(pkg.version, latest) >= 0) return undefined;
  return `Update available: ${pkg.version} -> ${latest}. Run \`cloudagentfleet update\`.`;
}

/** Installs the newest release globally. Resolves with an error message, or undefined on success. */
export function installLatest(name, run = spawnSync) {
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  const result = run(npm, ["install", "-g", `${name}@latest`], {
    encoding: "utf8",
    stdio: "pipe",
    timeout: 5 * 60_000,
    shell: process.platform === "win32",
  });
  if (result.error) return result.error.message;
  if (result.status !== 0) return (result.stderr || result.stdout || `npm exited with ${result.status}`).trim().split("\n").slice(-4).join("\n");
  return undefined;
}

/**
 * Whether a service installs updates by itself. `CLOUDAGENTFLEET_AUTO_UPDATE`
 * (0/1) wins over the saved `autoUpdate` setting; without either, a Worker
 * updates and a Hub only reports. A source checkout never self-updates.
 */
export function autoUpdateEnabled(role, config, pkg, env = process.env) {
  if (!pkg.installed || env.CLOUDAGENTFLEET_UPDATE_CHECK === "0") return false;
  if (env.CLOUDAGENTFLEET_AUTO_UPDATE === "0") return false;
  if (env.CLOUDAGENTFLEET_AUTO_UPDATE === "1") return true;
  return typeof config?.autoUpdate === "boolean" ? config.autoUpdate : role === "worker";
}

/**
 * Background update loop for a long-running service: a minute after start and
 * then every few hours it looks for a newer release. With `apply` it installs
 * it and calls `onUpdated` so the service can restart on the new files.
 * Returns a function that stops the loop.
 */
export function watchForUpdates({ pkg, cachePath, apply, log, onUpdated, intervalMs = CHECK_TTL_MS, firstMs = WATCH_FIRST_CHECK_MS, fetchImpl, install = installLatest }) {
  if (process.env.CLOUDAGENTFLEET_UPDATE_CHECK === "0") return () => undefined;
  let stopped = false;
  let timer;
  const tick = async () => {
    try {
      const latest = await refreshLatest(cachePath, pkg.name, { fetchImpl });
      if (stopped || !latest || compareVersions(pkg.version, latest) >= 0) return;
      if (!apply) {
        log(`Update available: ${pkg.version} -> ${latest}. Run \`cloudagentfleet update\`.`);
        return;
      }
      log(`Updating ${pkg.name} ${pkg.version} -> ${latest}...`);
      const failure = install(pkg.name);
      if (failure) {
        log(`Update failed, staying on ${pkg.version}: ${failure}`);
        return;
      }
      log(`Updated to ${latest}; restarting.`);
      stopped = true;
      onUpdated(latest);
    } catch (error) {
      log(`Update check failed: ${error instanceof Error ? error.message : error}`);
    } finally {
      if (!stopped) {
        timer = setTimeout(tick, intervalMs);
        timer.unref?.();
      }
    }
  };
  timer = setTimeout(tick, firstMs);
  timer.unref?.();
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}
