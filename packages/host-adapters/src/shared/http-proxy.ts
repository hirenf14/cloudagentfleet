import type { IncomingMessage, ServerResponse } from "node:http";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";

/** Injected into every proxied HTML page so operators can switch hosts. */
export const FLEET_SWITCHER_SCRIPT = '<script src="/fleet-host-switcher.js"></script>';

export interface ProxyHttpOptions {
  endpoint: URL;
  /** Server-side upstream credential; client credentials are never forwarded. */
  authorization?: string;
  /** Upstream product name used in the 502 body. */
  label: string;
}

/**
 * Proxies one browser request to a backend's native UI on the Hub origin.
 *
 * Guarantees for every backend: the browser's Hub cookies, authorization,
 * origin, and referer never reach the upstream; upstream cookies never reach
 * the browser; absolute redirects are rewritten to Hub-relative paths; and
 * HTML pages get the fleet switcher.
 */
export async function proxyHttpRequest(
  request: IncomingMessage,
  response: ServerResponse,
  options: ProxyHttpOptions,
): Promise<void> {
  const { endpoint } = options;
  const requestUrl = new URL(request.url ?? "/", "http://controller.local");
  const transport = endpoint.protocol === "https:" ? httpsRequest : httpRequest;
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(request.headers)) {
    if (
      name === "host"
      || name === "authorization"
      || name === "cookie"
      || name === "connection"
      || name === "upgrade"
      || name === "origin"
      || name === "referer"
      || name.startsWith("x-forwarded-")
    ) continue;
    if (typeof value === "string") headers[name] = value;
    else if (Array.isArray(value)) headers[name] = value.join(", ");
  }
  headers["accept-encoding"] = "identity";
  if (options.authorization) headers.authorization = options.authorization;
  const upstreamRequest = transport({
    hostname: endpoint.hostname,
    port: endpoint.port || undefined,
    path: `${requestUrl.pathname}${requestUrl.search}`,
    method: request.method ?? "GET",
    headers,
    rejectUnauthorized: endpoint.protocol !== "https:" || endpoint.hostname === "localhost",
  }, (upstreamResponse) => {
    const isHtml = String(upstreamResponse.headers["content-type"] ?? "").includes("text/html");
    const responseHeaders: Record<string, string | string[]> = {};
    for (const [name, value] of Object.entries(upstreamResponse.headers)) {
      if (
        value === undefined
        || name === "set-cookie"
        || name === "connection"
        || (isHtml && (name === "content-length" || name === "content-encoding"))
      ) continue;
      responseHeaders[name] = value;
    }
    const location = responseHeaders.location;
    if (typeof location === "string") {
      try {
        const redirected = new URL(location, endpoint);
        responseHeaders.location = `${redirected.pathname}${redirected.search}${redirected.hash}`;
      } catch {
        // Preserve a relative location when the upstream sends malformed data.
      }
    }
    if (isHtml) {
      const chunks: Buffer[] = [];
      upstreamResponse.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
      upstreamResponse.on("end", () => {
        const html = Buffer.concat(chunks).toString("utf8");
        const injected = html.includes("</body>")
          ? html.replace("</body>", `${FLEET_SWITCHER_SCRIPT}</body>`)
          : `${html}${FLEET_SWITCHER_SCRIPT}`;
        responseHeaders["content-type"] = "text/html; charset=utf-8";
        response.writeHead(upstreamResponse.statusCode ?? 502, responseHeaders);
        response.end(injected);
      });
      return;
    }
    response.writeHead(upstreamResponse.statusCode ?? 502, responseHeaders);
    upstreamResponse.pipe(response);
  });
  upstreamRequest.once("error", () => {
    if (!response.headersSent) {
      response.writeHead(502, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({ error: `${options.label} request unavailable` }));
    } else {
      response.destroy();
    }
  });
  request.pipe(upstreamRequest);
}
