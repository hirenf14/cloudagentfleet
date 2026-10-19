export interface SseFrame {
  event?: string;
  data: string;
}

/** Reads an SSE body until it ends or the signal aborts. Never throws. */
export async function readSseStream(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
  onFrame: (frame: SseFrame) => void,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (!signal.aborted) {
      const result = await reader.read();
      if (result.done) return;
      buffer += decoder.decode(result.value, { stream: true });
      let boundary = sseBoundary(buffer);
      while (boundary) {
        const raw = buffer.slice(0, boundary.index);
        buffer = buffer.slice(boundary.index + boundary.length);
        boundary = sseBoundary(buffer);
        const lines = raw.split(/\r?\n/);
        const data = lines
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart())
          .join("\n");
        if (!data) continue;
        const event = lines
          .find((line) => line.startsWith("event:"))
          ?.slice("event:".length)
          .trim();
        onFrame(event ? { event, data } : { data });
      }
    }
  } catch {
    // Callers keep their HTTP control path when the event stream closes.
  } finally {
    reader.releaseLock();
  }
}

function sseBoundary(value: string): { index: number; length: number } | undefined {
  const lineFeed = value.indexOf("\n\n");
  const carriageReturn = value.indexOf("\r\n\r\n");
  if (lineFeed < 0 && carriageReturn < 0) return undefined;
  if (lineFeed < 0) return { index: carriageReturn, length: 4 };
  if (carriageReturn < 0 || lineFeed < carriageReturn) {
    return { index: lineFeed, length: 2 };
  }
  return { index: carriageReturn, length: 4 };
}
