// Which provider a login uses once discovery is on, how accounts on a
// discovered provider find it again, and that their IMAP and SMTP
// connections go to the address that was checked. imapflow, nodemailer and
// DNS are replaced by recorders.

import { beforeEach, describe, expect, it, vi } from "vitest";

const imapOptions: Record<string, unknown>[] = [];
vi.mock("imapflow", () => ({
  ImapFlow: class {
    constructor(opts: Record<string, unknown>) {
      imapOptions.push(opts);
    }
    on() {}
    async connect() {}
  },
}));

const smtpOptions: Record<string, unknown>[] = [];
vi.mock("nodemailer", () => ({
  default: {
    createTransport: (opts: Record<string, unknown>) => {
      smtpOptions.push(opts);
      return { sendMail: async () => ({ messageId: "<m@x>", accepted: [], rejected: [], response: "250 ok" }) };
    },
  },
}));

const answers: Record<string, string[]> = {};
const lookups: string[] = [];
vi.mock("node:dns/promises", () => {
  const lookup = async (host: string) => {
    lookups.push(host);
    const list = answers[host];
    if (!list?.length) throw Object.assign(new Error(`ENOTFOUND ${host}`), { code: "ENOTFOUND" });
    return list.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
  };
  class Resolver {
    async resolveSrv(): Promise<never> {
      throw Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" });
    }
  }
  return { default: { lookup, Resolver }, lookup, Resolver };
});

const { resolveLoginProvider, resolveProvider, discoveredKind } = await import("../../src/auth/providers.js");
const { openImap } = await import("../../src/imap/client.js");
const { submit } = await import("../../src/smtp/submit.js");
import type { AppConfig, ProviderConfig } from "../../src/util/config.js";

const entry = (host: string): ProviderConfig => ({
  imap: { host: `imap.${host}`, port: 993, secure: true },
  smtp: { host: `smtp.${host}`, port: 465, secure: true },
  sieve: null,
  carddav: null,
  auth: { mech: ["PLAIN"] },
});

const found = (domain: string): ProviderConfig => ({
  imap: { host: "imap.hoster.net", port: 993, secure: true, starttls: false },
  smtp: { host: "smtp.hoster.net", port: 587, secure: false, starttls: true },
  sieve: null,
  carddav: null,
  auth: { mech: ["PLAIN", "LOGIN"] },
  discovered: { domain, source: "autoconfig" },
});

const config = (over: Partial<AppConfig> = {}): AppConfig =>
  ({
    defaultProvider: "generic",
    providers: { generic: entry("default.net"), posteo: { ...entry("posteo.de"), domains: ["posteo.de"] } },
    discovered: new Map(),
    ...over,
  }) as AppConfig;

describe("resolveLoginProvider", () => {
  it("takes an explicit provider first, then providers.json domains, without discovering", async () => {
    const discover = vi.fn(async (d: string) => found(d));
    const cfg = config();
    expect((await resolveLoginProvider(cfg, { explicit: "generic", username: "a@posteo.de" }, discover))?.name).toBe("generic");
    expect((await resolveLoginProvider(cfg, { username: "a@Posteo.de" }, discover))?.name).toBe("posteo");
    expect(discover).not.toHaveBeenCalled();
  });

  it("discovers a domain providers.json does not list before falling back to DEFAULT_PROVIDER", async () => {
    const discover = vi.fn(async (d: string) => found(d));
    const r = await resolveLoginProvider(config(), { username: "alice@Example.org" }, discover);
    expect(discover).toHaveBeenCalledWith("example.org");
    expect(r?.name).toBe("discovered:example.org");
    expect(r?.provider.imap.host).toBe("imap.hoster.net");
  });

  it("uses a provider a login proved when discovery finds nothing now", async () => {
    const cfg = config();
    cfg.discovered!.set("example.org", found("example.org"));
    const r = await resolveLoginProvider(cfg, { username: "alice@example.org" }, async () => null);
    expect(r?.name).toBe("discovered:example.org");
  });

  it("falls back to DEFAULT_PROVIDER when discovery finds nothing, and to no provider without one", async () => {
    const none = async () => null;
    expect((await resolveLoginProvider(config(), { username: "alice@example.org" }, none))?.name).toBe("generic");
    const r = await resolveLoginProvider(config({ defaultProvider: "keiner" }), { username: "alice@example.org" }, none);
    expect(r).toBeNull();
  });

  it("with discovery off works as before", async () => {
    expect((await resolveLoginProvider(config(), { username: "alice@example.org" }))?.name).toBe("generic");
    expect(await resolveLoginProvider(config({ defaultProvider: "keiner" }), { username: "alice@example.org" })).toBeNull();
    // A provider kept from a time discovery was on is not used with it off.
    const cfg = config({ defaultProvider: "keiner" });
    cfg.discovered!.set("example.org", found("example.org"));
    expect(await resolveLoginProvider(cfg, { username: "alice@example.org" })).toBeNull();
  });

  it("does not discover for a user name without a domain", async () => {
    const discover = vi.fn(async (d: string) => found(d));
    expect((await resolveLoginProvider(config(), { username: "alice" }, discover))?.name).toBe("generic");
    expect(discover).not.toHaveBeenCalled();
  });
});

describe("resolveProvider for discovered kinds", () => {
  it("answers a discovered kind from the proved providers, and nothing else", () => {
    const cfg = config();
    expect(() => resolveProvider(cfg, discoveredKind("example.org"))).toThrow(/Unknown provider/);
    cfg.discovered!.set("example.org", found("example.org"));
    const p = resolveProvider(cfg, discoveredKind("example.org"));
    expect(p.imap.host).toBe("imap.hoster.net");
    p.imap.host = "changed";
    expect(resolveProvider(cfg, discoveredKind("example.org")).imap.host).toBe("imap.hoster.net");
  });
});

describe("connections to a discovered provider", () => {
  const creds = { mech: "PLAIN" as const, username: "alice@example.org", password: "fake-password" };
  beforeEach(() => {
    imapOptions.length = 0;
    smtpOptions.length = 0;
    lookups.length = 0;
    for (const k of Object.keys(answers)) delete answers[k];
  });

  it("go to the checked address and keep the host name for TLS", async () => {
    answers["imap.hoster.net"] = ["203.0.114.10"];
    answers["smtp.hoster.net"] = ["2a01:4f8::25"];
    await openImap({ provider: found("example.org"), creds });
    expect(imapOptions[0]).toMatchObject({ host: "203.0.114.10", servername: "imap.hoster.net", port: 993, secure: true });
    await submit({ provider: found("example.org"), creds, envelopeFrom: creds.username, rcptTo: ["b@x.org"], raw: Buffer.from("x") });
    expect(smtpOptions[0]).toMatchObject({ host: "2a01:4f8::25", servername: "smtp.hoster.net", port: 587, requireTLS: true });
  });

  it("are not made when the host now resolves to a private address", async () => {
    answers["imap.hoster.net"] = ["192.168.1.10"];
    answers["smtp.hoster.net"] = ["127.0.0.1"];
    await expect(openImap({ provider: found("example.org"), creds })).rejects.toThrow(/non-public address/);
    await expect(
      submit({ provider: found("example.org"), creds, envelopeFrom: creds.username, rcptTo: ["b@x.org"], raw: Buffer.from("x") }),
    ).rejects.toThrow(/non-public address/);
    expect(imapOptions).toEqual([]);
    expect(smtpOptions).toEqual([]);
  });

  it("log in with the local part when the autoconfig file asks for it", async () => {
    answers["imap.hoster.net"] = ["203.0.114.10"];
    answers["smtp.hoster.net"] = ["203.0.114.11"];
    const p = found("example.org");
    p.imap.localPartLogin = true;
    p.smtp.localPartLogin = true;
    await openImap({ provider: p, creds });
    await submit({ provider: p, creds, envelopeFrom: creds.username, rcptTo: ["b@x.org"], raw: Buffer.from("x") });
    expect((imapOptions[0]!.auth as { user: string }).user).toBe("alice");
    expect((smtpOptions[0]!.auth as { user: string }).user).toBe("alice");
  });

  it("of a configured provider stay as they were", async () => {
    await openImap({ provider: entry("posteo.de"), creds });
    expect(imapOptions[0]).toMatchObject({ host: "imap.posteo.de" });
    expect(imapOptions[0]).not.toHaveProperty("servername");
    expect((imapOptions[0]!.auth as { user: string }).user).toBe("alice@example.org");
    expect(lookups).toEqual([]);
  });
});
