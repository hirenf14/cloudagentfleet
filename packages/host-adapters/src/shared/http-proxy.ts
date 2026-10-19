import type { IncomingMessage, ServerResponse } from "node:http";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import type { CookieBridge } from "./cookies.ts";
import { verifyUpstreamTls } from "./tls.ts";

/** Hub-owned path prefix; nothing under it is ever proxied to a backend. */
export const FLEET_PATH_PREFIX = "/_fleet";

/** Injected into proxied HTML pages (when enabled) so operators can switch hosts. */
export const FLEET_SWITCHER_SCRIPT = `<script src="${FLEET_PATH_PREFIX}/fleet-host-switcher.js"></script>`;

export interface ProxyHttpOptions {
  endpoint: URL;
  /** Server-side upstream credential; client credentials are never forwarded. */
  authorization?: string;
  /** Upstream product name used in the 502 body. */
  label: string;
  /** Inject the fleet switcher into HTML. Off for backends whose UI must not be altered. */
  injectSwitcher?: boolean;
  /** Forward the browser's Referer (same Hub origin); some backends route on it. */
  forwardReferer?: boolean;
  /** Allowlisted backend session cookies; without it no cookies cross the proxy. */
  cookies?: CookieBridge;
}

/**
 * Proxies one browser request to a backend's native UI on the Hub origin.
 *
 * Guarantees for every backend: the Hub's cookies, the browser's
 * authorization, and Origin never reach the upstream; upstream cookies reach
 * the browser only through an explicit CookieBridge; absolute redirects are
 * rewritten to Hub-relative paths.
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
      || (name === "referer" && !options.forwardReferer)
      || name.startsWith("x-forwarded-")
    ) continue;
    if (typeof value === "string") headers[name] = value;
    else if (Array.isArray(value)) headers[name] = value.join(", ");
  }
  headers["accept-encoding"] = "identity";
  if (options.authorization) headers.authorization = options.authorization;
  const upstreamCookie = options.cookies?.toUpstream(request.headers.cookie);
  if (upstreamCookie) headers.cookie = upstreamCookie;
  const upstreamRequest = transport({
    hostname: endpoint.hostname,
    port: endpoint.port || undefined,
    path: `${requestUrl.pathname}${requestUrl.search}`,
    method: request.method ?? "GET",
    headers,
    rejectUnauthorized: verifyUpstreamTls(endpoint),
  }, (upstreamResponse) => {
    const inject = options.injectSwitcher === true
      && String(upstreamResponse.headers["content-type"] ?? "").includes("text/html");
    const responseHeaders: Record<string, string | string[]> = {};
    for (const [name, value] of Object.entries(upstreamResponse.headers)) {
      if (
        value === undefined
        || name === "set-cookie"
        || name === "connection"
        || (inject && (name === "content-length" || name === "content-encoding"))
      ) continue;
      responseHeaders[name] = value;
    }
    const setCookies = options.cookies?.fromUpstream(upstreamResponse.headers["set-cookie"] ?? []);
    if (setCookies && setCookies.length > 0) responseHeaders["set-cookie"] = setCookies;
    const location = responseHeaders.location;
    if (typeof location === "string") {
      try {
        const redirected = new URL(location, endpoint);
        if (redirected.origin === endpoint.origin) {
          responseHeaders.location = `${redirected.pathname}${redirected.search}${redirected.hash}`;
        }
      } catch {
        // Preserve a relative location when the upstream sends malformed data.
      }
    }
    if (inject) {
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
