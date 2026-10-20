import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * Signs browsers in to the Worker's own Open WebUI Computer (cptr) on behalf
 * of the Hub. The account's password stays on this machine in an owner-only
 * file; the Hub only ever receives a cptr session token, which it hands to a
 * browser that is already signed in to the Hub.
 */
export interface CptrCredentials {
  username: string;
  password: string;
}

export interface CptrSession {
  token: string;
  /** Epoch milliseconds when cptr stops accepting the token. */
  expiresAt: number;
}

/** The account the Worker creates during cptr's first-run setup. */
export const CPTR_FLEET_USERNAME = "fleet";

const SESSION_COOKIE = /(?:^|[;,]\s*)cptr_session=([^;,\s]+)/;
/** Mint a fresh session this long before the cached one expires. */
const RENEW_BEFORE_MS = 24 * 3600 * 1000;

export function cptrCredentialsPath(home: string = homedir()): string {
  return join(home, ".cloudagentfleet", "cptr-credentials.json");
}

export function readCptrCredentials(path: string): CptrCredentials | undefined {
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as Partial<CptrCredentials>;
    return typeof value.username === "string" && typeof value.password === "string"
      ? { username: value.username, password: value.password }
      : undefined;
  } catch {
    return undefined;
  }
}

function writeCptrCredentials(path: string, credentials: CptrCredentials): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(credentials, null, 2)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
}

/**
 * Completes cptr's first-run setup with the one-time startup token: creates
 * the `fleet` admin account with a random password and saves it (0600).
 */
export async function completeCptrSetup(options: {
  baseUrl: string;
  token: string;
  credentialsPath: string;
  fetchImpl?: typeof fetch;
}): Promise<CptrCredentials> {
  const credentials = { username: CPTR_FLEET_USERNAME, password: randomBytes(24).toString("base64url") };
  const response = await (options.fetchImpl ?? fetch)(`${options.baseUrl}/api/auth/setup`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...credentials, token: options.token, display_name: "Cloud Agent Fleet" }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`cptr setup failed with HTTP ${response.status}`);
  writeCptrCredentials(options.credentialsPath, credentials);
  return credentials;
}

export class CptrSessions {
  private readonly baseUrl: string;
  private readonly credentialsPath: string;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private cached: CptrSession | undefined;
  private pending: Promise<CptrSession> | undefined;

  constructor(options: { baseUrl: string; credentialsPath?: string; fetchImpl?: typeof fetch; now?: () => number }) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.credentialsPath = options.credentialsPath ?? cptrCredentialsPath();
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? Date.now;
  }

  /** A session for the Hub to hand to a browser; cached, because cptr rate-limits logins. */
  async session(): Promise<CptrSession> {
    if (this.cached && this.cached.expiresAt - RENEW_BEFORE_MS > this.now()) return this.cached;
    this.pending ??= this.login().finally(() => {
      this.pending = undefined;
    });
    this.cached = await this.pending;
    return this.cached;
  }

  private async login(): Promise<CptrSession> {
    const credentials = readCptrCredentials(this.credentialsPath);
    if (!credentials) {
      throw new Error(`No Open WebUI Computer sign-in is configured (${this.credentialsPath})`);
    }
    const response = await this.fetchImpl(`${this.baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(credentials),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`Open WebUI Computer sign-in failed with HTTP ${response.status}`);
    const setCookie = response.headers.getSetCookie?.().join(", ") ?? response.headers.get("set-cookie") ?? "";
    const token = setCookie.match(SESSION_COOKIE)?.[1];
    if (!token) throw new Error("Open WebUI Computer sign-in returned no session");
    return { token, expiresAt: tokenExpiry(token) ?? this.now() + RENEW_BEFORE_MS * 2 };
  }
}

/** The `exp` claim of cptr's session JWT, in epoch milliseconds. */
function tokenExpiry(token: string): number | undefined {
  try {
    const payload = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8")) as { exp?: unknown };
    return typeof payload.exp === "number" ? payload.exp * 1000 : undefined;
  } catch {
    return undefined;
  }
}
