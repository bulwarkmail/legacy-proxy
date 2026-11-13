// Discovery of a domain's mail servers with DNS and https replaced by
// recorders: nothing here reaches the network.

import { describe, expect, it } from "vitest";
import {
  ProviderDiscovery,
  fetchPinned,
  hostAllowed,
  orderSrv,
  redirectAllowed,
  srvOffer,
  storedDiscoveredProvider,
  type DiscoveryDeps,
  type SrvRecord,
} from "../../src/auth/discovery.js";
import type { DiscoveryConfig } from "../../src/util/config.js";

const PUBLIC = "203.0.114.10"; // not in any blocked range
const autoconfigXml = (imapHost: string, smtpHost: string) => `<clientConfig version="1.1"><emailProvider id="x">
  <incomingServer type="imap"><hostname>${imapHost}</hostname><port>993</port><socketType>SSL</socketType><username>%EMAILADDRESS%</username></incomingServer>
  <outgoingServer type="smtp"><hostname>${smtpHost}</hostname><port>465</port><socketType>SSL</socketType><username>%EMAILADDRESS%</username></outgoingServer>
</emailProvider></clientConfig>`;

interface World {
  addresses?: Record<string, string[]>;
  srv?: Record<string, SrvRecord[]>;
  files?: Record<string, string>;
}

function deps(world: World, clock = { now: 1_000_000 }) {
  const calls = { fetch: [] as string[], srv: [] as string[], lookup: [] as string[] };
  const d: DiscoveryDeps = {
    lookup: async (host) => {
      calls.lookup.push(host);
      const list = world.addresses?.[host] ?? [PUBLIC];
      if (!list.length) throw Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" });
      return list.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
    },
    resolveSrv: async (name) => {
      calls.srv.push(name);
      const r = world.srv?.[name];
      if (!r) throw Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" });
      return r;
    },
    fetchText: async (url) => {
      calls.fetch.push(url);
      const body = world.files?.[url];
      if (body === undefined) throw new Error("answered 404");
      return body;
    },
    now: () => clock.now,
  };
  return { d, calls, clock };
}

const on = (sources: DiscoveryConfig["sources"], allowedHosts: string[] = []): DiscoveryConfig => ({ sources, allowedHosts });
const AC1 = "https://autoconfig.example.org/mail/config-v1.1.xml";
const AC2 = "https://example.org/.well-known/autoconfig/mail/config-v1.1.xml";
const srv = (name: string, port: number, priority = 0, weight = 0): SrvRecord => ({ name, port, priority, weight });

describe("ProviderDiscovery", () => {
  it("does nothing when discovery is off", async () => {
    const { d, calls } = deps({ files: { [AC1]: autoconfigXml("imap.example.org", "smtp.example.org") } });
    expect(await new ProviderDiscovery(on([]), d).discover("example.org")).toBeNull();
    expect(calls.fetch).toEqual([]);
  });

  it("builds a provider entry from autoconfig, like one from providers.json", async () => {
    const { d } = deps({ files: { [AC1]: autoconfigXml("imap.example.org", "smtp.example.org") } });
    const p = await new ProviderDiscovery(on(["autoconfig", "srv"]), d).discover("Example.org");
    expect(p).toEqual({
      imap: { host: "imap.example.org", port: 993, secure: true, starttls: false },
      smtp: { host: "smtp.example.org", port: 465, secure: true, starttls: false },
      sieve: null,
      carddav: null,
      auth: { mech: ["PLAIN", "LOGIN"] },
      discovered: { domain: "example.org", source: "autoconfig" },
    });
  });

  it("tries the well-known URL second and SRV records last", async () => {
    const { d, calls } = deps({
      srv: {
        "_imaps._tcp.example.org": [srv("mail.example.org", 993)],
        "_submission._tcp.example.org": [srv("mail.example.org", 587)],
      },
    });
    const p = await new ProviderDiscovery(on(["autoconfig", "srv"]), d).discover("example.org");
    expect(calls.fetch).toEqual([AC1, AC2]);
    expect(p?.discovered?.source).toBe("srv");
    expect(p?.imap).toEqual({ host: "mail.example.org", port: 993, secure: true, starttls: false });
    expect(p?.smtp).toEqual({ host: "mail.example.org", port: 587, secure: false, starttls: true });
  });

  it("stops at the first source that gives both servers", async () => {
    const { d, calls } = deps({
      files: { [AC2]: autoconfigXml("imap.example.org", "smtp.example.org") },
      srv: { "_imaps._tcp.example.org": [srv("other.example.org", 993)] },
    });
    const p = await new ProviderDiscovery(on(["autoconfig", "srv"]), d).discover("example.org");
    expect(p?.imap.host).toBe("imap.example.org");
    expect(calls.srv).toEqual([]);
  });

  it("uses only the sources DISCOVERY names", async () => {
    const { d, calls } = deps({
      files: { [AC1]: autoconfigXml("imap.example.org", "smtp.example.org") },
      srv: { "_imaps._tcp.example.org": [srv("mail.example.org", 993)], "_submissions._tcp.example.org": [srv("mail.example.org", 465)] },
    });
    const p = await new ProviderDiscovery(on(["srv"]), d).discover("example.org");
    expect(calls.fetch).toEqual([]);
    expect(p?.discovered?.source).toBe("srv");
  });

  it("refuses hosts that resolve to private, loopback or link-local addresses", async () => {
    for (const bad of [["10.1.2.3"], ["127.0.0.1"], ["169.254.169.254"], ["::1"], ["fe80::1"], ["fd00::5"], [PUBLIC, "192.168.1.1"]]) {
      const { d } = deps({
        files: { [AC1]: autoconfigXml("imap.example.org", "smtp.example.org") },
        addresses: { "imap.example.org": bad },
      });
      expect(await new ProviderDiscovery(on(["autoconfig"]), d).discover("example.org")).toBeNull();
    }
  });

  it("takes the next server when the first one is refused", async () => {
    const xml = autoconfigXml("internal.example.org", "smtp.example.org").replace(
      "</emailProvider>",
      `<incomingServer type="imap"><hostname>imap.example.org</hostname><port>993</port><socketType>SSL</socketType></incomingServer></emailProvider>`,
    );
    const { d } = deps({ files: { [AC1]: xml }, addresses: { "internal.example.org": ["10.0.0.9"] } });
    const p = await new ProviderDiscovery(on(["autoconfig"]), d).discover("example.org");
    expect(p?.imap.host).toBe("imap.example.org");
  });

  it("keeps to DISCOVERY_ALLOWED_HOSTS", async () => {
    const world = { files: { [AC1]: autoconfigXml("imap.hoster.net", "smtp.elsewhere.com") } };
    expect(await new ProviderDiscovery(on(["autoconfig"], ["hoster.net"]), deps(world).d).discover("example.org")).toBeNull();
    const both = { files: { [AC1]: autoconfigXml("imap.hoster.net", "smtp.hoster.net") } };
    expect(await new ProviderDiscovery(on(["autoconfig"], ["hoster.net"]), deps(both).d).discover("example.org")).not.toBeNull();
  });

  it("refuses an email domain that is not a plain host name without asking anyone", async () => {
    const { d, calls } = deps({});
    const discovery = new ProviderDiscovery(on(["autoconfig", "srv"]), d);
    for (const domain of ["localhost", "127.0.0.1", "[::1]", "exa mple.org", "x/../y.org"]) {
      expect(await discovery.discover(domain)).toBeNull();
    }
    expect(calls.fetch).toEqual([]);
    expect(calls.srv).toEqual([]);
  });

  it("caches found providers for an hour and failures for five minutes", async () => {
    const world: World = {};
    const { d, calls, clock } = deps(world);
    const discovery = new ProviderDiscovery(on(["autoconfig"]), d);
    expect(await discovery.discover("example.org")).toBeNull();
    world.files = { [AC1]: autoconfigXml("imap.example.org", "smtp.example.org") };
    clock.now += 5 * 60_000 - 1;
    expect(await discovery.discover("example.org")).toBeNull();
    expect(calls.fetch).toHaveLength(2);
    clock.now += 1;
    expect(await discovery.discover("example.org")).not.toBeNull();
    expect(calls.fetch).toHaveLength(3);
    world.files = {};
    clock.now += 60 * 60_000 - 1;
    expect(await discovery.discover("example.org")).not.toBeNull();
    expect(calls.fetch).toHaveLength(3);
    clock.now += 1;
    expect(await discovery.discover("example.org")).toBeNull();
  });

  it("hands out copies, so a caller can't change the cached entry", async () => {
    const { d } = deps({ files: { [AC1]: autoconfigXml("imap.example.org", "smtp.example.org") } });
    const discovery = new ProviderDiscovery(on(["autoconfig"]), d);
    const first = await discovery.discover("example.org");
    first!.imap.host = "changed.example.org";
    expect((await discovery.discover("example.org"))?.imap.host).toBe("imap.example.org");
  });

  it("holds at most maxEntries domains, dropping the oldest", async () => {
    const { d } = deps({});
    const discovery = new ProviderDiscovery(on(["srv"]), d, { maxEntries: 3 });
    for (const n of [1, 2, 3, 4, 5]) await discovery.discover(`d${n}.example.org`);
    expect(discovery.size).toBe(3);
  });

  it("shares one discovery between logins for the same domain", async () => {
    const { d, calls } = deps({ files: { [AC1]: autoconfigXml("imap.example.org", "smtp.example.org") } });
    const discovery = new ProviderDiscovery(on(["autoconfig"]), d);
    const all = await Promise.all([1, 2, 3].map(() => discovery.discover("example.org")));
    expect(all.every((p) => p?.imap.host === "imap.example.org")).toBe(true);
    expect(calls.fetch).toEqual([AC1]);
  });

  it("gives up after its time limit", async () => {
    const { d } = deps({});
    d.fetchText = () => new Promise(() => {});
    const discovery = new ProviderDiscovery(on(["autoconfig"]), d, { totalTimeoutMs: 50 });
    expect(await discovery.discover("example.org")).toBeNull();
  });
});

describe("SRV records", () => {
  it("are tried by priority, then by weight", () => {
    const ordered = orderSrv([srv("c.example.org", 993, 20, 0), srv("b.example.org", 993, 10, 1), srv("a.example.org", 993, 10, 5), srv(".", 0, 0, 0)]);
    expect(ordered.map((r) => r.name)).toEqual(["a.example.org", "b.example.org", "c.example.org"]);
  });

  it("prefer implicit TLS, take submission only on its ports, and skip targets that are not host names", async () => {
    const records: Record<string, SrvRecord[]> = {
      "_imaps._tcp.example.org": [srv("imaps2.example.org", 993, 5), srv("imaps1.example.org", 993, 1), srv("10.0.0.1", 993, 0)],
      "_imap._tcp.example.org": [srv("imap.example.org", 143)],
      "_submissions._tcp.example.org": [srv("smtps.example.org", 465), srv("smtps.example.org", 25)],
      "_submission._tcp.example.org": [srv("smtp.example.org", 587)],
    };
    const offer = await srvOffer("example.org", async (name) => records[name] ?? []);
    expect(offer.imap.map((c) => `${c.host}:${c.port}:${c.secure}`)).toEqual([
      "imaps1.example.org:993:true",
      "imaps2.example.org:993:true",
      "imap.example.org:143:false",
    ]);
    expect(offer.smtp.map((c) => `${c.host}:${c.port}:${c.secure}`)).toEqual(["smtps.example.org:465:true", "smtp.example.org:587:false"]);
    expect(offer.refused).toHaveLength(2);
  });

  it("with only a \".\" target say the service is not offered", async () => {
    const offer = await srvOffer("example.org", async () => [srv(".", 0)]);
    expect(offer.imap).toEqual([]);
    expect(offer.smtp).toEqual([]);
  });
});

describe("hostAllowed", () => {
  it("matches the host or a name below it, on a label boundary", () => {
    expect(hostAllowed("anything.example", [])).toBe(true);
    expect(hostAllowed("hoster.net", ["hoster.net"])).toBe(true);
    expect(hostAllowed("imap.hoster.net", ["hoster.net"])).toBe(true);
    expect(hostAllowed("evilhoster.net", ["hoster.net"])).toBe(false);
    expect(hostAllowed("hoster.net.evil.com", ["hoster.net"])).toBe(false);
  });
});

describe("the autoconfig fetch", () => {
  it("refuses a host that resolves to a private address before connecting", async () => {
    const lookups: string[] = [];
    const fetched = fetchPinned("https://autoconfig.example.org/mail/config-v1.1.xml", {
      lookup: async (h) => {
        lookups.push(h);
        return [{ address: "10.0.0.1", family: 4 }];
      },
      timeoutMs: 1000,
      maxBytes: 1000,
    });
    await expect(fetched).rejects.toThrow(/non-public address/);
    expect(lookups).toEqual(["autoconfig.example.org"]);
  });

  it("refuses http and IP hosts", async () => {
    const opts = { lookup: async () => [{ address: PUBLIC, family: 4 }], timeoutMs: 1000, maxBytes: 1000 };
    await expect(fetchPinned("http://autoconfig.example.org/x", opts)).rejects.toThrow(/only https/);
    await expect(fetchPinned(`https://${PUBLIC}/x`, opts)).rejects.toThrow(/not a plain host name/);
  });

  it("follows redirects only to https on the same host and port", () => {
    const from = new URL("https://example.org/.well-known/autoconfig/mail/config-v1.1.xml");
    expect(redirectAllowed(from, new URL("https://example.org/autoconfig.xml"))).toBe(true);
    expect(redirectAllowed(from, new URL("http://example.org/autoconfig.xml"))).toBe(false);
    expect(redirectAllowed(from, new URL("https://www.example.org/autoconfig.xml"))).toBe(false);
    expect(redirectAllowed(from, new URL("https://example.org:8443/autoconfig.xml"))).toBe(false);
  });
});

describe("a kept discovered provider", () => {
  const good = {
    imap: { host: "imap.hoster.net", port: 993, secure: true, starttls: false, localPartLogin: true },
    smtp: { host: "smtp.hoster.net", port: 587, secure: false, starttls: true },
    sieve: null,
    carddav: null,
    auth: { mech: ["PLAIN", "LOGIN"] },
    discovered: { domain: "example.org", source: "autoconfig" },
  };

  it("is read back as it was kept", () => {
    expect(storedDiscoveredProvider("example.org", JSON.stringify(good), on(["autoconfig"]))).toEqual(good);
  });

  it("is dropped when it no longer passes today's rules", () => {
    const cfg = on(["autoconfig"]);
    expect(storedDiscoveredProvider("example.org", JSON.stringify(good), on(["autoconfig"], ["other.net"]))).toBeNull();
    const plain = { ...good, smtp: { host: "smtp.hoster.net", port: 587, secure: false, starttls: false } };
    expect(storedDiscoveredProvider("example.org", JSON.stringify(plain), cfg)).toBeNull();
    const ip = { ...good, imap: { host: "10.0.0.1", port: 993, secure: true, starttls: false } };
    expect(storedDiscoveredProvider("example.org", JSON.stringify(ip), cfg)).toBeNull();
    expect(storedDiscoveredProvider("example.org", "{not json", cfg)).toBeNull();
  });
});
