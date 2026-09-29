import {
  createHash,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { IncomingMessage } from "node:http";

const DEFAULT_SESSION_TTL_MS = 8 * 60 * 60 * 1_000;
const DEFAULT_COOKIE_NAME = "hosted_agents_session";
const DEFAULT_CSRF_COOKIE_NAME = "hosted_agents_csrf";
const SCRYPT_COST = 16_384;
const SCRYPT_BLOCK_SIZE = 8;
const SCRYPT_PARALLELIZATION = 1;
const SCRYPT_KEY_LENGTH = 32;

interface StoredSession {
  csrfToken: string;
  expiresAt: number;
}

interface LoginAttempt {
  failures: number;
  firstFailureAt: number;
  blockedUntil: number;
}

export interface UiAuthOptions {
  password?: string;
  passwordHash?: string;
  sessionTtlMs?: number;
  cookieName?: string;
  csrfCookieName?: string;
  secureCookies?: boolean;
}

export interface UiAuthRequest {
  authenticated: boolean;
  method: "ui" | "bearer" | "none";
  sessionToken?: string;
  csrfToken?: string;
}

/**
 * Single-operator Hub authentication.
 *
 * The plaintext password is accepted only as a bootstrap input so deployments
 * can use an environment secret. It is immediately converted to an scrypt
 * verifier and is never retained. Production deployments may provide the
 * encoded verifier directly through HOSTED_AGENTS_UI_PASSWORD_HASH.
 */
export class UiAuth {
  readonly enabled: boolean;
  readonly cookieName: string;
  readonly csrfCookieName: string;
  readonly secureCookies: boolean;
  private readonly verifier?: PasswordVerifier;
  private readonly sessionTtlMs: number;
  private readonly sessions = new Map<string, StoredSession>();
  private readonly loginAttempts = new Map<string, LoginAttempt>();

  constructor(options: UiAuthOptions = {}) {
    const passwordHash = options.passwordHash
      ?? process.env.HOSTED_AGENTS_UI_PASSWORD_HASH;
    const password = options.password ?? process.env.HOSTED_AGENTS_UI_PASSWORD;
    this.verifier = passwordHash
      ? parsePasswordVerifier(passwordHash)
      : password
        ? createPasswordVerifier(password)
        : undefined;
    this.enabled = this.verifier !== undefined;
    this.sessionTtlMs = options.sessionTtlMs
      ?? Number(process.env.HOSTED_AGENTS_UI_SESSION_TTL_MS ?? DEFAULT_SESSION_TTL_MS);
    this.cookieName = options.cookieName ?? DEFAULT_COOKIE_NAME;
    this.csrfCookieName = options.csrfCookieName ?? DEFAULT_CSRF_COOKIE_NAME;
    this.secureCookies = options.secureCookies
      ?? process.env.HOSTED_AGENTS_COOKIE_SECURE === "true";
  }

  authenticate(request: IncomingMessage, bearerToken?: string): UiAuthRequest {
    if (bearerToken && request.headers.authorization === `Bearer ${bearerToken}`) {
      return { authenticated: true, method: "bearer" };
    }
    if (!this.enabled) return { authenticated: true, method: "none" };

    const cookies = parseCookies(request.headers.cookie);
    const sessionToken = cookies[this.cookieName];
    if (!sessionToken) return { authenticated: false, method: "none" };
    const session = this.sessions.get(sessionToken);
    if (!session || session.expiresAt <= Date.now()) {
      if (session) this.sessions.delete(sessionToken);
      return { authenticated: false, method: "none" };
    }
    return {
      authenticated: true,
      method: "ui",
      sessionToken,
      csrfToken: session.csrfToken,
    };
  }

  canAttemptLogin(clientKey: string): boolean {
    const attempt = this.loginAttempts.get(clientKey);
    return !attempt || attempt.blockedUntil <= Date.now();
  }

  verifyPassword(clientKey: string, password: string): boolean {
    if (!this.enabled || !this.verifier || !this.canAttemptLogin(clientKey)) return false;
    if (verifyPassword(password, this.verifier)) {
      this.loginAttempts.delete(clientKey);
      return true;
    }
    const now = Date.now();
    const current = this.loginAttempts.get(clientKey);
    const attempt = current && now - current.firstFailureAt < 15 * 60_000
      ? current
      : { failures: 0, firstFailureAt: now, blockedUntil: 0 };
    attempt.failures += 1;
    attempt.blockedUntil = attempt.failures >= 10 ? now + 15 * 60_000 : 0;
    this.loginAttempts.set(clientKey, attempt);
    return false;
  }

  createSession(): { token: string; csrfToken: string; expiresAt: number } {
    if (!this.enabled) throw new Error("UI password authentication is disabled");
    const token = randomToken();
    const csrfToken = randomToken();
    const expiresAt = Date.now() + this.sessionTtlMs;
    this.sessions.set(token, { csrfToken, expiresAt });
    this.pruneSessions();
    return { token, csrfToken, expiresAt };
  }

  revoke(request: IncomingMessage): void {
    const token = parseCookies(request.headers.cookie)[this.cookieName];
    if (token) this.sessions.delete(token);
  }

  isCsrfValid(request: IncomingMessage, auth: UiAuthRequest): boolean {
    if (!this.enabled || auth.method !== "ui") return true;
    const origin = request.headers.origin;
    if (origin) return sameOrigin(origin, request);
    const referer = request.headers.referer;
    if (typeof referer === "string") {
      try {
        if (sameOrigin(new URL(referer).origin, request)) return true;
      } catch {
        // Fall through to the explicit CSRF header check.
      }
    }
    const header = request.headers["x-csrf-token"];
    return typeof header === "string"
      && typeof auth.csrfToken === "string"
      && safeEqual(header, auth.csrfToken);
  }

  isOriginValid(request: IncomingMessage): boolean {
    const origin = request.headers.origin;
    return !origin || sameOrigin(origin, request);
  }

  sessionCookie(token: string, request: IncomingMessage): string {
    return serializeCookie(
      this.cookieName,
      token,
      this.cookieOptions(request, true),
    );
  }

  csrfCookie(token: string, request: IncomingMessage): string {
    return serializeCookie(
      this.csrfCookieName,
      token,
      this.cookieOptions(request, false),
    );
  }

  clearCookies(request: IncomingMessage): string[] {
    return [
      serializeCookie(this.cookieName, "", {
        ...this.cookieOptions(request, true),
        maxAge: 0,
      }),
      serializeCookie(this.csrfCookieName, "", {
        ...this.cookieOptions(request, false),
        maxAge: 0,
      }),
    ];
  }

  getCsrfToken(request: IncomingMessage, auth: UiAuthRequest): string | undefined {
    if (!this.enabled || auth.method !== "ui") return undefined;
    return auth.csrfToken;
  }

  private cookieOptions(
    request: IncomingMessage,
    httpOnly: boolean,
  ): CookieOptions {
    const forwardedProto = request.headers["x-forwarded-proto"];
    const isHttps = this.secureCookies
      || forwardedProto === "https"
      || request.socket.encrypted === true;
    return {
      httpOnly,
      secure: isHttps,
      sameSite: "Lax",
      path: "/",
      maxAge: Math.floor(this.sessionTtlMs / 1_000),
    };
  }

  private pruneSessions(): void {
    const now = Date.now();
    for (const [token, session] of this.sessions) {
      if (session.expiresAt <= now) this.sessions.delete(token);
    }
    if (this.sessions.size <= 1_000) return;
    const oldest = [...this.sessions.entries()]
      .sort((left, right) => left[1].expiresAt - right[1].expiresAt)
      .slice(0, this.sessions.size - 1_000);
    for (const [token] of oldest) this.sessions.delete(token);
  }
}

interface PasswordVerifier {
  salt: Buffer;
  hash: Buffer;
  cost: number;
  blockSize: number;
  parallelization: number;
}

function createPasswordVerifier(password: string): PasswordVerifier {
  const salt = randomBytes(16);
  return {
    salt,
    hash: scryptSync(password, salt, SCRYPT_KEY_LENGTH, {
      N: SCRYPT_COST,
      r: SCRYPT_BLOCK_SIZE,
      p: SCRYPT_PARALLELIZATION,
    }),
    cost: SCRYPT_COST,
    blockSize: SCRYPT_BLOCK_SIZE,
    parallelization: SCRYPT_PARALLELIZATION,
  };
}

function parsePasswordVerifier(encoded: string): PasswordVerifier {
  const [algorithm, cost, blockSize, parallelization, saltText, hashText] = encoded.split("$");
  if (
    algorithm !== "scrypt"
    || !Number.isInteger(Number(cost))
    || !Number.isInteger(Number(blockSize))
    || !Number.isInteger(Number(parallelization))
    || !saltText
    || !hashText
  ) {
    throw new Error("HOSTED_AGENTS_UI_PASSWORD_HASH must use scrypt$N$r$p$salt$hash format");
  }
  const salt = Buffer.from(saltText, "base64url");
  const hash = Buffer.from(hashText, "base64url");
  if (salt.length < 16 || hash.length !== SCRYPT_KEY_LENGTH) {
    throw new Error("HOSTED_AGENTS_UI_PASSWORD_HASH has invalid salt or hash");
  }
  return {
    salt,
    hash,
    cost: Number(cost),
    blockSize: Number(blockSize),
    parallelization: Number(parallelization),
  };
}

function verifyPassword(password: string, verifier: PasswordVerifier): boolean {
  const actual = scryptSync(password, verifier.salt, verifier.hash.length, {
    N: verifier.cost,
    r: verifier.blockSize,
    p: verifier.parallelization,
  });
  return safeEqual(actual, verifier.hash);
}

export function encodePasswordVerifier(verifier: PasswordVerifier): string {
  return [
    "scrypt",
    verifier.cost,
    verifier.blockSize,
    verifier.parallelization,
    verifier.salt.toString("base64url"),
    verifier.hash.toString("base64url"),
  ].join("$");
}

export function createUiPasswordHash(password: string): string {
  return encodePasswordVerifier(createPasswordVerifier(password));
}

export interface ResolveUiAuthOptions {
  /** Directory that holds hub-ui-auth.json (usually dirname of hub state path). */
  dataDir?: string;
  password?: string;
  passwordHash?: string;
  sessionTtlMs?: number;
  secureCookies?: boolean;
}

export interface ResolvedUiAuth {
  auth: UiAuth;
  /**
   * Auto-generated Hub password. Present whenever the bootstrap plaintext is
   * still on disk (password has not been replaced by env or a hash-only file).
   * Print this on every Hub start until the operator changes it.
   */
  revealPassword?: string;
}

const BOOTSTRAP_AUTH_FILE = "hub-ui-auth.json";

/**
 * Resolve Hub UI auth for process start.
 *
 * Priority: explicit/env hash → explicit/env password → durable bootstrap file
 * → generate a new bootstrap password. Ephemeral mode (no dataDir) leaves auth
 * disabled so unit tests stay open unless a password is supplied.
 */
export function resolveUiAuth(options: ResolveUiAuthOptions = {}): ResolvedUiAuth {
  const passwordHash = options.passwordHash
    ?? process.env.HOSTED_AGENTS_UI_PASSWORD_HASH;
  const password = options.password ?? process.env.HOSTED_AGENTS_UI_PASSWORD;
  const common = {
    sessionTtlMs: options.sessionTtlMs,
    secureCookies: options.secureCookies,
  };

  if (passwordHash || password) {
    if (options.dataDir) clearBootstrapPlaintext(options.dataDir);
    return {
      auth: new UiAuth({
        ...common,
        passwordHash,
        password,
      }),
    };
  }

  if (!options.dataDir) {
    return { auth: new UiAuth(common) };
  }

  const bootstrap = loadOrCreateBootstrapAuth(options.dataDir);
  return {
    auth: new UiAuth({
      ...common,
      passwordHash: bootstrap.hash,
    }),
    revealPassword: bootstrap.password,
  };
}

interface BootstrapAuthFile {
  hash: string;
  /** Omitted once the operator replaces the auto-generated password. */
  password?: string;
}

function bootstrapAuthPath(dataDir: string): string {
  return join(dataDir, BOOTSTRAP_AUTH_FILE);
}

function loadOrCreateBootstrapAuth(dataDir: string): { hash: string; password?: string } {
  mkdirSync(dataDir, { recursive: true });
  const path = bootstrapAuthPath(dataDir);
  if (existsSync(path)) {
    const raw = JSON.parse(readFileSync(path, "utf8")) as BootstrapAuthFile;
    if (typeof raw.hash !== "string" || raw.hash.length === 0) {
      throw new Error(`${BOOTSTRAP_AUTH_FILE} is missing a password hash`);
    }
    parsePasswordVerifier(raw.hash);
    if (typeof raw.password === "string" && raw.password.length > 0) {
      return { hash: raw.hash, password: raw.password };
    }
    return { hash: raw.hash };
  }

  const password = randomBytes(18).toString("base64url");
  const hash = createUiPasswordHash(password);
  writeBootstrapAuth(dataDir, { hash, password });
  return { hash, password };
}

function writeBootstrapAuth(dataDir: string, value: BootstrapAuthFile): void {
  mkdirSync(dataDir, { recursive: true });
  const path = bootstrapAuthPath(dataDir);
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    // Windows may ignore mode; the file still holds the bootstrap secret locally.
  }
}

/**
 * Drop the printable bootstrap password after the operator configures their own.
 * Keeps the hash file only when one already existed.
 */
export function clearBootstrapPlaintext(dataDir: string): void {
  const path = bootstrapAuthPath(dataDir);
  if (!existsSync(path)) return;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as BootstrapAuthFile;
    if (typeof raw.hash === "string" && raw.hash.length > 0 && raw.password) {
      writeBootstrapAuth(dataDir, { hash: raw.hash });
      return;
    }
    if (raw.password) unlinkSync(path);
  } catch {
    // Ignore malformed bootstrap files when clearing.
  }
}

/**
 * Replace the Hub UI password and stop printing plaintext on startup.
 */
export function setUiPassword(dataDir: string, password: string): string {
  if (!password) throw new Error("Password is required");
  const hash = createUiPasswordHash(password);
  writeBootstrapAuth(dataDir, { hash });
  return hash;
}

function randomToken(): string {
  return randomBytes(32).toString("base64url");
}

interface CookieOptions {
  httpOnly: boolean;
  secure: boolean;
  sameSite: "Lax" | "Strict";
  path: string;
  maxAge: number;
}

function serializeCookie(name: string, value: string, options: CookieOptions): string {
  return [
    `${name}=${encodeURIComponent(value)}`,
    `Path=${options.path}`,
    `Max-Age=${options.maxAge}`,
    `SameSite=${options.sameSite}`,
    options.httpOnly ? "HttpOnly" : "",
    options.secure ? "Secure" : "",
  ].filter(Boolean).join("; ");
}

function parseCookies(header: string | undefined): Record<string, string> {
  const cookies: Record<string, string> = {};
  for (const item of header?.split(";") ?? []) {
    const separator = item.indexOf("=");
    if (separator < 1) continue;
    const name = item.slice(0, separator).trim();
    const value = item.slice(separator + 1).trim();
    try {
      cookies[name] = decodeURIComponent(value);
    } catch {
      cookies[name] = value;
    }
  }
  return cookies;
}

function safeEqual(left: string | Buffer, right: string | Buffer): boolean {
  const leftBuffer = typeof left === "string" ? createHash("sha256").update(left).digest() : left;
  const rightBuffer = typeof right === "string" ? createHash("sha256").update(right).digest() : right;
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function sameOrigin(origin: string, request: IncomingMessage): boolean {
  try {
    const parsed = new URL(origin);
    const forwardedHost = request.headers["x-forwarded-host"];
    const host = typeof forwardedHost === "string"
      ? forwardedHost.split(",")[0]!.trim()
      : request.headers.host;
    return parsed.host === host;
  } catch {
    return false;
  }
}
