import type {
  AgentProfile,
  BackendFeature,
  HostInstance,
  WorkspaceDescriptor,
} from "../../../../packages/protocol/src/index.ts";
import { validateHostInstance } from "../../../../packages/protocol/src/index.ts";
import type { BackendDefinition, HostAdapter } from "../contract.ts";

/**
 * Open WebUI Computer (`cptr`) in link mode: the Hub health-checks the
 * instance and the dashboard opens its own UI directly. cptr's internal API
 * is undocumented and cookie-authenticated, so no sessions, terminal, or
 * proxy facets are offered (see docs/BACKEND-ABSTRACTION.md, Spike S).
 *
 * cptr's license forbids altering its branding, and nothing here touches its
 * UI. It is linked to, never bundled.
 */
export const CPTR_LINK_FEATURES: readonly BackendFeature[] = ["native-ui-link"];

export interface CptrLinkAdapterOptions {
  instance: HostInstance;
  fetchImpl?: typeof fetch;
}

export class CptrLinkAdapter implements HostAdapter {
  readonly instance: HostInstance;
  readonly features = CPTR_LINK_FEATURES;
  private readonly fetchImpl: typeof fetch;

  constructor(options: CptrLinkAdapterOptions) {
    this.instance = validateHostInstance(options.instance);
    if (!this.instance.endpoint) throw new Error("cptr link adapter requires an endpoint");
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

export const cptrBackend: BackendDefinition = {
  backend: "cptr",
  label: "Open WebUI Computer",
  connectionModes: ["tailscale-url"],
  features: () => CPTR_LINK_FEATURES,
  defaultAgents: () => [],
  createAdapter: (instance) => new CptrLinkAdapter({ instance }),
};
