import type { IncomingMessage, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
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
  /** Upstream connection override (a Worker tunnel stream) instead of dialing `endpoint`. */
  connect?: () => Duplex;
  /** Upstream `Cookie` header to send instead of the bridged browser cookies (Hub sign-in). */
  upstreamCookie?: string;
  /** Extra browser `Set-Cookie` values (the bridged cookie for a Hub-made sign-in). */
  setCookies?: readonly string[];
}

/**
 * The Hub decides who may frame a host UI (only its dashboard), so a policy
 * the Hub already set on the response replaces the upstream's own framing
 * rules: `X-Frame-Options` and the `frame-ancestors` directive.
 */
function applyHubFramePolicy(response: ServerResponse, headers: Record<string, string | string[]>): void {
  const hubPolicy = response.getHeader("content-security-policy");
  if (typeof hubPolicy !== "string") return;
  delete headers["x-frame-options"];
  const upstream = headers["content-security-policy"];
  if (upstream === undefined) return;
  const directives = (Array.isArray(upstream) ? upstream.join("; ") : upstream)
    .split(";")
    .map((directive) => directive.trim())
    .filter((directive) => directive && !/^frame-ancestors\b/i.test(directive));
  headers["content-security-policy"] = [...directives, hubPolicy].join("; ");
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
  const transport = endpoint.protocol === "https:" && !options.connect ? httpsRequest : httpRequest;
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
  const upstreamCookie = options.upstreamCookie ?? options.cookies?.toUpstream(request.headers.cookie);
  if (upstreamCookie) headers.cookie = upstreamCookie;
  const upstreamRequest = transport({
    hostname: endpoint.hostname,
    port: endpoint.port || undefined,
    path: `${requestUrl.pathname}${requestUrl.search}`,
    method: request.method ?? "GET",
    headers,
    rejectUnauthorized: verifyUpstreamTls(endpoint),
    ...(options.connect ? { createConnection: options.connect } : {}),
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
    // Every proxied response depends on the Hub session. Without this, the
    // browser can reuse a page cached while signed in after Hub logout:
    // key the cache on cookies, and revalidate responses that set no policy.
    const vary = String(responseHeaders.vary ?? "");
    if (!/(^|,)\s*(cookie|\*)\s*(,|$)/i.test(vary)) responseHeaders.vary = vary ? `${vary}, Cookie` : "Cookie";
    if (responseHeaders["cache-control"] === undefined) responseHeaders["cache-control"] = "private, no-cache";
    applyHubFramePolicy(response, responseHeaders);
    const setCookies = [
      ...(options.setCookies ?? []),
      ...(options.cookies?.fromUpstream(upstreamResponse.headers["set-cookie"] ?? []) ?? []),
    ];
    if (setCookies.length > 0) responseHeaders["set-cookie"] = setCookies;
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
