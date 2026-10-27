import { execFile } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

export interface UsageWindow {
  label: string;
  usedPercent: number;
  /** ISO time, when the agent reports a machine-readable reset. */
  resetsAt?: string;
  /** The agent's own wording, when that is all it gives (Claude Code). */
  resetsText?: string;
}

export interface AgentUsage {
  label: string;
  account?: string;
  windows?: UsageWindow[];
  asOf: string;
}

/**
 * Reads Claude Code's limits out of the text `claude -p "/usage"` prints.
 * @param {string} text - Command output.
 * @param {string} [asOf] - ISO time stamped on the result.
 * @returns {AgentUsage | null} Usage with one window per "Current …" line, or null when there are none.
 */
export function parseClaudeUsage(text: string, asOf = new Date().toISOString()): AgentUsage | null {
  const windows = [...text.matchAll(/^Current (.+?): (\d+)% used · resets (.+)$/gm)].map(([, label, percent, resetsText]) => ({
    label: label === "week (all models)" ? "week" : label!,
    usedPercent: Number(percent),
    resetsText: resetsText!,
  }));
  return windows.length > 0 ? { label: "Claude Code", windows, asOf } : null;
}

/**
 * Reads Codex's 5h and weekly limits from the newest session file that recorded `rate_limits`.
 * Codex only writes them while it runs, so the reading can be old: `asOf` is that file's time.
 * @param {string} [root] - Codex sessions directory.
 * @returns {AgentUsage | null} Usage, or null when no recent session has limits.
 */
export function readCodexUsage(root = join(homedir(), ".codex", "sessions")): AgentUsage | null {
  const files: Array<{ path: string; mtime: number }> = [];
  const walk = (dir: string) => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (/^rollout-.*\.jsonl$/.test(entry.name)) files.push({ path, mtime: statSync(path).mtimeMs });
    }
  };
  walk(root);
  for (const file of files.sort((a, b) => b.mtime - a.mtime).slice(0, 5)) {
    const line = readFileSync(file.path, "utf8").split("\n").reverse().find((l) => l.includes('"rate_limits"'));
    const limits = line ? JSON.parse(line)?.payload?.rate_limits : undefined;
    if (!limits) continue;
    const windowOf = (w: { window_minutes: number; used_percent: number; resets_at: number } | undefined): UsageWindow | undefined => w && ({
      label: w.window_minutes >= 10080 ? "weekly" : `${Math.round(w.window_minutes / 60)}h`,
      usedPercent: w.used_percent,
      resetsAt: new Date(w.resets_at * 1000).toISOString(),
    });
    return {
      label: "Codex",
      ...(limits.plan_type ? { account: String(limits.plan_type) } : {}),
      windows: [windowOf(limits.primary), windowOf(limits.secondary)].filter((w): w is UsageWindow => Boolean(w)),
      asOf: new Date(file.mtime).toISOString(),
    };
  }
  return null;
}

/**
 * Runs a CLI and returns its stdout, or null when it is missing, fails or times out.
 * @param {string} command - Executable (a bare name is looked up on PATH, plus ~/.local/bin).
 * @param {string[]} args - Arguments.
 * @param {number} timeout - Milliseconds before the process is killed.
 * @returns {Promise<string | null>} Output, or null.
 */
async function output(command: string, args: string[], timeout: number): Promise<string | null> {
  const env = { ...process.env, PATH: `${process.env.PATH ?? ""}:${join(homedir(), ".local", "bin")}` };
  try {
    const { stdout } = await run(command, args, { timeout, env, encoding: "utf8", shell: process.platform === "win32" });
    return stdout;
  } catch {
    return null;
  }
}

/**
 * Collects what each coding agent on this machine reports about its usage, by calling the agents themselves:
 * `claude -p "/usage"` (limits), the newest Codex session's rate limits, and `agent status` (Cursor account only,
 * Cursor reports no limits). An agent that is missing or signed out is left out.
 * @returns {Promise<Record<string, AgentUsage>>} Usage keyed by `claude`, `codex`, `cursor`.
 */
export async function collectUsage(): Promise<Record<string, AgentUsage>> {
  const asOf = new Date().toISOString();
  const [claude, cursor] = await Promise.all([
    output("claude", ["-p", "/usage"], 30_000),
    output("agent", ["status"], 8_000),
  ]);
  const result: Record<string, AgentUsage> = {};
  const claudeUsage = claude ? parseClaudeUsage(claude, asOf) : null;
  if (claudeUsage) result.claude = claudeUsage;
  const codex = readCodexUsage();
  if (codex) result.codex = codex;
  if (cursor && !/not logged in|login required/i.test(cursor)) {
    result.cursor = { label: "Cursor", account: cursor.replace(/^\S+\s+Logged in as\s*/i, "").split("\n")[0]!.trim(), asOf };
  }
  return result;
}
