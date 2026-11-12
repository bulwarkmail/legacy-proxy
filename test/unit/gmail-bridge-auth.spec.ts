// How the Gmail bridge's request hook treats credentials that look like bridge
// secrets: bridge passwords and sign-in tokens select the Gmail backend, and
// failed bridge logins count against the same per-address login budget.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GmailStore } from "../../src/gmail/store.js";
import { registerGmailBackend } from "../../src/gmail/backend.js";
import { AllowList, GMAIL_READONLY, type GmailConfig } from "../../src/gmail/config.js";
import { LoginLimiter } from "../../src/auth/loginLimit.js";

const EMAIL = "owner@gmail.test";
const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const f of cleanup.splice(0)) f();
});

async function connectedStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gmail-auth-"));
  const store = new GmailStore(dir, crypto.randomBytes(32));
  cleanup.push(() => {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  await store.save(
    EMAIL,
    { mech: "XOAUTH2", username: EMAIL, accessToken: "fake-access", refreshToken: "fake-refresh", scopes: [GMAIL_READONLY] },
    { profile: { emailAddress: EMAIL, historyId: "5", messagesTotal: 1, threadsTotal: 1 }, labels: [] },
  );
  return store;
}

const basic = (user: string, pass: string) => "Basic " + Buffer.from(`${user}:${pass}`).toString("base64");

// A store of its own with one connected account, for the first case below.
const profile = (emailAddress: string) => ({ emailAddress, historyId: "5", messagesTotal: 1, threadsTotal: 1 });
function open(key = crypto.randomBytes(32)) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gmail-bridge-"));
  const store = new GmailStore(dir, key);
  cleanup.push(() => {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { store, dir };
}
async function connect(store: GmailStore, email: string) {
  await store.save(
    email,
    { mech: "XOAUTH2", username: email, accessToken: "fake-access", refreshToken: "fake-refresh", scopes: [GMAIL_READONLY] },
    { profile: profile(email), labels: [] },
  );
}

describe("a bridge secret never reaches the IMAP login", () => {
  it("answers 401 to Basic user:gmat_... instead of handing it to the legacy backend", async () => {
    const { store } = open();
    await connect(store, EMAIL);
    const { accessToken } = store.issueTokens(EMAIL, "webmail");
    const app = Fastify();
    const config = { allowedEmails: new AllowList([EMAIL]) } as unknown as GmailConfig;
    registerGmailBackend(
      app,
      { publicUrl: "https://bridge.test", limits: { maxCallsInRequest: 16 } } as never,
      config,
      store,
      {} as never,
      {},
      () => ({}) as never,
    );
    // Stands for the legacy route, which would run an IMAP login with these credentials.
    const legacy = vi.fn(async () => ({ legacy: true }));
    app.get("/jmap/session", legacy);
    const res = await app.inject({
      method: "GET",
      url: "/jmap/session",
      headers: { authorization: "Basic " + Buffer.from(`${EMAIL}:${accessToken}`).toString("base64") },
    });
    await app.close();
    expect(legacy).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
  });
});

/** The bridge hook in front of stand-ins for the legacy routes, which would log in at IMAP. */
async function bridgeInFront() {
  const store = await connectedStore();
  const tokens = store.issueTokens(EMAIL, "webmail");
  const app = Fastify();
  registerGmailBackend(
    app,
    { publicUrl: "https://bridge.test", limits: { maxCallsInRequest: 16 } } as never,
    { allowedEmails: new AllowList([EMAIL]) } as unknown as GmailConfig,
    store,
    {} as never,
    {},
    () => ({}) as never,
  );
  const legacy = vi.fn(async () => ({ legacy: true }));
  app.get("/jmap/session", legacy);
  app.post("/jmap", legacy);
  return { app, legacy, tokens };
}

describe("bridge secrets on the JMAP routes", () => {
  it("answers 401 to a refresh token sent as a Bearer token", async () => {
    const { app, legacy, tokens } = await bridgeInFront();
    const res = await app.inject({ method: "GET", url: "/jmap/session", headers: { authorization: `Bearer ${tokens.refreshToken}` } });
    await app.close();
    expect(res.statusCode).toBe(401);
    expect(legacy).not.toHaveBeenCalled();
  });

  it("decides on the path the router matched, not the raw request line", async () => {
    const { app, legacy, tokens } = await bridgeInFront();
    const auth = { authorization: basic(EMAIL, tokens.accessToken) };
    const results: [string, number][] = [];
    for (const url of ["/%6Amap/session", "/jmap/%73ession", "/JMAP/session", "/jmap/session/", "//jmap/session"]) {
      results.push([url, (await app.inject({ method: "GET", url, headers: auth })).statusCode]);
    }
    const post = await app.inject({ method: "POST", url: "/%6Amap", headers: auth, payload: {} });
    await app.close();
    expect(legacy).not.toHaveBeenCalled();
    for (const [url, status] of results) expect([401, 404], url).toContain(status);
    expect(results[0]![1]).toBe(401);
    expect(post.statusCode).toBe(401);
  });

  it("offers a web page's browser Bearer only, so it never puts up its own password prompt", async () => {
    const { app } = await bridgeInFront();
    const fromPage = await app.inject({
      method: "GET",
      url: "/jmap/session",
      headers: { authorization: basic(EMAIL, "gmap_wrong"), origin: "https://other.example" },
    });
    const navigation = await app.inject({
      method: "GET",
      url: "/jmap/session",
      headers: { authorization: basic(EMAIL, "gmap_wrong"), "sec-fetch-mode": "navigate", "sec-fetch-dest": "document" },
    });
    const fromClient = await app.inject({ method: "GET", url: "/jmap/session", headers: { authorization: basic(EMAIL, "gmap_wrong") } });
    await app.close();
    expect(fromPage.statusCode).toBe(401);
    expect(String(fromPage.headers["www-authenticate"])).not.toMatch(/basic/i);
    expect(navigation.statusCode).toBe(401);
    expect(String(navigation.headers["www-authenticate"])).not.toMatch(/basic/i);
    expect(String(fromClient.headers["www-authenticate"])).toMatch(/basic/i);
  });

  it("serves a download as an attachment that must not be sniffed", async () => {
    const store = await connectedStore();
    const { accessToken } = store.issueTokens(EMAIL, "webmail");
    const app = Fastify();
    registerGmailBackend(
      app,
      { publicUrl: "https://bridge.test", limits: { maxCallsInRequest: 16 } } as never,
      { allowedEmails: new AllowList([EMAIL]) } as unknown as GmailConfig,
      store,
      {} as never,
      {},
      () =>
        ({
          accountId: "a1",
          writable: async () => false,
          canCompose: async () => false,
          download: async () => ({ body: Buffer.from("<p>hello</p>"), type: "application/octet-stream" }),
        }) as never,
    );
    app.get("/jmap/download/:accountId/:blobId/:type/:name", async () => ({ legacy: true }));
    const res = await app.inject({
      method: "GET",
      url: "/jmap/download/a1/blob/text%2Fhtml/page.html",
      headers: { authorization: `Bearer ${accessToken}` },
    });
    await app.close();
    expect(res.statusCode).toBe(200);
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(String(res.headers["content-disposition"])).toMatch(/^attachment/);
  });

  it("answers a body that is not a JMAP Request object with notRequest", async () => {
    const store = await connectedStore();
    const { accessToken } = store.issueTokens(EMAIL, "webmail");
    const app = Fastify();
    registerGmailBackend(
      app,
      { publicUrl: "https://bridge.test", limits: { maxCallsInRequest: 16 } } as never,
      { allowedEmails: new AllowList([EMAIL]) } as unknown as GmailConfig,
      store,
      {} as never,
      {},
      () => ({ accountId: "a1", writable: async () => false, canCompose: async () => false }) as never,
    );
    app.post("/jmap", async () => ({ legacy: true }));
    const res = await app.inject({
      method: "POST",
      url: "/jmap",
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { using: ["urn:ietf:params:jmap:core"], methodCalls: [[1, null, "x"]] },
    });
    await app.close();
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ type: "urn:ietf:params:jmap:error:notRequest" });
  });

  it("leaves a password that only looks like one in upper case to the legacy backend", async () => {
    const { app, legacy } = await bridgeInFront();
    const res = await app.inject({ method: "GET", url: "/jmap/session", headers: { authorization: basic(EMAIL, "GMAP_not-a-bridge-secret") } });
    await app.close();
    expect(res.statusCode).toBe(200);
    expect(legacy).toHaveBeenCalledTimes(1);
  });
});

describe("failed bridge logins", () => {
  it("count against the address's budget for mail logins and never hold a valid bridge login", async () => {
    const store = await connectedStore();
    const password = store.issuePassword(EMAIL);
    const app = Fastify();
    const config = { allowedEmails: new AllowList([EMAIL]) } as unknown as GmailConfig;
    const limiter = new LoginLimiter();
    registerGmailBackend(
      app,
      { publicUrl: "https://bridge.test", limits: { maxCallsInRequest: 16 } } as never,
      config,
      store,
      {} as never,
      {},
      () => ({ writable: async () => false, canCompose: async () => false, accountId: "a1" }) as never,
      limiter,
    );
    // Stands for the legacy route the real server registers.
    app.get("/jmap/session", async () => ({ legacy: true }));
    const session = (pass: string) =>
      app.inject({ method: "GET", url: "/jmap/session", headers: { authorization: basic(EMAIL, pass) } });

    for (let i = 0; i < 50; i++) expect((await session(`gmap_wrong${i}`)).statusCode).toBe(401);
    const valid = await session(password);
    await app.close();
    expect(valid.statusCode).toBe(200);
    expect(valid.json()).not.toEqual({ legacy: true });
    // The 50 failed lookups hold mail logins from that address.
    expect(await limiter.begin("127.0.0.1", "someone@imap.test")).toMatchObject({ ok: false, status: 429 });
  });
});
