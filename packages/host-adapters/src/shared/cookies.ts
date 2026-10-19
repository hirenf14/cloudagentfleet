/**
 * Lets a proxied backend keep its own browser session without ever seeing
 * the Hub's cookies. Only allowlisted upstream cookie names cross the proxy,
 * and they are renamed per instance in the browser, so two hosts of the same
 * backend on one Hub origin do not overwrite each other's sessions.
 */
export interface CookieBridge {
  /** Browser cookie names this bridge owns (cleared on Hub logout). */
  readonly browserNames: readonly string[];
  /** Builds the upstream `Cookie` header from the browser's header. */
  toUpstream(browserCookieHeader: string | undefined): string | undefined;
  /** Rewrites upstream `Set-Cookie` values; drops cookies outside the allowlist. */
  fromUpstream(setCookies: readonly string[]): string[];
}

export function namespacedCookieBridge(
  instanceId: string,
  upstreamNames: readonly string[],
): CookieBridge {
  const prefix = `cf_${cookieSafe(instanceId)}_`;
  const toBrowser = new Map(upstreamNames.map((name) => [name, `${prefix}${name}`]));
  const toUpstream = new Map([...toBrowser].map(([upstream, browser]) => [browser, upstream]));
  return {
    browserNames: [...toBrowser.values()],
    toUpstream(header) {
      const forwarded: string[] = [];
      for (const pair of header?.split(";") ?? []) {
        const separator = pair.indexOf("=");
        if (separator < 1) continue;
        const upstream = toUpstream.get(pair.slice(0, separator).trim());
        if (upstream) forwarded.push(`${upstream}=${pair.slice(separator + 1).trim()}`);
      }
      return forwarded.length > 0 ? forwarded.join("; ") : undefined;
    },
    fromUpstream(setCookies) {
      const rewritten: string[] = [];
      for (const cookie of setCookies) {
        const separator = cookie.indexOf("=");
        if (separator < 1) continue;
        const browser = toBrowser.get(cookie.slice(0, separator).trim());
        if (!browser) continue;
        // Host-only cookies stay on the Hub origin; never let upstream widen them.
        const attributes = cookie.slice(separator).replace(/;\s*domain=[^;]*/gi, "");
        rewritten.push(`${browser}${attributes}`);
      }
      return rewritten;
    },
  };
}

function cookieSafe(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 48);
}
