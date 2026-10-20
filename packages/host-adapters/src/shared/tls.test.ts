import assert from "node:assert/strict";
import test from "node:test";
import { verifyUpstreamTls } from "./tls.ts";

test("upstream TLS is verified for every non-loopback host", () => {
  assert.equal(verifyUpstreamTls(new URL("https://box.tailnet.ts.net")), true);
  assert.equal(verifyUpstreamTls(new URL("https://100.101.102.103")), true);
  assert.equal(verifyUpstreamTls(new URL("https://localhost:8443")), false);
  assert.equal(verifyUpstreamTls(new URL("https://127.0.0.1:8443")), false);
  assert.equal(verifyUpstreamTls(new URL("https://[::1]:8443")), false);
});
