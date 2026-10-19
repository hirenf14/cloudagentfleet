import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { rejectSocket } from "../../../packages/host-adapters/src/index.ts";
import type { UiAuth } from "./auth.ts";
import { HttpError } from "./errors.ts";
import type { FleetHub } from "./hub.ts";
import {
  instanceCookie,
  originFor,
  selectedInstance,
  sendJson,
  sendNotice,
  type OriginPlan,
} from "./http-helpers.ts";

export interface HostUiServerOptions {
  hub: FleetHub;
  uiAuth: UiAuth;
  origins: OriginPlan;
  serveAsset: (pathname: string, response: ServerResponse) => Promise<void>;
}

/**
 * The host-UI origin: a second listener that serves only proxied backend UIs.
 *
 * Backend pages (and anything they embed, such as cptr's in-app browser
 * previews) run here, not on the dashboard origin. The browser's same-origin
 * policy keeps them from reading Hub API responses, and the Hub's Origin
 * check rejects any mutation they attempt against the dashboard origin. This
 * listener exposes no Hub API beyond a read-only host list for the switcher.
 */
export function createHostUiServer(options: HostUiServerOptions): Server {
  const { hub, uiAuth, origins } = options;
  const dashboard = (request: IncomingMessage) => `${originFor(request, "hub", origins)}/_fleet/`;

  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://host-ui.local");
      const auth = uiAuth.authenticate(request, undefined);
      if (!auth.authenticated) {
        sendNotice(response, 401, "Sign in on the fleet dashboard first.", {
          href: dashboard(request),
          label: "Open the fleet dashboard",
        });
        return;
      }
      if (request.method !== "GET" && request.method !== "HEAD" && !uiAuth.isCsrfValid(request, auth)) {
        sendJson(response, 403, { error: "Cross-site request blocked" });
        return;
      }

      const selectMatch = url.pathname.match(/^\/_fleet\/select\/([^/]+)$/);
      if (request.method === "GET" && selectMatch) {
        const instanceId = decodeURIComponent(selectMatch[1]!);
        if (!hub.supportsFeature(instanceId, "native-ui-proxy")) {
          sendNotice(response, 400, "This host's UI is not available through the Hub.", {
            href: dashboard(request),
            label: "Back to the fleet dashboard",
          });
          return;
        }
        try {
          await hub.prepareNativeUi(instanceId);
        } catch {
          // Selection still proceeds; the native UI can recover on its own.
        }
        response.writeHead(303, { "set-cookie": instanceCookie(request, instanceId), location: "/" });
        response.end();
        return;
      }
      if (request.method === "GET" && url.pathname === "/_fleet/clear") {
        response.writeHead(303, { "set-cookie": instanceCookie(request), location: dashboard(request) });
        response.end();
        return;
      }
      if (request.method === "GET" && url.pathname === "/_fleet/fleet-host-switcher.js") {
        await options.serveAsset("/fleet-host-switcher.js", response);
        return;
      }
      if (request.method === "GET" && url.pathname === "/_fleet/api/switcher") {
        sendJson(response, 200, {
          dashboardUrl: dashboard(request),
          current: selectedInstance(request) ?? null,
          hosts: hub.listInstances()
            .filter((instance) => hub.supportsFeature(instance.id, "native-ui-proxy"))
            .map((instance) => ({ id: instance.id, label: instance.label, status: instance.status })),
        });
        return;
      }
      if (url.pathname === "/_fleet" || url.pathname.startsWith("/_fleet/")) {
        sendJson(response, 404, { error: "Not found" });
        return;
      }

      const instanceId = selectedInstance(request);
      if (!instanceId) {
        sendNotice(response, 404, "No host is selected. Open a host's UI from the fleet dashboard.", {
          href: dashboard(request),
          label: "Open the fleet dashboard",
        });
        return;
      }
      try {
        await hub.proxyNativeUi(instanceId, request, response);
      } catch (error) {
        if (response.headersSent) {
          response.destroy();
          return;
        }
        // A removed, re-enrolled, or disconnected host: drop the stale selection.
        sendNotice(
          response,
          error instanceof HttpError ? error.status : 502,
          error instanceof Error ? error.message : "Host unavailable",
          { href: dashboard(request), label: "Back to the fleet dashboard" },
          { "set-cookie": instanceCookie(request) },
        );
      }
    } catch (error) {
      if (!response.headersSent) {
        sendJson(response, error instanceof HttpError ? error.status : 400, {
          error: error instanceof Error ? error.message : "Request failed",
        });
      }
    }
  });

  server.on("upgrade", (request, socket: Duplex, head: Buffer) => {
    void (async () => {
      const auth = uiAuth.authenticate(request, undefined);
      const instanceId = selectedInstance(request);
      if (
        !auth.authenticated
        || !uiAuth.isOriginValid(request)
        || typeof request.headers.upgrade !== "string"
        || request.headers.upgrade.toLowerCase() !== "websocket"
      ) {
        rejectSocket(socket, 401, "Unauthorized");
        return;
      }
      if (!instanceId) {
        rejectSocket(socket, 400, "A host must be selected");
        return;
      }
      try {
        await hub.proxyNativeUpgrade(instanceId, request, socket, head);
      } catch (error) {
        rejectSocket(socket, 502, error instanceof Error ? error.message : "WebSocket proxy unavailable");
      }
    })();
  });
  return server;
}
