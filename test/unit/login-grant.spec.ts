// LOGIN_GRANT_SECRET: an address without an account signs in only with a
// grant from the operator's webmail; addresses with an account sign in as
// before. imapflow is replaced by a recorder; nothing leaves the machine.

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import {
  CLOCK_SKEW_SEC,
  LoginGrants,
  issueLoginGrant,
  parseLoginGrantSecret,
  type LoginGrantClaims,
} from "../../src/auth/loginGrant.js";

const imapLogins: string[] = [];
vi.mock("imapflow", () => ({
  ImapFlow: class {
    constructor(private opts: { auth: { user: string; pass?: string } }) {}
    on() {}
    async connect() {
      imapLogins.push(this.opts.auth.user);
      if (this.opts.auth.pass !== "pw") {
        throw Object.assign(new Error("Authentication failed"), { authenticationFailed: true });
      }
    }
    async logout() {}
    close() {}
  },
}));

const SECRET = Buffer.from("a-shared-secret-of-at-least-32-characters!", "utf8");
const PROXY = "https://proxy.example.org";
const T0 = 1_800_000_000;

let jtiCounter = 0;
function claims(over: Partial<LoginGrantClaims> = {}): LoginGrantClaims {
  jtiCounter++;
  return { aud: PROXY, sub: "bob@gmx.test", pri: "bob@family.test", iat: T0, exp: T0 + 60, jti: `jti-${jtiCounter}-0123456789abcdef`, ...over };
}

describe("LoginGrants", () => {
  const grants = () => new LoginGrants(SECRET, PROXY + "/", () => T0 * 1000);

  it("accepts a fresh grant for the address once", () => {
    const g = grants();
    const token = issueLoginGrant(SECRET, claims());
    expect(g.check(token, "Bob@GMX.test ")).toMatchObject({ ok: true, claims: { pri: "bob@family.test" } });
    expect(g.check(token, "bob@gmx.test")).toEqual({ ok: false, reason: "grant already used" });
  });

  it("refuses a grant signed with another secret, or altered", () => {
    const g = grants();
    const other = issueLoginGrant(Buffer.from("another-secret-another-secret-another!!", "utf8"), claims());
    expect(g.check(other, "bob@gmx.test")).toEqual({ ok: false, reason: "bad signature" });
    const [p, body, sig] = issueLoginGrant(SECRET, claims()).split(".");
    const forged = Buffer.from(JSON.stringify({ ...claims(), sub: "eve@gmx.test" })).toString("base64url");
    expect(g.check(`${p}.${forged}.${sig}`, "eve@gmx.test")).toEqual({ ok: false, reason: "bad signature" });
    expect(g.check(`${p}.${body}`, "bob@gmx.test")).toEqual({ ok: false, reason: "malformed grant" });
    expect(g.check(undefined, "bob@gmx.test")).toEqual({ ok: false, reason: "no grant" });
  });

  it("refuses a grant for another proxy or another address", () => {
    const g = grants();
    expect(g.check(issueLoginGrant(SECRET, claims({ aud: "https://other.example.org" })), "bob@gmx.test")).toEqual({ ok: false, reason: "grant for another server" });
    expect(g.check(issueLoginGrant(SECRET, claims()), "eve@gmx.test")).toEqual({ ok: false, reason: "grant for another address" });
  });

  it("allows the clock skew and no more", () => {
    const g = grants();
    expect(g.check(issueLoginGrant(SECRET, claims({ iat: T0 - 60 - CLOCK_SKEW_SEC, exp: T0 - CLOCK_SKEW_SEC })), "bob@gmx.test").ok).toBe(true);
    expect(g.check(issueLoginGrant(SECRET, claims({ iat: T0 - 61 - CLOCK_SKEW_SEC, exp: T0 - 1 - CLOCK_SKEW_SEC })), "bob@gmx.test")).toEqual({ ok: false, reason: "expired" });
    expect(g.check(issueLoginGrant(SECRET, claims({ iat: T0 + CLOCK_SKEW_SEC, exp: T0 + CLOCK_SKEW_SEC + 60 })), "bob@gmx.test").ok).toBe(true);
    expect(g.check(issueLoginGrant(SECRET, claims({ iat: T0 + CLOCK_SKEW_SEC + 1, exp: T0 + CLOCK_SKEW_SEC + 61 })), "bob@gmx.test")).toEqual({ ok: false, reason: "issued in the future" });
  });

  it("refuses a lifetime over five minutes", () => {
    expect(grants().check(issueLoginGrant(SECRET, claims({ exp: T0 + 301 })), "bob@gmx.test")).toEqual({ ok: false, reason: "bad lifetime" });
  });

  it("needs a secret of 32 bytes", () => {
    expect(parseLoginGrantSecret(undefined)).toBeUndefined();
    expect(parseLoginGrantSecret("  ")).toBeUndefined();
    expect(() => parseLoginGrantSecret("short")).toThrow(/at least 32/);
  });
});

let app: FastifyInstance;
let dir: string;

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "legacy-proxy-grant-"));
  const providers = {
    gmx: {
      domains: ["gmx.test"],
      imap: { host: "imap.gmx.test", port: 993, secure: true },
      smtp: { host: "mail.gmx.test", port: 465, secure: true },
      sieve: null,
      carddav: null,
      auth: { mech: ["PLAIN"] },
    },
  };
  fs.writeFileSync(path.join(dir, "providers.json"), JSON.stringify(providers));
  Object.assign(process.env, {
    PORT: "0",
    LISTEN_HOST: "127.0.0.1",
    PUBLIC_URL: PROXY,
    DATA_DIR: dir,
    PROVIDERS_FILE: path.join(dir, "providers.json"),
    DEFAULT_PROVIDER: "keiner",
    VAULT_KEY: crypto.randomBytes(32).toString("base64"),
    SESSION_HMAC_KEY: crypto.randomBytes(32).toString("base64"),
    LOGIN_GRANT_SECRET: SECRET.toString("utf8"),
    LOG_LEVEL: "silent",
  });
  delete process.env.DISCOVERY;
  delete process.env.GMAIL_OAUTH_CLIENT_FILE;
  ({ app } = (await import("../../src/server.js")) as unknown as { app: FastifyInstance });
  await app.ready();
}, 240_000);

afterAll(async () => {
  await app?.close();
  delete process.env.LOGIN_GRANT_SECRET;
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* left for the OS temp cleanup */
  }
});

const now = () => Math.floor(Date.now() / 1000);
const grantFor = (sub: string) => issueLoginGrant(SECRET, claims({ sub, iat: now(), exp: now() + 60 }));
const basic = (user: string, pass: string) => "Basic " + Buffer.from(`${user}:${pass}`).toString("base64");
let ip = 10;
const nextIp = () => `192.0.2.${ip++}`;

describe("with LOGIN_GRANT_SECRET", () => {
  it("refuses a new address without a grant before any IMAP login", async () => {
    imapLogins.length = 0;
    const login = await app.inject({ method: "POST", url: "/api/login", payload: { username: "stranger@gmx.test", password: "pw" }, remoteAddress: nextIp() });
    expect(login.statusCode).toBe(401);
    const session = await app.inject({ method: "GET", url: "/jmap/session", headers: { authorization: basic("stranger@gmx.test", "pw") }, remoteAddress: nextIp() });
    expect(session.statusCode).toBe(401);
    expect(imapLogins).toEqual([]);
  });

  it("admits a new address with a grant over Basic, then without one", async () => {
    const first = await app.inject({
      method: "GET", url: "/jmap/session", remoteAddress: nextIp(),
      headers: { authorization: basic("bob@gmx.test", "pw"), "x-bulwark-login-grant": grantFor("bob@gmx.test") },
    });
    expect(first.statusCode).toBe(200);
    // The browser's own requests carry no grant: the account exists now.
    const login = await app.inject({ method: "POST", url: "/api/login", payload: { username: "bob@gmx.test", password: "pw" }, remoteAddress: nextIp() });
    expect(login.statusCode).toBe(200);
  });

  it("admits a new address with a grant on /api/login", async () => {
    const res = await app.inject({
      method: "POST", url: "/api/login", remoteAddress: nextIp(),
      payload: { username: "carol@gmx.test", password: "pw" },
      headers: { "x-bulwark-login-grant": grantFor("carol@gmx.test") },
    });
    expect(res.statusCode).toBe(200);
  });

  it("does not take a grant twice, or for another address", async () => {
    const grant = grantFor("dave@gmx.test");
    const wrong = await app.inject({
      method: "POST", url: "/api/login", remoteAddress: nextIp(),
      payload: { username: "dave@gmx.test", password: "nope" }, headers: { "x-bulwark-login-grant": grant },
    });
    expect(wrong.statusCode).toBe(401);
    const again = await app.inject({
      method: "POST", url: "/api/login", remoteAddress: nextIp(),
      payload: { username: "dave@gmx.test", password: "pw" }, headers: { "x-bulwark-login-grant": grant },
    });
    expect(again.statusCode).toBe(401);
    const other = await app.inject({
      method: "POST", url: "/api/login", remoteAddress: nextIp(),
      payload: { username: "erin@gmx.test", password: "pw" }, headers: { "x-bulwark-login-grant": grantFor("dave@gmx.test") },
    });
    expect(other.statusCode).toBe(401);
  });
});
