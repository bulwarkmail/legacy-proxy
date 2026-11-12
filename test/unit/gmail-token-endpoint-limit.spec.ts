// /oauth/token counts the requests it refuses per client address, in the same
// budget as failed bridge logins: past it they are answered 429 with
// Retry-After. A valid code or refresh token is still served. Without
// TRUST_PROXY the address is the socket's, whatever X-Forwarded-For says.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { GmailStore } from "../../src/gmail/store.js";
import { GMAIL_READONLY, type GmailConfig } from "../../src/gmail/config.js";
import { registerGmailRoutes } from "../../src/gmail/routes.js";
import { LoginLimiter } from "../../src/auth/loginLimit.js";

const EMAIL = "owner@gmail.test";
const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const f of cleanup.splice(0).reverse()) await f();
});

function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "legacy-proxy-token-limit-"));
  cleanup.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

async function bridge() {
  const store = new GmailStore(tempDir(), crypto.randomBytes(32));
  cleanup.push(() => store.close());
  await store.save(
    EMAIL,
    { mech: "XOAUTH2", username: EMAIL, accessToken: "fake-access", refreshToken: "fake-refresh", scopes: [GMAIL_READONLY] },
    { profile: { emailAddress: EMAIL, historyId: "5", messagesTotal: 1, threadsTotal: 1 }, labels: [] },
  );
  const config = {
    clientId: "test-client",
    clientSecret: "test-secret",
    origin: "https://bridge.example.com",
    redirectUri: "https://bridge.example.com/auth/google/callback",
    secureCookies: true,
    allowedEmails: new Set([EMAIL]),
    oauthClients: [{ id: "webmail", redirectUris: ["https://mail.example.com/auth/callback"] }],
  } as unknown as GmailConfig;
  const connection = {
    authorization: vi.fn(async () => ({ url: "https://accounts.google.com/o/oauth2/v2/auth", verifier: "v" })),
    connect: vi.fn(async () => EMAIL),
    signIn: vi.fn(async () => ({ email: EMAIL, needsConsent: false })),
  };
  const logins = new LoginLimiter();
  // Fastify's default: no proxy is trusted, as with TRUST_PROXY unset.
  const app = Fastify();
  cleanup.push(() => app.close());
  await registerGmailRoutes(app, { config, connection, store, tokens: store, logins });
  return { app, store, logins };
}

function tokenRequest(app: FastifyInstance, form: Record<string, string>, extra: { remoteAddress?: string; forwardedFor?: string } = {}) {
  return app.inject({
    method: "POST",
    url: "/oauth/token",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      ...(extra.forwardedFor ? { "x-forwarded-for": extra.forwardedFor } : {}),
    },
    payload: new URLSearchParams(form).toString(),
    ...(extra.remoteAddress ? { remoteAddress: extra.remoteAddress } : {}),
  });
}
const madeUp = () => "gmrt_" + crypto.randomBytes(32).toString("base64url");

describe("refused /oauth/token requests", () => {
  it("are answered 429 with Retry-After once an address used up its budget, and a valid token still works", async () => {
    const { app, store } = await bridge();
    const valid = store.issueTokens(EMAIL, "webmail");
    const statuses: number[] = [];
    for (let i = 0; i < 55; i++) {
      statuses.push((await tokenRequest(app, { grant_type: "refresh_token", client_id: "webmail", refresh_token: madeUp() }, { remoteAddress: "203.0.113.7" })).statusCode);
    }
    expect(statuses.slice(0, 50)).toEqual(new Array(50).fill(400));
    expect(statuses.slice(50)).toEqual(new Array(5).fill(429));
    const held = await tokenRequest(app, { grant_type: "refresh_token", client_id: "webmail", refresh_token: madeUp() }, { remoteAddress: "203.0.113.7" });
    expect(held.statusCode).toBe(429);
    expect(Number(held.headers["retry-after"])).toBeGreaterThan(0);
    expect(held.json()).toEqual({ error: "too many failed logins" });

    // Another address has its own budget.
    expect((await tokenRequest(app, { grant_type: "refresh_token", client_id: "webmail", refresh_token: madeUp() }, { remoteAddress: "198.51.100.9" })).statusCode).toBe(400);
    // The held address still gets an answer for a token that is valid.
    const ok = await tokenRequest(app, { grant_type: "refresh_token", client_id: "webmail", refresh_token: valid.refreshToken }, { remoteAddress: "203.0.113.7" });
    expect(ok.statusCode).toBe(200);
  });

  it("count an unknown client id and a wrong code too", async () => {
    const { app } = await bridge();
    for (let i = 0; i < 25; i++) {
      expect((await tokenRequest(app, { grant_type: "refresh_token", client_id: "nobody", refresh_token: madeUp() })).statusCode).toBe(401);
      expect((await tokenRequest(app, { grant_type: "authorization_code", client_id: "webmail", code: "made-up", redirect_uri: "https://mail.example.com/auth/callback", code_verifier: "v".repeat(43) })).statusCode).toBe(400);
    }
    expect((await tokenRequest(app, { grant_type: "refresh_token", client_id: "nobody", refresh_token: madeUp() })).statusCode).toBe(429);
  });

  it("share the budget with failed bridge logins from the same address", async () => {
    const { app, logins } = await bridge();
    for (let i = 0; i < 50; i++) logins.noteFailedLookup("127.0.0.1");
    expect((await tokenRequest(app, { grant_type: "refresh_token", client_id: "webmail", refresh_token: madeUp() })).statusCode).toBe(429);
  });

  it("are counted by the socket's address when no proxy is trusted, whatever X-Forwarded-For says", async () => {
    const { app } = await bridge();
    const statuses: number[] = [];
    for (let i = 0; i < 52; i++) {
      statuses.push((await tokenRequest(app, { grant_type: "refresh_token", client_id: "webmail", refresh_token: madeUp() }, { forwardedFor: `192.0.2.${i}` })).statusCode);
    }
    expect(statuses.slice(50)).toEqual([429, 429]);
  });
});

describe("the proxy's /oauth/token", () => {
  let app: FastifyInstance;
  let dir: string;
  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "legacy-proxy-token-limit-server-"));
    fs.writeFileSync(path.join(dir, "google.json"), JSON.stringify({ web: { client_id: "fake-id", client_secret: "fake-secret" } }));
    delete process.env.TRUST_PROXY;
    Object.assign(process.env, {
      PORT: "0",
      LISTEN_HOST: "127.0.0.1",
      PUBLIC_URL: "http://127.0.0.1",
      DATA_DIR: dir,
      PROVIDERS_FILE: path.join(dir, "none.json"),
      DEFAULT_PROVIDER: "generic",
      VAULT_KEY: crypto.randomBytes(32).toString("base64"),
      SESSION_HMAC_KEY: crypto.randomBytes(32).toString("base64"),
      LOG_LEVEL: "silent",
      GMAIL_OAUTH_CLIENT_FILE: path.join(dir, "google.json"),
      GMAIL_ALLOWED_EMAILS: EMAIL,
      GMAIL_OAUTH_CLIENTS: JSON.stringify([{ id: "webmail", redirectUris: ["https://mail.example.com/auth/callback"] }]),
    });
    ({ app } = (await import("../../src/server.js")) as unknown as { app: FastifyInstance });
    await app.ready();
  }, 60_000);
  afterAll(async () => {
    delete process.env.GMAIL_OAUTH_CLIENT_FILE;
    delete process.env.GMAIL_ALLOWED_EMAILS;
    delete process.env.GMAIL_OAUTH_CLIENTS;
    await app?.close();
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* left for the OS temp cleanup */
    }
  });

  it("holds an address after its budget of refused requests", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 52; i++) {
      statuses.push((await tokenRequest(app, { grant_type: "refresh_token", client_id: "webmail", refresh_token: madeUp() }, { forwardedFor: `192.0.2.${i}` })).statusCode);
    }
    expect(statuses.slice(0, 50).every((s) => s === 400)).toBe(true);
    expect(statuses.slice(50)).toEqual([429, 429]);
  });
});
