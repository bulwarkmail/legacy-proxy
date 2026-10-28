import { describe, expect, it } from "vitest";
import { providerForEmail, resolveProvider, resolveProviderName } from "../../src/auth/providers.js";
import { davOptions } from "../../src/carddav/client.js";
import type { AppConfig, ProviderConfig } from "../../src/util/config.js";

function provider(domains?: string[]): ProviderConfig {
  return {
    domains,
    imap: { host: "imap.example", port: 993, secure: true },
    smtp: { host: "smtp.example", port: 465, secure: true },
    sieve: null,
    carddav: null,
    auth: { mech: ["PLAIN"] },
  };
}

const cfg = {
  defaultProvider: "generic",
  providers: {
    generic: provider(),
    "mailbox-org": provider(["mailbox.org"]),
    posteo: provider(["posteo.de", "posteo.net"]),
  },
} as unknown as AppConfig;

describe("providerForEmail", () => {
  it("maps an email domain to the provider that claims it", () => {
    expect(providerForEmail(cfg, "alice@posteo.de")).toBe("posteo");
    expect(providerForEmail(cfg, "bob@posteo.net")).toBe("posteo");
    expect(providerForEmail(cfg, "carol@mailbox.org")).toBe("mailbox-org");
  });

  it("is case-insensitive on the domain", () => {
    expect(providerForEmail(cfg, "Alice@Posteo.DE")).toBe("posteo");
  });

  it("returns undefined for unknown domains and non-email usernames", () => {
    expect(providerForEmail(cfg, "alice@example.com")).toBeUndefined();
    expect(providerForEmail(cfg, "plain-username")).toBeUndefined();
    expect(providerForEmail(cfg, "")).toBeUndefined();
    expect(providerForEmail(cfg, undefined)).toBeUndefined();
  });

  it("uses the part after the last @ (quoted local parts)", () => {
    expect(providerForEmail(cfg, '"weird@local"@posteo.de')).toBe("posteo");
  });
});

describe("resolveProviderName", () => {
  it("prefers an explicit provider over everything", () => {
    expect(resolveProviderName(cfg, { explicit: "mailbox-org", username: "x@posteo.de" })).toBe("mailbox-org");
  });

  it("falls back to the domain match when no explicit provider", () => {
    expect(resolveProviderName(cfg, { username: "x@posteo.de" })).toBe("posteo");
  });

  it("falls back to the default provider when the domain is unknown", () => {
    expect(resolveProviderName(cfg, { username: "x@unknown.tld" })).toBe("generic");
    expect(resolveProviderName(cfg, {})).toBe("generic");
  });
});

describe("DAV credentials", () => {
  it("interpolates a separate DAV login from the environment", () => {
    process.env.TEST_DAV_PASSWORD = "s3cret";
    const p = { ...provider(), carddav: { host: "dav.example", port: 443, username: "dav-user", password: "$TEST_DAV_PASSWORD" } };
    const c = { defaultProvider: "x", providers: { x: p } } as unknown as AppConfig;
    expect(resolveProvider(c).carddav).toMatchObject({ username: "dav-user", password: "s3cret" });
  });

  const mail = { mech: "PLAIN", username: "Me@Example.org", password: "mail" } as const;
  const dav = { host: "dav.example", port: 443 };

  it("uses the DAV login only for the mail login it names", () => {
    const cfg = { ...dav, username: "dav-user", password: "pw", forUser: "me@example.org" };
    expect(davOptions(cfg, mail).creds).toEqual({ mech: "PLAIN", username: "dav-user", password: "pw" });
    expect(davOptions(cfg, { ...mail, username: "someone@example.org" }).creds).toEqual({ ...mail, username: "someone@example.org" });
    expect(davOptions(dav, mail).creds).toBe(mail);
  });

  it("refuses a DAV login without forUser, or whose password interpolated to nothing", () => {
    expect(() => davOptions({ ...dav, username: "dav-user", password: "pw" }, mail)).toThrow(/set together/);
    delete process.env.TEST_DAV_UNSET;
    const p = { ...provider(), carddav: { ...dav, username: "dav-user", password: "$TEST_DAV_UNSET", forUser: "me@example.org" } };
    const c = { defaultProvider: "x", providers: { x: p } } as unknown as AppConfig;
    expect(() => davOptions(resolveProvider(c).carddav!, mail)).toThrow(/set together/);
  });
});
