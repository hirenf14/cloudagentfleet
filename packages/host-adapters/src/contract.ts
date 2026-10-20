import type { IncomingMessage, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import type {
  AgentProfile,
  BackendFeature,
  CodemanConnectorOperation,
  ConnectionMode,
  HostBackend,
  HostInstance,
  HostSession,
  HostSessionEvent,
  WorkspaceDescriptor,
  WorkspacePathSuggestion,
} from "../../../packages/protocol/src/index.ts";

/**
 * The contract between the Hub and one per-machine backend instance.
 *
 * Core methods are always present. Each optional facet backs exactly one
 * advertised feature: an adapter exposes a facet if and only if `features`
 * lists it (checked by the contract tests). The Hub checks the feature, then
 * calls the facet.
 */
export interface HostAdapter {
  readonly instance: HostInstance;
  readonly features: readonly BackendFeature[];
  /** Launchable agent profiles; also the health probe. */
  listAgents(): Promise<AgentProfile[]>;
  listWorkspaces(): Promise<WorkspaceDescriptor[]>;
  subscribeEvents?(listener: (event: HostSessionEvent) => void): () => void;
  /** Feature `sessions`. */
  readonly sessionControl?: SessionControl;
  /** Feature `terminal`. */
  readonly terminalProxy?: TerminalProxy;
  /** Feature `native-ui-proxy`. */
  readonly nativeUi?: NativeUiProxy;
  /** Feature `workspace-suggest`. */
  readonly pathSuggestions?: PathSuggestions;
}

export interface SessionControl {
  listSessions(): Promise<HostSession[]>;
  createSession(
    workspace: WorkspaceDescriptor,
    agent: AgentProfile,
    title?: string,
  ): Promise<HostSession>;
  sendInput(sessionId: string, input: string, raw?: boolean): Promise<void>;
  resize(sessionId: string, cols: number, rows: number): Promise<void>;
  stopSession(sessionId: string): Promise<void>;
}

export interface TerminalProxy {
  proxyTerminal(
    sessionId: string,
    request: IncomingMessage,
    clientSocket: Duplex,
    head: Buffer,
  ): Promise<void>;
}

export interface NativeUiProxy {
  proxyHttp(request: IncomingMessage, response: ServerResponse): Promise<void>;
  /** Any WebSocket the native UI opens on the Hub origin. */
  proxyUpgrade(request: IncomingMessage, clientSocket: Duplex, head: Buffer): Promise<void>;
  /** Backend session cookies held in the browser; the Hub clears them on logout. */
  readonly browserCookieNames: readonly string[];
  /** Best-effort setup before the native UI is opened through the Hub. */
  prepareNativeUi?(): Promise<void>;
}

export interface PathSuggestions {
  listWorkspacePathSuggestions(prefix: string): Promise<WorkspacePathSuggestion[]>;
}

/** Hub-side Worker channel for instances in connector mode. */
export interface ConnectorChannel {
  request(operation: CodemanConnectorOperation, payload?: Record<string, unknown>): Promise<unknown>;
  subscribeEvents(listener: (event: HostSessionEvent) => void): () => void;
  /** Byte stream to the service the Worker exposes for this instance (stream drivers such as cptr). */
  openStream?(): Duplex;
}

export interface AdapterDependencies {
  credentials?: { username: string; password: string };
  connector?: ConnectorChannel;
}

export interface BackendDefinition {
  readonly backend: HostBackend;
  /** Human-readable product name for the CLI and dashboard. */
  readonly label: string;
  readonly connectionModes: readonly ConnectionMode[];
  /** Every feature an adapter of this backend may advertise, per connection mode. */
  features(connectionMode: ConnectionMode): readonly BackendFeature[];
  /** Launch profiles assumed for a registration that lists none. */
  defaultAgents(): AgentProfile[];
  createAdapter(instance: HostInstance, dependencies: AdapterDependencies): HostAdapter;
}
