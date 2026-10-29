import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface PackageInfo {
  name: string;
  version: string;
}

const UNKNOWN: PackageInfo = { name: "cloudagentfleet", version: "0.0.0-dev" };

/**
 * The package a bundle or source file ships in, read from the package.json one
 * folder above it (`dist/` in an npm install, `src/` in a checkout). A flat
 * bundle with no package beside it reports a development version.
 */
export function readPackageInfo(moduleUrl: string): PackageInfo {
  try {
    const manifest = JSON.parse(readFileSync(join(dirname(fileURLToPath(moduleUrl)), "..", "package.json"), "utf8")) as {
      name?: unknown;
      version?: unknown;
    };
    if (typeof manifest.name === "string" && typeof manifest.version === "string") {
      return { name: manifest.name, version: manifest.version };
    }
  } catch {
    // No package.json beside the bundle.
  }
  return UNKNOWN;
}

/** A version a Worker may report: short and free of anything but version characters. */
export function sanitizeVersion(value: unknown): string | undefined {
  return typeof value === "string" && value.length <= 64 && /^[0-9A-Za-z][0-9A-Za-z.+-]*$/.test(value)
    ? value
    : undefined;
}

/** Negative when `a` is older than `b`; a prerelease sorts before its release. */
export function compareVersions(a: string, b: string): number {
  const parse = (value: string) => {
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
export async function fetchLatestVersion(
  packageName: string,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 5_000,
): Promise<string | undefined> {
  try {
    const response = await fetchImpl(`https://registry.npmjs.org/${packageName.replace("/", "%2f")}/latest`, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return undefined;
    return sanitizeVersion(((await response.json()) as { version?: unknown }).version);
  } catch {
    return undefined;
  }
}
