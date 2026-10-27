import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";
import test from "node:test";
import { parseClaudeUsage, readCodexUsage } from "./usage.ts";

test("Claude /usage text becomes windows with percent used", () => {
  const usage = parseClaudeUsage(`You are using your subscription

Current session: 3% used · resets Oct 27 at 8:40pm (Asia/Calcutta)
Current week (all models): 25% used · resets Oct 30 at 8:30pm (Asia/Calcutta)
Current week (Fable): 0% used · resets Oct 30 at 8:30pm (Asia/Calcutta)
`, "2026-10-27T00:00:00Z");
  assert.deepEqual(usage?.windows?.map((w) => [w.label, w.usedPercent]), [["session", 3], ["week", 25], ["week (Fable)", 0]]);
  assert.equal(usage?.windows?.[0]?.resetsText, "Oct 27 at 8:40pm (Asia/Calcutta)");
  assert.equal(parseClaudeUsage("nothing here"), null);
});

test("Codex limits come from the newest session that has them", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-"));
  await mkdir(join(root, "2026", "10"), { recursive: true });
  const event = { payload: { rate_limits: { plan_type: "plus", primary: { used_percent: 40, window_minutes: 300, resets_at: 1792872300 }, secondary: { used_percent: 1, window_minutes: 10080, resets_at: 1793421093 } } } };
  await writeFile(join(root, "2026", "10", "rollout-a.jsonl"), `{"x":1}\n${JSON.stringify(event)}\n{"y":2}\n`);
  const usage = readCodexUsage(root);
  assert.equal(usage?.account, "plus");
  assert.deepEqual(usage?.windows?.map((w) => [w.label, w.usedPercent]), [["5h", 40], ["weekly", 1]]);
  assert.equal(readCodexUsage(join(root, "missing")), null);
});
