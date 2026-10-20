import assert from "node:assert/strict";
import test from "node:test";
import { namespacedCookieBridge } from "./cookies.ts";

test("cookie bridge forwards only allowlisted backend cookies, renamed per instance", () => {
  const bridge = namespacedCookieBridge("laptop.cptr", ["cptr_session"]);
  assert.deepEqual(bridge.browserNames, ["cf_laptop_cptr_cptr_session"]);
  assert.equal(
    bridge.toUpstream("cloudagentfleet_session=hub; cf_laptop_cptr_cptr_session=jwt; cloudagentfleet_csrf=x"),
    "cptr_session=jwt",
  );
  assert.equal(bridge.toUpstream("cloudagentfleet_session=hub"), undefined);
  assert.equal(bridge.toUpstream(undefined), undefined);
});

test("cookie bridge rewrites upstream Set-Cookie and keeps it host-only", () => {
  const bridge = namespacedCookieBridge("a", ["cptr_session"]);
  assert.deepEqual(
    bridge.fromUpstream([
      "cptr_session=jwt; HttpOnly; Path=/; SameSite=lax; Domain=evil.example; Max-Age=60",
      "tracking=1; Path=/",
    ]),
    ["cf_a_cptr_session=jwt; HttpOnly; Path=/; SameSite=lax; Max-Age=60"],
  );
});

test("two instances of one backend never share a browser session cookie", () => {
  const first = namespacedCookieBridge("host-a", ["cptr_session"]);
  const second = namespacedCookieBridge("host-b", ["cptr_session"]);
  const browser = "cf_host-a_cptr_session=a-token; cf_host-b_cptr_session=b-token";
  assert.equal(first.toUpstream(browser), "cptr_session=a-token");
  assert.equal(second.toUpstream(browser), "cptr_session=b-token");
});
