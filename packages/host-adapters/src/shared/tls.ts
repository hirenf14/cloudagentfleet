const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/**
 * Whether to verify the upstream TLS certificate. Always verify, except for
 * loopback development endpoints, which commonly use self-signed certificates.
 * Tailscale Serve hostnames (*.ts.net) carry publicly trusted certificates.
 */
export function verifyUpstreamTls(endpoint: URL): boolean {
  return !LOOPBACK_HOSTS.has(endpoint.hostname);
}
