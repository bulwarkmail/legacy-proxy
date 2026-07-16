import { describe, expect, it } from "vitest";
import { providerForEmail, resolveProviderName } from "../../src/auth/providers.js";
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
