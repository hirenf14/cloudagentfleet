import { request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import type {
  AgentProfile,
  BackendFeature,
  HostInstance,
  WorkspaceDescriptor,
} from "../../../../packages/protocol/src/index.ts";
import { validateHostInstance } from "../../../../packages/protocol/src/index.ts";
import type { BackendDefinition, HostAdapter, NativeUiProxy } from "../contract.ts";
import { namespacedCookieBridge, type CookieBridge } from "../shared/cookies.ts";
import { proxyHttpRequest } from "../shared/http-proxy.ts";
import { proxyWebSocket } from "../shared/ws-relay.ts";

/**
 * Open WebUI Computer (`cptr`). The Hub reaches it either over the tailnet
 * (`tailscale-url`: proxied, or opened directly with the `link` capability)
 * or through the Worker's outbound connector, where the cptr driver tunnels
 * bytes to the cptr running next to the Worker (`connector`). cptr's internal
 * API is undocumented and cookie-authenticated, so no sessions or terminal
 * facets are offered (docs/BACKEND-ABSTRACTION.md, Spike S).
 *
 * cptr's license forbids altering its branding: the proxy never injects the
 * fleet switcher into cptr pages, and cptr is linked to, never bundled.
 */
export const CPTR_LINK_FEATURES: readonly BackendFeature[] = ["native-ui-link"];
export const CPTR_PROXY_FEATURES: readonly BackendFeature[] = ["native-ui-proxy"];

/** Capability that keeps an instance in link mode. */
export const CPTR_LINK_CAPABILITY = "link";

/** cptr's own session cookie (HttpOnly JWT, `Path=/`). */
const CPTR_SESSION_COOKIE = "cptr_session";

/** Stands in for the endpoint when the Worker tunnel decides where bytes go. */
const CONNECTOR_ENDPOINT = "http://cptr.connector";

export interface CptrAdapterOptions {
  instance: HostInstance;
  fetchImpl?: typeof fetch;
  /** Worker connector tunnel; when set, cptr is reached through the Worker, not the tailnet. */
  connect?: () => Duplex;
  /**
   * Asks the Worker for a cptr session (connector `cptr.session`), so a browser
   * signed in to the Hub is signed in to cptr too. cptr's password stays on
   * the Worker's machine; the Hub only relays the session token.
   */
  signIn?: () => Promise<unknown>;
  now?: () => number;
}

interface HubSignIn {
  token: string;
  expiresAt: number;
}

/** How long to wait for the Worker; an older Worker never answers. */
const SIGN_IN_TIMEOUT_MS = 5_000;
/** After a failed sign-in, show cptr's own login for a while instead of retrying. */
const SIGN_IN_RETRY_MS = 60_000;

abstract class CptrAdapter implements HostAdapter {
  readonly instance: HostInstance;
  abstract readonly features: readonly BackendFeature[];
  protected readonly fetchImpl: typeof fetch;
  protected readonly connect?: () => Duplex;

  constructor(options: CptrAdapterOptions) {
    this.instance = validateHostInstance(options.instance);
    this.connect = options.connect;
    if (!this.instance.endpoint && !this.connect) throw new Error("Open WebUI Computer requires an endpoint");
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  protected get endpointUrl(): URL {
    return new URL(this.instance.endpoint ?? CONNECTOR_ENDPOINT);
  }

  /** Probes cptr's unauthenticated `/api/health`; agents are configured inside cptr. */
  async listAgents(): Promise<AgentProfile[]> {
    const { status, body } = this.connect
      ? await getJsonOverStream(this.connect, "/api/health")
      : await this.fetchJson("/api/health");
    if (status < 200 || status >= 300) throw new Error(`Open WebUI Computer health check failed with HTTP ${status}`);
    if ((body as { status?: unknown } | undefined)?.status !== "ok") {
      throw new Error("Open WebUI Computer health check returned an unexpected body");
    }
    return this.instance.agents.map((agent) => ({ ...agent }));
  }

  async listWorkspaces(): Promise<WorkspaceDescriptor[]> {
    return this.instance.workspaces;
  }

  private async fetchJson(path: string): Promise<{ status: number; body: unknown }> {
    const response = await this.fetchImpl(`${this.instance.endpoint!.replace(/\/+$/, "")}${path}`, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(5_000),
    });
    return { status: response.status, body: await response.json().catch(() => undefined) };
  }
}

export class CptrLinkAdapter extends CptrAdapter {
  readonly features = CPTR_LINK_FEATURES;
}

/**
 * Proxies cptr on the host-UI origin. The browser signs in with cptr's own
 * login once; its `cptr_session` cookie is stored under a per-instance name
 * and is the only cookie that crosses the proxy.
 */
export class CptrProxyAdapter extends CptrAdapter implements NativeUiProxy {
  readonly features = CPTR_PROXY_FEATURES;
  private readonly cookies: CookieBridge;
  private readonly signIn?: () => Promise<unknown>;
  private readonly now: () => number;
  private session: HubSignIn | undefined;
  private pendingSession: Promise<HubSignIn | undefined> | undefined;
  private signInRetryAt = 0;

  constructor(options: CptrAdapterOptions) {
    super(options);
    this.cookies = namespacedCookieBridge(this.instance.id, [CPTR_SESSION_COOKIE]);
    this.signIn = options.signIn;
    this.now = options.now ?? Date.now;
  }

  /** A cptr session for a browser that has none yet; undefined shows cptr's own login. */
  private async hubSignIn(): Promise<HubSignIn | undefined> {
    if (!this.signIn) return undefined;
    if (this.session && this.session.expiresAt - SIGN_IN_RETRY_MS > this.now()) return this.session;
    if (this.now() < this.signInRetryAt) return undefined;
    this.pendingSession ??= withTimeout(this.signIn(), SIGN_IN_TIMEOUT_MS)
      .then((value) => {
        const session = parseSignIn(value);
        if (!session) throw new Error("Unexpected sign-in response");
        return session;
      })
      .catch(() => {
        this.signInRetryAt = this.now() + SIGN_IN_RETRY_MS;
        return undefined;
      })
      .finally(() => {
        this.pendingSession = undefined;
      });
    const session = await this.pendingSession;
    if (session) this.session = session;
    return session;
  }

  /** Sends the Hub-made session upstream and stores it under the bridged browser cookie. */
  private async signInOptions(request: IncomingMessage): Promise<{ upstreamCookie?: string; setCookies?: string[] }> {
    if (this.cookies.toUpstream(request.headers.cookie)) return {};
    const session = await this.hubSignIn();
    if (!session) return {};
    const maxAge = Math.max(0, Math.floor((session.expiresAt - this.now()) / 1000));
    return {
      upstreamCookie: `${CPTR_SESSION_COOKIE}=${session.token}`,
      setCookies: this.cookies.fromUpstream([
        `${CPTR_SESSION_COOKIE}=${session.token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${maxAge}`,
      ]),
    };
  }

  get nativeUi(): NativeUiProxy {
    return this;
  }

  get browserCookieNames(): readonly string[] {
    return this.cookies.browserNames;
  }

  async proxyHttp(request: IncomingMessage, response: ServerResponse): Promise<void> {
    await proxyHttpRequest(request, response, {
      endpoint: this.endpointUrl,
      ...(this.connect ? { connect: this.connect } : {}),
      label: "Open WebUI Computer",
      // cptr's in-app browser routes preview resources by Referer.
      forwardReferer: true,
      cookies: this.cookies,
      ...await this.signInOptions(request),
    });
  }

  async proxyUpgrade(request: IncomingMessage, clientSocket: Duplex, head: Buffer): Promise<void> {
    const requestUrl = new URL(request.url ?? "/", "http://controller.local");
    await proxyWebSocket(request, clientSocket, head, {
      endpoint: this.endpointUrl,
      ...(this.connect ? { connect: this.connect } : {}),
      path: `${requestUrl.pathname}${requestUrl.search}`,
      label: "Open WebUI Computer",
      cookies: this.cookies,
      upstreamCookie: (await this.signInOptions(request)).upstreamCookie,
    });
  }
}

function parseSignIn(value: unknown): HubSignIn | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const { token, expiresAt } = value as { token?: unknown; expiresAt?: unknown };
  // A JWT: anything else could inject cookie attributes.
  if (typeof token !== "string" || !/^[A-Za-z0-9._-]+$/.test(token)) return undefined;
  if (typeof expiresAt !== "number" || !Number.isFinite(expiresAt)) return undefined;
  return { token, expiresAt };
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Timed out")), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

export const cptrBackend: BackendDefinition = {
  backend: "cptr",
  label: "Open WebUI Computer",
  connectionModes: ["tailscale-url", "connector"],
  features: (connectionMode) => connectionMode === "connector"
    ? CPTR_PROXY_FEATURES
    : [...CPTR_PROXY_FEATURES, ...CPTR_LINK_FEATURES],
  defaultAgents: () => [],
  createAdapter: (instance, { connector }) => {
    if (instance.connectionMode === "connector") {
      const openStream = connector?.openStream;
      if (!openStream) throw new Error(`Connector tunnel is not configured: ${instance.id}`);
      return new CptrProxyAdapter({
        instance,
        connect: () => openStream(),
        signIn: () => connector.request("cptr.session"),
      });
    }
    return instance.capabilities.includes(CPTR_LINK_CAPABILITY)
      ? new CptrLinkAdapter({ instance })
      : new CptrProxyAdapter({ instance });
  },
};

/** A small JSON GET over a tunnel stream (health checks for connector instances). */
function getJsonOverStream(connect: () => Duplex, path: string): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      host: "cptr.connector",
      path,
      headers: { accept: "application/json", connection: "close" },
      createConnection: connect,
      timeout: 5_000,
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => {
        let body: unknown;
        try {
          body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        } catch {
          body = undefined;
        }
        resolve({ status: response.statusCode ?? 0, body });
      });
      response.on("error", reject);
    });
    request.on("timeout", () => request.destroy(new Error("Open WebUI Computer health check timed out")));
    request.on("error", reject);
    request.end();
  });
}
