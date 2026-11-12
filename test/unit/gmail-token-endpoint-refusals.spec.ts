// The bridge's /oauth/token answers every refused request with its own 400 or
// 401, however many refused requests came before from the same address. A
// mail client's server redeems refresh tokens for all of its users from one
// address: a user whose sign-in ended must be told invalid_grant, and a user
// whose sign-in is fine must get new tokens. The other sign-in routes keep
// their limits.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { GmailStore } from "../../src/gmail/store.js";
import { GMAIL_READONLY, type GmailConfig } from "../../src/gmail/config.js";
import { registerGmailRoutes } from "../../src/gmail/routes.js";

const ENDED = "ended@gmail.test";
const ACTIVE = "active@gmail.test";
const CLIENT_SERVER = "198.51.100.20";
const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const f of cleanup.splice(0).reverse()) await f();
});

async function connect(store: GmailStore, email: string) {
  await store.save(
    email,
    { mech: "XOAUTH2", username: email, accessToken: "fake-access", refreshToken: "fake-refresh", scopes: [GMAIL_READONLY] },
    { profile: { emailAddress: email, historyId: "5", messagesTotal: 1, threadsTotal: 1 }, labels: [] },
  );
}

function tokenRequest(app: FastifyInstance, form: Record<string, string>, remoteAddress = CLIENT_SERVER) {
  return app.inject({
    method: "POST",
    url: "/oauth/token",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    payload: new URLSearchParams(form).toString(),
    remoteAddress,
  });
}
const refresh = (app: FastifyInstance, token: string) => tokenRequest(app, { grant_type: "refresh_token", client_id: "webmail", refresh_token: token });
const madeUp = () => "gmrt_" + crypto.randomBytes(32).toString("base64url");

describe("refused /oauth/token requests from one address", () => {
  async function bridge() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "legacy-proxy-token-refusals-"));
    cleanup.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    const store = new GmailStore(dir, crypto.randomBytes(32));
    cleanup.push(() => store.close());
    await connect(store, ENDED);
    await connect(store, ACTIVE);
    const config = {
      clientId: "test-client",
      clientSecret: "test-secret",
      origin: "https://bridge.example.com",
      redirectUri: "https://bridge.example.com/auth/google/callback",
      secureCookies: true,
      allowedEmails: new Set([ENDED, ACTIVE]),
      oauthClients: [{ id: "webmail", redirectUris: ["https://mail.example.com/auth/callback"] }],
    } as unknown as GmailConfig;
    const connection = {
      authorization: vi.fn(async () => ({ url: "https://accounts.google.com/o/oauth2/v2/auth", verifier: "v" })),
      connect: vi.fn(async () => ACTIVE),
      signIn: vi.fn(async () => ({ email: ACTIVE, needsConsent: false })),
    };
    const app = Fastify();
    cleanup.push(() => app.close());
    await registerGmailRoutes(app, { config, connection, store, tokens: store });
    return { app, store };
  }

  it("leave an ended sign-in answered invalid_grant and a valid one served", async () => {
    const { app, store } = await bridge();
    const ended = store.issueTokens(ENDED, "webmail");
    const active = store.issueTokens(ACTIVE, "webmail");
    store.issuePassword(ENDED); // signs every device of that account out

    for (let i = 0; i < 60; i++) {
      const res = await refresh(app, madeUp());
      expect(res.statusCode).toBe(400);
    }
    for (let i = 0; i < 10; i++) expect((await tokenRequest(app, { grant_type: "refresh_token", client_id: "nobody", refresh_token: madeUp() })).statusCode).toBe(401);

    const endedAnswer = await refresh(app, ended.refreshToken);
    expect(endedAnswer.statusCode).toBe(400);
    expect(endedAnswer.json()).toEqual({ error: "invalid_grant" });
    const activeAnswer = await refresh(app, active.refreshToken);
    expect(activeAnswer.statusCode).toBe(200);
    expect(activeAnswer.json().refresh_token).toMatch(/^gmrt_/);
  });

  it("tell each of 60 users whose sign-ins ended invalid_grant", async () => {
    const { app, store } = await bridge();
    const sessions = Array.from({ length: 60 }, () => store.issueTokens(ENDED, "webmail"));
    store.issuePassword(ENDED);
    const statuses: number[] = [];
    for (const s of sessions) statuses.push((await refresh(app, s.refreshToken)).statusCode);
    expect(statuses.filter((s) => s !== 400)).toEqual([]);
  });
});

describe("the proxy's sign-in routes", () => {
  let app: FastifyInstance;
  let dir: string;
  let key: Buffer;
  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "legacy-proxy-token-refusals-server-"));
    key = crypto.randomBytes(32);
    fs.writeFileSync(path.join(dir, "google.json"), JSON.stringify({ web: { client_id: "fake-id", client_secret: "fake-secret" } }));
    delete process.env.TRUST_PROXY;
    Object.assign(process.env, {
      PORT: "0",
      LISTEN_HOST: "127.0.0.1",
      PUBLIC_URL: "http://127.0.0.1",
      DATA_DIR: dir,
      PROVIDERS_FILE: path.join(dir, "none.json"),
      DEFAULT_PROVIDER: "generic",
      VAULT_KEY: key.toString("base64"),
      SESSION_HMAC_KEY: crypto.randomBytes(32).toString("base64"),
      LOG_LEVEL: "silent",
      GMAIL_OAUTH_CLIENT_FILE: path.join(dir, "google.json"),
      GMAIL_ALLOWED_EMAILS: `${ENDED},${ACTIVE}`,
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

  it("answer /oauth/token without a hold, and still hold failed bridge logins on the JMAP routes", async () => {
    // The command line's way in: a second store on the proxy's database.
    const side = new GmailStore(dir, key);
    await connect(side, ENDED);
    await connect(side, ACTIVE);
    const ended = side.issueTokens(ENDED, "webmail");
    const active = side.issueTokens(ACTIVE, "webmail");
    side.issuePassword(ENDED);
    side.close();

    for (let i = 0; i < 60; i++) expect((await refresh(app, madeUp())).statusCode).toBe(400);
    expect((await refresh(app, ended.refreshToken)).json()).toEqual({ error: "invalid_grant" });
    expect((await refresh(app, active.refreshToken)).statusCode).toBe(200);

    const jmap: number[] = [];
    for (let i = 0; i < 52; i++) {
      const res = await app.inject({
        method: "GET",
        url: "/jmap/session",
        headers: { authorization: "Bearer gmat_" + crypto.randomBytes(32).toString("base64url") },
        remoteAddress: CLIENT_SERVER,
      });
      jmap.push(res.statusCode);
    }
    expect(jmap.slice(0, 50).every((s) => s === 401)).toBe(true);
    expect(jmap.slice(50)).toEqual([429, 429]);
  });
});
