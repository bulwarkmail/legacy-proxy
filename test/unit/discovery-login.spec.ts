// Logins at the proxy with DISCOVERY on: a domain with no provider anywhere
// is answered 401 with a log line (not 500), and a provider a login proved
// before the restart serves its domain again. imapflow and DNS are replaced
// by recorders; nothing leaves the machine.

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";

const imapOptions: Record<string, unknown>[] = [];
vi.mock("imapflow", () => ({
  ImapFlow: class {
    constructor(private opts: Record<string, unknown>) {
      imapOptions.push(opts);
    }
    on() {}
    async connect() {
      if ((this.opts.auth as { pass?: string }).pass !== "pw") {
        throw Object.assign(new Error("Authentication failed"), { authenticationFailed: true });
      }
    }
    async logout() {}
    close() {}
  },
}));

const answers: Record<string, string[]> = {
  "imap.hoster.net": ["203.0.114.10"],
  "smtp.hoster.net": ["203.0.114.11"],
};
vi.mock("node:dns/promises", () => {
  const lookup = async (host: string) => {
    const list = answers[host];
    if (!list?.length) throw Object.assign(new Error(`ENOTFOUND ${host}`), { code: "ENOTFOUND" });
    return list.map((address) => ({ address, family: 4 }));
  };
  class Resolver {
    async resolveSrv(): Promise<never> {
      throw Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" });
    }
  }
  return { default: { lookup, Resolver }, lookup, Resolver };
});

let app: FastifyInstance;
let dir: string;
let warnings: string[];

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "legacy-proxy-discovery-"));
  const providers = {
    posteo: {
      domains: ["posteo.de"],
      imap: { host: "imap.posteo.de", port: 993, secure: true },
      smtp: { host: "smtp.posteo.de", port: 465, secure: true },
      sieve: null,
      carddav: null,
      auth: { mech: ["PLAIN"] },
    },
  };
  fs.writeFileSync(path.join(dir, "providers.json"), JSON.stringify(providers));
  // A provider discovered and proved by a login before this start.
  const { Store } = await import("../../src/state/store.js");
  const before = new Store(dir);
  before.saveDiscoveredProvider(
    "kept.example",
    JSON.stringify({
      imap: { host: "imap.hoster.net", port: 993, secure: true, starttls: false },
      smtp: { host: "smtp.hoster.net", port: 465, secure: true, starttls: false },
      sieve: null,
      carddav: null,
      auth: { mech: ["PLAIN", "LOGIN"] },
      discovered: { domain: "kept.example", source: "srv" },
    }),
  );
  before.close();
  Object.assign(process.env, {
    PORT: "0",
    LISTEN_HOST: "127.0.0.1",
    PUBLIC_URL: "http://127.0.0.1",
    DATA_DIR: dir,
    PROVIDERS_FILE: path.join(dir, "providers.json"),
    DEFAULT_PROVIDER: "keiner",
    DISCOVERY: "autoconfig,srv",
    VAULT_KEY: crypto.randomBytes(32).toString("base64"),
    SESSION_HMAC_KEY: crypto.randomBytes(32).toString("base64"),
    LOG_LEVEL: "silent",
  });
  delete process.env.GMAIL_OAUTH_CLIENT_FILE;
  ({ app } = (await import("../../src/server.js")) as unknown as { app: FastifyInstance });
  await app.ready();
  const { log } = await import("../../src/util/log.js");
  warnings = [];
  vi.spyOn(log, "warn").mockImplementation(((...args: unknown[]) => {
    warnings.push(String(args.find((a) => typeof a === "string") ?? ""));
  }) as never);
}, 60_000);

afterAll(async () => {
  await app?.close();
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* left for the OS temp cleanup */
  }
});

const basic = (user: string, pass: string) => "Basic " + Buffer.from(`${user}:${pass}`).toString("base64");

describe("a domain with no provider", () => {
  it("is answered 401 on /jmap/session with HTTP Basic, and logged", async () => {
    warnings.length = 0;
    const res = await app.inject({ method: "GET", url: "/jmap/session", headers: { authorization: basic("bob@nowhere.example", "pw") } });
    expect(res.statusCode).toBe(401);
    expect(warnings.join("\n")).toMatch(/login refused: the email domain is not in providers.json, discovery found no usable mail servers/);
  });

  it("is answered 401 on /api/login", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/login",
      payload: { username: "bob@nowhere.example", password: "pw" },
      remoteAddress: "192.0.2.77",
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: "auth failed" });
  });
});

describe("a provider a login proved before the restart", () => {
  it("serves its domain again, connecting to the checked address", async () => {
    imapOptions.length = 0;
    const res = await app.inject({ method: "POST", url: "/api/login", payload: { username: "alice@kept.example", password: "pw" } });
    expect(res.statusCode).toBe(200);
    expect(imapOptions[0]).toMatchObject({ host: "203.0.114.10", servername: "imap.hoster.net", port: 993 });
    const session = await app.inject({ method: "GET", url: "/jmap/session", headers: { authorization: `Bearer ${res.json().token}` } });
    expect(session.statusCode).toBe(200);
  });
});
