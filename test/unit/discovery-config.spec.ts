// DISCOVERY and DISCOVERY_ALLOWED_HOSTS are read at start; a value the proxy
// can't use stops it with a message, like the other settings.

import { describe, expect, it } from "vitest";
import { parseDiscovery, parseDiscoveryAllowedHosts, plainHostName } from "../../src/util/config.js";
import { validateProviders } from "../../src/auth/providers.js";

describe("parseDiscovery", () => {
  it("is off when unset, empty or off", () => {
    for (const v of [undefined, "", "  ", "off", "OFF", "false", "no", "0", "none"]) expect(parseDiscovery(v)).toEqual([]);
  });

  it("turns on the named sources, always autoconfig before srv", () => {
    expect(parseDiscovery("autoconfig,srv")).toEqual(["autoconfig", "srv"]);
    expect(parseDiscovery("srv, autoconfig")).toEqual(["autoconfig", "srv"]);
    expect(parseDiscovery("SRV")).toEqual(["srv"]);
    expect(parseDiscovery("autoconfig")).toEqual(["autoconfig"]);
  });

  it("refuses unknown sources and empty entries", () => {
    expect(() => parseDiscovery("autoconfig,ispdb")).toThrow(/"ispdb" is not a discovery source/);
    expect(() => parseDiscovery("true")).toThrow(/DISCOVERY=/);
    expect(() => parseDiscovery("srv,")).toThrow(/empty entry/);
  });
});

describe("parseDiscoveryAllowedHosts", () => {
  it("reads host suffixes, lower-cased, a leading dot or *. dropped", () => {
    expect(parseDiscoveryAllowedHosts(undefined)).toEqual([]);
    expect(parseDiscoveryAllowedHosts("")).toEqual([]);
    expect(parseDiscoveryAllowedHosts("Example.NET, .mail.example.org,*.hoster.de")).toEqual([
      "example.net",
      "mail.example.org",
      "hoster.de",
    ]);
  });

  it("refuses entries that are not host names", () => {
    for (const v of ["10.0.0.1", "example.net:993", "https://example.net", "exa mple.net", "a,,b"]) {
      expect(() => parseDiscoveryAllowedHosts(v)).toThrow(/DISCOVERY_ALLOWED_HOSTS/);
    }
  });
});

describe("plainHostName", () => {
  it("accepts DNS names with two or more labels", () => {
    expect(plainHostName("IMAP.Example.org.")).toBe("imap.example.org");
  });

  it("refuses addresses, ports, placeholders and single labels", () => {
    for (const h of ["127.0.0.1", "::1", "[::1]", "localhost", "imap.example.org:993", "%EMAILDOMAIN%", "mail.%EMAILDOMAIN%", "a_b.example.org", ""]) {
      expect(plainHostName(h)).toBeNull();
    }
  });
});

describe("providers.json", () => {
  it("can't name a provider like a discovered one", () => {
    const entry = { imap: { host: "imap.x.org", port: 993 }, smtp: { host: "smtp.x.org", port: 465 }, sieve: null, carddav: null, auth: { mech: ["PLAIN"] } };
    expect(() => validateProviders({ "discovered:x.org": entry })).toThrow(/kept for discovered providers/);
    expect(() => validateProviders({ x: entry })).not.toThrow();
  });
});
