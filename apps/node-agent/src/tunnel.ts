import { createConnection, type Socket } from "node:net";
import type { NodeMessage, TunnelMessage } from "../../../packages/protocol/src/index.ts";

/** Largest raw chunk per message; base64 keeps it well under the Hub's 1 MiB body limit. */
const MAX_CHUNK_BYTES = 256 * 1024;

export interface TunnelTarget {
  host: string;
  port: number;
}

export interface WorkerTunnelsOptions {
  /** Connector instance id → the local service its tunnel may reach. Fixed by Worker config. */
  targets: Map<string, TunnelTarget>;
  send: (message: NodeMessage) => Promise<void>;
  connect?: (target: TunnelTarget) => Socket;
}

/**
 * Worker end of the byte-stream tunnel (the cptr connector driver). The Hub
 * may only name a connector instance; where the stream connects comes from
 * this Worker's own configuration, never from the Hub.
 */
export class WorkerTunnels {
  private readonly targets: Map<string, TunnelTarget>;
  private readonly send: WorkerTunnelsOptions["send"];
  private readonly connect: NonNullable<WorkerTunnelsOptions["connect"]>;
  private readonly streams = new Map<string, { socket: Socket; outbound: OrderedSender }>();

  constructor(options: WorkerTunnelsOptions) {
    this.targets = options.targets;
    this.send = options.send;
    this.connect = options.connect ?? ((target) => createConnection({ host: target.host, port: target.port }));
  }

  handle(message: TunnelMessage): void {
    if (message.type === "tunnel.open") {
      this.open(message.streamId, message.instanceId);
      return;
    }
    const stream = this.streams.get(message.streamId);
    if (!stream) return;
    if (message.type === "tunnel.data") {
      stream.socket.write(Buffer.from(message.data, "base64"));
    } else if (message.type === "tunnel.close") {
      this.streams.delete(message.streamId);
      stream.socket.end();
    }
  }

  closeAll(): void {
    for (const { socket } of this.streams.values()) socket.destroy();
    this.streams.clear();
  }

  private open(streamId: string, instanceId: string): void {
    const outbound = new OrderedSender(streamId, this.send);
    const target = this.targets.get(instanceId);
    if (!target) {
      outbound.close(`No tunnel target for connector instance ${instanceId}`);
      return;
    }
    const socket = this.connect(target);
    this.streams.set(streamId, { socket, outbound });
    socket.once("connect", () => outbound.opened());
    socket.on("data", (chunk: Buffer) => outbound.data(chunk));
    socket.once("error", (error) => {
      this.streams.delete(streamId);
      outbound.close(error.message);
    });
    socket.once("close", () => {
      if (this.streams.delete(streamId)) outbound.close();
    });
  }
}

/**
 * Sends one stream's messages strictly in order, one request at a time,
 * coalescing data that arrives while a send is in flight.
 */
class OrderedSender {
  private pending: Buffer[] = [];
  private queue: NodeMessage[] = [];
  private sending = false;
  private closed = false;
  private readonly streamId: string;
  private readonly send: (message: NodeMessage) => Promise<void>;

  constructor(streamId: string, send: (message: NodeMessage) => Promise<void>) {
    this.streamId = streamId;
    this.send = send;
  }

  opened(): void {
    this.enqueue({ type: "tunnel.opened", streamId: this.streamId });
  }

  data(chunk: Buffer): void {
    if (this.closed) return;
    this.pending.push(chunk);
    void this.pump();
  }

  close(error?: string): void {
    if (this.closed) return;
    this.closed = true;
    this.flushPending();
    this.queue.push({ type: "tunnel.close", streamId: this.streamId, ...(error ? { error } : {}) });
    void this.pump();
  }

  private enqueue(message: NodeMessage): void {
    this.flushPending();
    this.queue.push(message);
    void this.pump();
  }

  private flushPending(): void {
    if (this.pending.length === 0) return;
    const bytes = Buffer.concat(this.pending);
    this.pending = [];
    for (let offset = 0; offset < bytes.length; offset += MAX_CHUNK_BYTES) {
      this.queue.push({
        type: "tunnel.data",
        streamId: this.streamId,
        data: bytes.subarray(offset, offset + MAX_CHUNK_BYTES).toString("base64"),
      });
    }
  }

  private async pump(): Promise<void> {
    if (this.sending) return;
    this.sending = true;
    try {
      while (true) {
        this.flushPending();
        const message = this.queue.shift();
        if (!message) break;
        await this.send(message).catch(() => undefined);
      }
    } finally {
      this.sending = false;
    }
  }
}
