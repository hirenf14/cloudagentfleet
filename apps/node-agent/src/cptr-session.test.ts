import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CptrSessions } from "./cptr-session.ts";

function jwt(exp: number): string {
  const part = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${part({ alg: "HS256" })}.${part({ sub: "1", exp })}.signature`;
}

test("CptrSessions signs in locally, caches the session, and renews it near expiry", async () => {
  const directory = mkdtempSync(join(tmpdir(), "cloudagentfleet-cptr-session-"));
  try {
    const credentialsPath = join(directory, "cptr-credentials.json");
    writeFileSync(credentialsPath, JSON.stringify({ username: "fleet", password: "secret-pass" }));
    let now = 1_000_000_000;
    const logins: unknown[] = [];
    const sessions = new CptrSessions({
      baseUrl: "http://127.0.0.1:8000/",
      credentialsPath,
      now: () => now,
      fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
        assert.equal(String(url), "http://127.0.0.1:8000/api/auth/login");
        logins.push(JSON.parse(String(init?.body)));
        return new Response("{}", {
          headers: { "set-cookie": `cptr_session=${jwt(now / 1000 + 30 * 86400)}; HttpOnly; Path=/; SameSite=lax` },
        });
      }) as typeof fetch,
    });
    const [first, concurrent] = await Promise.all([sessions.session(), sessions.session()]);
    assert.equal(first, concurrent);
    assert.equal(first.expiresAt, now + 30 * 86400 * 1000);
    assert.deepEqual(logins, [{ username: "fleet", password: "secret-pass" }]);
    now += 28 * 86400 * 1000;
    await sessions.session();
    assert.equal(logins.length, 1, "cached while more than a day remains");
    now += 2 * 86400 * 1000 - 1;
    await sessions.session();
    assert.equal(logins.length, 2, "renewed in the last day");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("CptrSessions fails clearly without credentials or a session cookie", async () => {
  const directory = mkdtempSync(join(tmpdir(), "cloudagentfleet-cptr-session-"));
  try {
    const credentialsPath = join(directory, "cptr-credentials.json");
    const missing = new CptrSessions({ baseUrl: "http://127.0.0.1:8000", credentialsPath, fetchImpl: () => assert.fail() });
    await assert.rejects(() => missing.session(), /No Open WebUI Computer sign-in is configured/);
    writeFileSync(credentialsPath, JSON.stringify({ username: "fleet", password: "wrong" }));
    const refused = new CptrSessions({
      baseUrl: "http://127.0.0.1:8000",
      credentialsPath,
      fetchImpl: (async () => Response.json({ error: "incorrect credentials" }, { status: 401 })) as typeof fetch,
    });
    await assert.rejects(() => refused.session(), /HTTP 401/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
