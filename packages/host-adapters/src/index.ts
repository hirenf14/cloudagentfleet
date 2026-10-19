export type {
  AdapterDependencies,
  BackendDefinition,
  ConnectorChannel,
  HostAdapter,
  NativeUiProxy,
  PathSuggestions,
  SessionControl,
  TerminalProxy,
} from "./contract.ts";
export {
  backendDefinition,
  createAdapter,
  describeBackends,
  listBackends,
  type BackendSummary,
} from "./registry.ts";
export { CodemanConnectorAdapter, CodemanHttpAdapter } from "./codeman/index.ts";
export { rejectSocket } from "./shared/ws-relay.ts";
