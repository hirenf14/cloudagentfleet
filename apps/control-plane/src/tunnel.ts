import { Duplex } from "node:stream";
import type { ControlMessage, TunnelMessage } from "../../../packages/protocol/src/index.ts";

/** Largest raw chunk per message; base64 keeps it well under the 1 MiB body limit. */
const MAX_CHUNK_BYTES = 256 * 1024;

interface OpenStream {
  nodeId: string;
  stream: Duplex;
}

/**
 * Hub end of the Worker byte-stream tunnel. Each stream is a Duplex the HTTP
 * proxy and WebSocket relay use as their upstream connection; bytes travel
 * Hub → Worker on the connector SSE stream and Worker → Hub as messages.
 */
export class TunnelBroker {
  private readonly streams = new Map<string, OpenStream>();

  open(
    nodeId: string,
    instanceId: string,
    send: (message: ControlMessage) => Promise<void>,
  ): Duplex {
    const streamId = crypto.randomUUID();
    const deliver = (message: ControlMessage) => {
      send(message).catch((error: unknown) => {
        stream.destroy(error instanceof Error ? error : new Error("Worker tunnel unavailable"));
      });
    };
    const stream = new Duplex({
      read() {},
      write(chunk: Buffer, _encoding, callback) {
        for (let offset = 0; offset < chunk.length; offset += MAX_CHUNK_BYTES) {
          deliver({
            type: "tunnel.data",
            streamId,
            data: chunk.subarray(offset, offset + MAX_CHUNK_BYTES).toString("base64"),
          });
        }
        callback();
      },
      final(callback) {
        deliver({ type: "tunnel.close", streamId });
        callback();
      },
      destroy: (error, callback) => {
        if (this.streams.delete(streamId)) deliver({ type: "tunnel.close", streamId });
        callback(error);
      },
    });
    // Node's HTTP client calls these on its socket; a tunnel has nothing to tune.
    Object.assign(stream, {
      setNoDelay: () => stream,
      setKeepAlive: () => stream,
      setTimeout: () => stream,
      ref: () => stream,
      unref: () => stream,
    });
    this.streams.set(streamId, { nodeId, stream });
    deliver({ type: "tunnel.open", streamId, instanceId });
    return stream;
  }

  /** Applies a Worker message; ignores streams the node does not own. */
  receive(nodeId: string, message: TunnelMessage): void {
    const open = this.streams.get(message.streamId);
    if (!open || open.nodeId !== nodeId) return;
    if (message.type === "tunnel.data") {
      open.stream.push(Buffer.from(message.data, "base64"));
    } else if (message.type === "tunnel.close") {
      this.streams.delete(message.streamId);
      if (message.error) open.stream.destroy(new Error(message.error));
      else open.stream.push(null);
    }
  }

  /** The Worker's connection went away: its streams cannot recover. */
  closeNode(nodeId: string, reason: string): void {
    for (const [streamId, open] of this.streams) {
      if (open.nodeId !== nodeId) continue;
      this.streams.delete(streamId);
      open.stream.destroy(new Error(reason));
    }
  }
}
