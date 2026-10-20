import type { IncomingMessage, ServerResponse } from "node:http";

/** Selected host for the host-UI origin. Host-only, so it never widens beyond the Hub's name. */
export const INSTANCE_COOKIE = "cloudagentfleet_instance";

/** Tailscale Serve HTTPS port for the host-UI origin (the Hub itself is served on 443). */
export const HOST_UI_SERVE_PORT = 8443;

export function selectedInstance(request: IncomingMessage): string | undefined {
  for (const item of request.headers.cookie?.split(";") ?? []) {
    const separator = item.indexOf("=");
    if (separator < 1 || item.slice(0, separator).trim() !== INSTANCE_COOKIE) continue;
    const value = item.slice(separator + 1).trim();
    try {
      return decodeURIComponent(value) || undefined;
    } catch {
      return value || undefined;
    }
  }
  return undefined;
}

export function isSecureRequest(request: IncomingMessage): boolean {
  return request.headers["x-forwarded-proto"] === "https"
    || ("encrypted" in request.socket && request.socket.encrypted === true);
}

/** Sets (or, without an id, clears) the selected-host cookie. */
export function instanceCookie(request: IncomingMessage, instanceId?: string): string {
  const secure = isSecureRequest(request) ? "; Secure" : "";
  return instanceId
    ? `${INSTANCE_COOKIE}=${encodeURIComponent(instanceId)}; Path=/; Max-Age=86400; HttpOnly; SameSite=Lax${secure}`
    : `${INSTANCE_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax${secure}`;
}

export function sendJson(response: ServerResponse, status: number, body: unknown): void {
  if (status === 204) {
    response.writeHead(status);
    response.end();
    return;
  }
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(body));
}

/** A minimal self-contained page; `message` is escaped. */
export function sendNotice(
  response: ServerResponse,
  status: number,
  message: string,
  link: { href: string; label: string },
  headers: Record<string, string | string[]> = {},
): void {
  response.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    ...headers,
  });
  response.end(`<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Cloud Agent Fleet</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#000;color:#d4d4d4;font:12px/16px Inter,-apple-system,BlinkMacSystemFont,ui-sans-serif,system-ui,"Segoe UI",sans-serif}
main{max-width:360px;padding:0 24px}p{margin:0 0 10px}a{color:#8a8a8a}a:hover{color:#f5f5f5}</style></head>
<body><main><p>${escapeHtml(message)}</p><p><a href="${escapeHtml(link.href)}">${escapeHtml(link.label)}</a></p></main></body></html>`);
}

export interface OriginPlan {
  hubPort: number;
  hostPort: number;
  /** Explicit public dashboard origin (CLOUDAGENTFLEET_PUBLIC_URL). */
  hubUrl?: string;
  /** Explicit public host-UI origin (CLOUDAGENTFLEET_HOST_UI_URL). */
  hostUrl?: string;
}

/**
 * The public origin of the dashboard or the host-UI listener, as seen from
 * this request. Direct local access maps port to port (8787 ↔ 8788); access
 * through Tailscale Serve maps 443 ↔ 8443. Explicit URLs always win.
 */
export function originFor(request: IncomingMessage, target: "hub" | "host", plan: OriginPlan): string {
  const explicit = target === "hub" ? plan.hubUrl : plan.hostUrl;
  if (explicit) return explicit.replace(/\/+$/, "");
  const forwardedHost = request.headers["x-forwarded-host"];
  const hostHeader = (typeof forwardedHost === "string" ? forwardedHost.split(",")[0]!.trim() : request.headers.host)
    || "127.0.0.1";
  const scheme = isSecureRequest(request) ? "https" : "http";
  const seen = new URL(`${scheme}://${hostHeader}`);
  const port = seen.port ? Number(seen.port) : undefined;
  const direct = port === plan.hubPort || port === plan.hostPort;
  const targetPort = direct
    ? (target === "hub" ? plan.hubPort : plan.hostPort)
    : (target === "hub" ? undefined : HOST_UI_SERVE_PORT);
  return `${scheme}://${seen.hostname}${targetPort ? `:${targetPort}` : ""}`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
