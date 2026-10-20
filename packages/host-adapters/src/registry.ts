import type {
  BackendFeature,
  ConnectionMode,
  HostBackend,
  HostInstance,
} from "../../../packages/protocol/src/index.ts";
import type { AdapterDependencies, BackendDefinition, HostAdapter } from "./contract.ts";
import { codemanBackend } from "./codeman/index.ts";
import { cptrBackend } from "./cptr/index.ts";

/** Every supported backend. Adding one is a new module plus an entry here. */
const BACKENDS: Record<HostBackend, BackendDefinition> = {
  codeman: codemanBackend,
  cptr: cptrBackend,
};

export function backendDefinition(backend: HostBackend): BackendDefinition {
  const definition = BACKENDS[backend];
  if (!definition) throw new Error(`Unsupported backend: ${backend}`);
  return definition;
}

export function listBackends(): BackendDefinition[] {
  return Object.values(BACKENDS);
}

export function createAdapter(
  instance: HostInstance,
  dependencies: AdapterDependencies = {},
): HostAdapter {
  const definition = backendDefinition(instance.backend);
  if (!definition.connectionModes.includes(instance.connectionMode)) {
    throw new Error(
      `${definition.label} does not support connection mode ${instance.connectionMode}`,
    );
  }
  return definition.createAdapter(instance, dependencies);
}

/** Serializable backend summary for the dashboard and CLI. */
export interface BackendSummary {
  backend: HostBackend;
  label: string;
  connectionModes: ConnectionMode[];
  features: Partial<Record<ConnectionMode, BackendFeature[]>>;
}

export function describeBackends(): BackendSummary[] {
  return listBackends().map((definition) => ({
    backend: definition.backend,
    label: definition.label,
    connectionModes: [...definition.connectionModes],
    features: Object.fromEntries(
      definition.connectionModes.map((mode) => [mode, [...definition.features(mode)]]),
    ),
  }));
}
