import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import {
  isLoopbackHost,
  providerForEmail,
  resolveProviderName,
  transportOf,
  transportProblem,
  validateProviders,
} from "../../src/auth/providers.js";
import { loadConfig, type AppConfig, type ProviderConfig } from "../../src/util/config.js";

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

describe("transport rules for provider entries", () => {
  const plain = { host: "mail.example", port: 143 };

  it("accepts implicit TLS and STARTTLS", () => {
    expect(transportProblem("imap", { host: "mail.example", port: 993, secure: true })).toBeNull();
    expect(transportProblem("imap", { ...plain, starttls: true })).toBeNull();
    expect(transportProblem("smtp", { host: "mail.example", port: 465, secure: true })).toBeNull();
    expect(transportProblem("smtp", { host: "mail.example", port: 587, starttls: true })).toBeNull();
    expect(transportProblem("sieve", { host: "mail.example", port: 4190, starttls: true })).toBeNull();
    expect(transportProblem("carddav", { host: "dav.example", port: 443, secure: true })).toBeNull();
  });

  it("keeps each service's default when secure is left out", () => {
    expect(transportOf("imap", { host: "h", port: 993 })).toEqual({ secure: true, starttls: false });
    expect(transportOf("imap", { host: "h", port: 143, starttls: true })).toEqual({ secure: false, starttls: true });
    expect(transportOf("smtp", { host: "h", port: 465 })).toEqual({ secure: true, starttls: false });
    expect(transportOf("smtp", { host: "h", port: 587 })).toEqual({ secure: false, starttls: false });
    expect(transportOf("sieve", { host: "h", port: 4190 })).toEqual({ secure: false, starttls: false });
  });

  it("refuses a plain connection to a remote host", () => {
    expect(transportProblem("imap", { ...plain, secure: false })).toMatch(/in clear/);
    // SMTP on 587 with neither flag used to upgrade only when the server offered it.
    expect(transportProblem("smtp", { host: "mail.example", port: 587 })).toMatch(/in clear/);
    expect(transportProblem("sieve", { host: "mail.example", port: 4190 })).toMatch(/in clear/);
    expect(transportProblem("carddav", { host: "dav.example", port: 80 })).toMatch(/plain http/);
    expect(transportProblem("carddav", { host: "dav.example", port: 80, secure: false })).toMatch(/plain http/);
  });

  it("accepts a plain connection when the entry allows it or the host is loopback", () => {
    expect(transportProblem("imap", { ...plain, secure: false, allowPlaintext: true })).toBeNull();
    expect(transportProblem("smtp", { host: "mail.example", port: 587, allowPlaintext: true })).toBeNull();
    expect(transportProblem("carddav", { host: "dav.example", port: 80, allowPlaintext: true })).toBeNull();
    for (const host of ["localhost", "127.0.0.1", "127.1.2.3", "::1", "[::1]", "localhost:8080", "LOCALHOST"]) {
      expect(isLoopbackHost(host), host).toBe(true);
      expect(transportProblem("sieve", { host, port: 4190 }), host).toBeNull();
    }
    for (const host of ["127.0.0.1.example", "localhost.example", "10.0.0.1", "::2", "mail.example"]) {
      expect(isLoopbackHost(host), host).toBe(false);
    }
  });

  it("calls secure together with starttls a configuration error", () => {
    expect(transportProblem("imap", { ...plain, secure: true, starttls: true })).toMatch(/contradict/);
    expect(transportProblem("smtp", { host: "h", port: 587, secure: true, starttls: true })).toMatch(/contradict/);
  });

  it("names the provider and the service of every wrong entry", () => {
    const providers = {
      good: provider(),
      legacy: {
        ...provider(),
        imap: { host: "imap.legacy.example", port: 143, secure: false },
        smtp: { host: "smtp.legacy.example", port: 587 },
      },
    } as Record<string, ProviderConfig>;
    expect(() => validateProviders(providers)).toThrow(/provider "legacy", imap \(imap\.legacy\.example:143\)/);
    expect(() => validateProviders(providers)).toThrow(/provider "legacy", smtp \(smtp\.legacy\.example:587\)/);
    expect(() => validateProviders({ good: provider() })).not.toThrow();
  });

  it("checks the host after $VAR interpolation", () => {
    process.env.SEC_TEST_IMAP_HOST = "127.0.0.1";
    try {
      expect(() =>
        validateProviders({
          local: { ...provider(), imap: { host: "$SEC_TEST_IMAP_HOST", port: 143, secure: false } },
        }),
      ).not.toThrow();
    } finally {
      delete process.env.SEC_TEST_IMAP_HOST;
    }
  });
});

describe("loading a providers file with a plain entry", () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });

  it("stops the start with a message that names the provider, the service and the ways out", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lproxy-providers-"));
    const file = path.join(dir, "providers.json");
    fs.writeFileSync(
      file,
      JSON.stringify({
        generic: { ...provider(), sieve: { host: "sieve.example", port: 4190 } },
      }),
    );
    Object.assign(process.env, {
      DATA_DIR: dir,
      PROVIDERS_FILE: file,
      VAULT_KEY: crypto.randomBytes(32).toString("base64"),
      SESSION_HMAC_KEY: crypto.randomBytes(32).toString("base64"),
    });
    try {
      expect(() => loadConfig()).toThrow(/provider "generic", sieve \(sieve\.example:4190\).*"starttls": true.*"allowPlaintext": true/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
