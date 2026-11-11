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

// Helpers of the delivered case below, as they were written for it.
const profile = (emailAddress: string) => ({ emailAddress, historyId: "5", messagesTotal: 1, threadsTotal: 1 });
function open(key = crypto.randomBytes(32)) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gmail-sec-"));
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

describe("GB-L2: a bridge secret never reaches the IMAP login", () => {
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

  it("leaves a password that only looks like one in upper case to the legacy backend", async () => {
    const { app, legacy } = await bridgeInFront();
    const res = await app.inject({ method: "GET", url: "/jmap/session", headers: { authorization: basic(EMAIL, "GMAP_not-a-bridge-secret") } });
    await app.close();
    expect(res.statusCode).toBe(200);
    expect(legacy).toHaveBeenCalledTimes(1);
  });
});

describe("failed bridge logins", () => {
  it("are held per address like mail logins, the right password included", async () => {
    const store = await connectedStore();
    const password = store.issuePassword(EMAIL);
    const app = Fastify();
    const config = { allowedEmails: new AllowList([EMAIL]) } as unknown as GmailConfig;
    registerGmailBackend(
      app,
      { publicUrl: "https://bridge.test", limits: { maxCallsInRequest: 16 } } as never,
      config,
      store,
      {} as never,
      {},
      () => ({ writable: async () => false, canCompose: async () => false, accountId: "a1" }) as never,
      new LoginLimiter(),
    );
    // Stands for the legacy route the real server registers.
    app.get("/jmap/session", async () => ({ legacy: true }));
    const lookups = vi.spyOn(store, "authenticate");
    const session = (pass: string) =>
      app.inject({ method: "GET", url: "/jmap/session", headers: { authorization: basic(EMAIL, pass) } });

    for (let i = 0; i < 10; i++) expect((await session(`gmap_wrong${i}`)).statusCode).toBe(401);
    const held = await session(password);
    await app.close();
    expect(held.statusCode).toBe(429);
    expect(held.headers["retry-after"]).toBeDefined();
    expect(lookups).toHaveBeenCalledTimes(10);
  });
});
