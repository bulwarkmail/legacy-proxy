// Private and special address space may be given whole in TRUST_PROXY; only
// public space is bounded (/8 for IPv4, /32 for IPv6). A reverse proxy's
// network may be anywhere in the unique local range (fc00::/7, fd00::/8 in
// practice), and link-local addresses (fe80::/10) can't be told apart by
// prefix. Public and IPv4-mapped ranges stay refused.

import { describe, expect, it } from "vitest";
import { parseTrustProxy } from "../../src/util/config.js";

describe("TRUST_PROXY and private address space", () => {
  it.each([
    "10.0.0.0/8",
    "172.16.0.0/12",
    "192.168.0.0/16",
    "100.64.0.0/10",
    "127.0.0.0/8",
    "169.254.0.0/16",
    "::1",
    "fc00::/7",
    "fd00::/8",
    "fe80::/10",
    "10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,100.64.0.0/10,fc00::/7,fe80::/10",
  ])("accepts %s whole", (value) => {
    expect(parseTrustProxy(value).length).toBeGreaterThan(0);
  });

  it.each(["8.0.0.0/7", "2000::/3", "2001:db8::/31", "::/1", "::ffff:0:0/96"])("still refuses public or mapped %s", (value) => {
    expect(() => parseTrustProxy(value)).toThrow(/TRUST_PROXY/);
  });
});
