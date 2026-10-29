import type { HostedNode } from "../../../packages/protocol/src/index.ts";
import { compareVersions, fetchLatestVersion } from "../../../packages/protocol/src/version.ts";

const HUB_PACKAGE = "@cloudagentfleet/hub";
const WORKER_PACKAGE = "@cloudagentfleet/worker";
const CHECK_INTERVAL_MS = 6 * 60 * 60_000;

export interface UpdateMonitorOptions {
  /** The running Hub's own version. */
  current: string;
  fetchImpl?: typeof fetch;
  intervalMs?: number;
  /** Off for `CLOUDAGENTFLEET_UPDATE_CHECK=0`: nothing is fetched and no banner shows. */
  enabled?: boolean;
}

export interface UpdateReport {
  enabled: boolean;
  checkedAt: string | null;
  hub: { current: string; latest: string | null; updateAvailable: boolean };
  worker: { latest: string | null };
  /** Workers that reported a version older than the newest release. */
  outdatedWorkers: { id: string; name: string; version: string }[];
}

/**
 * Learns the newest published Hub and Worker versions from npm, on start and
 * every few hours, so the dashboard can say an update exists. It only reads
 * the public registry; applying an update is the operator's (or the CLI
 * service's) choice.
 */
export class UpdateMonitor {
  private readonly options: UpdateMonitorOptions;
  private timer: ReturnType<typeof setInterval> | undefined;
  private checkedAt: string | null = null;
  private latestHub: string | null = null;
  private latestWorker: string | null = null;

  constructor(options: UpdateMonitorOptions) {
    this.options = options;
  }

  start(): void {
    if (this.options.enabled === false || this.timer) return;
    void this.check();
    this.timer = setInterval(() => void this.check(), this.options.intervalMs ?? CHECK_INTERVAL_MS);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Never throws; a failed lookup keeps the last answer. */
  async check(): Promise<void> {
    const [hub, worker] = await Promise.all([
      fetchLatestVersion(HUB_PACKAGE, this.options.fetchImpl),
      fetchLatestVersion(WORKER_PACKAGE, this.options.fetchImpl),
    ]);
    this.latestHub = hub ?? this.latestHub;
    this.latestWorker = worker ?? this.latestWorker;
    if (hub || worker) this.checkedAt = new Date().toISOString();
  }

  report(nodes: readonly HostedNode[]): UpdateReport {
    const latestWorker = this.latestWorker;
    return {
      enabled: this.options.enabled !== false,
      checkedAt: this.checkedAt,
      hub: {
        current: this.options.current,
        latest: this.latestHub,
        updateAvailable: this.latestHub !== null && compareVersions(this.options.current, this.latestHub) < 0,
      },
      worker: { latest: latestWorker },
      outdatedWorkers: latestWorker === null
        ? []
        : nodes
          .filter((node): node is HostedNode & { version: string } =>
            node.status !== "revoked" && node.version !== undefined && compareVersions(node.version, latestWorker) < 0)
          .map((node) => ({ id: node.id, name: node.name, version: node.version })),
    };
  }
}
