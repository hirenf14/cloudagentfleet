import type { IncomingMessage, ServerResponse } from "node:http";
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
 * Open WebUI Computer (`cptr`). By default the Hub proxies its whole UI at
 * the Hub origin root; instances enrolled with the `link` capability are only
 * health-checked and opened directly. cptr's internal API is undocumented and
 * cookie-authenticated, so no sessions or terminal facets are offered
 * (docs/BACKEND-ABSTRACTION.md, Spike S).
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

export interface CptrAdapterOptions {
  instance: HostInstance;
  fetchImpl?: typeof fetch;
}

abstract class CptrAdapter implements HostAdapter {
  readonly instance: HostInstance;
  abstract readonly features: readonly BackendFeature[];
  protected readonly fetchImpl: typeof fetch;

  constructor(options: CptrAdapterOptions) {
    this.instance = validateHostInstance(options.instance);
    if (!this.instance.endpoint) throw new Error("Open WebUI Computer requires an endpoint");
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  /** Probes cptr's unauthenticated `/api/health`; agents are configured inside cptr. */
  async listAgents(): Promise<AgentProfile[]> {
    const url = `${this.instance.endpoint!.replace(/\/+$/, "")}/api/health`;
    const response = await this.fetchImpl(url, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) throw new Error(`Open WebUI Computer health check failed with HTTP ${response.status}`);
    const body = await response.json().catch(() => undefined) as { status?: unknown } | undefined;
    if (body?.status !== "ok") throw new Error("Open WebUI Computer health check returned an unexpected body");
    return this.instance.agents.map((agent) => ({ ...agent }));
  }

  async listWorkspaces(): Promise<WorkspaceDescriptor[]> {
    return this.instance.workspaces;
  }
}

export class CptrLinkAdapter extends CptrAdapter {
  readonly features = CPTR_LINK_FEATURES;
}

/**
 * Proxies cptr at the Hub origin root. The browser signs in with cptr's own
 * login once; its `cptr_session` cookie is stored under a per-instance name
 * and is the only cookie that crosses the proxy.
 */
export class CptrProxyAdapter extends CptrAdapter implements NativeUiProxy {
  readonly features = CPTR_PROXY_FEATURES;
  private readonly cookies: CookieBridge;

  constructor(options: CptrAdapterOptions) {
    super(options);
    this.cookies = namespacedCookieBridge(this.instance.id, [CPTR_SESSION_COOKIE]);
  }

  get nativeUi(): NativeUiProxy {
    return this;
  }

  get browserCookieNames(): readonly string[] {
    return this.cookies.browserNames;
  }

  async proxyHttp(request: IncomingMessage, response: ServerResponse): Promise<void> {
    await proxyHttpRequest(request, response, {
      endpoint: new URL(this.instance.endpoint!),
      label: "Open WebUI Computer",
      // cptr's in-app browser routes preview resources by Referer.
      forwardReferer: true,
      cookies: this.cookies,
    });
  }

  async proxyUpgrade(request: IncomingMessage, clientSocket: Duplex, head: Buffer): Promise<void> {
    const requestUrl = new URL(request.url ?? "/", "http://controller.local");
    await proxyWebSocket(request, clientSocket, head, {
      endpoint: new URL(this.instance.endpoint!),
      path: `${requestUrl.pathname}${requestUrl.search}`,
      label: "Open WebUI Computer",
      cookies: this.cookies,
    });
  }
}

export const cptrBackend: BackendDefinition = {
  backend: "cptr",
  label: "Open WebUI Computer",
  connectionModes: ["tailscale-url"],
  features: () => [...CPTR_PROXY_FEATURES, ...CPTR_LINK_FEATURES],
  defaultAgents: () => [],
  createAdapter: (instance) => instance.capabilities.includes(CPTR_LINK_CAPABILITY)
    ? new CptrLinkAdapter({ instance })
    : new CptrProxyAdapter({ instance }),
};
