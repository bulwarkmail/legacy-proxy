// "Issue a new bridge password" signs every device of the account out: the
// previous password, every sign-in token and every push subscription of that
// account stop working, open event streams of the account end, and other
// accounts on the bridge keep everything. The gmail:password command does
// the same.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GmailStore, type PushSub } from "../../src/gmail/store.js";
import { GmailPush } from "../../src/gmail/push.js";
import { GMAIL_READONLY, type GmailConfig } from "../../src/gmail/config.js";
import { registerGmailRoutes } from "../../src/gmail/routes.js";

const OWNER = "owner@gmail.test";
const NEIGHBOUR = "neighbour@gmail.test";
const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const f of cleanup.splice(0).reverse()) f();
  vi.useRealTimers();
});

function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "legacy-proxy-gmail-signout-"));
  cleanup.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function openStore(dir: string, key: Buffer) {
  const store = new GmailStore(dir, key);
  cleanup.push(() => store.close());
  return store;
}
async function connect(store: GmailStore, email: string) {
  await store.save(
    email,
    { mech: "XOAUTH2", username: email, accessToken: "fake-access", refreshToken: "fake-refresh", scopes: [GMAIL_READONLY] },
    { profile: { emailAddress: email, historyId: "5", messagesTotal: 1, threadsTotal: 1 }, labels: [] },
  );
}
function subscription(email: string, id: string): Omit<PushSub, "verified" | "failures"> {
  return {
    id,
    email,
    device: "phone",
    url: "https://push.example/" + id,
    types: null,
    expires: Date.now() + 30 * 86400_000,
    code: null,
    createdAt: Date.now(),
    emailPush: null,
  };
}
/** A connected account with a password, a sign-in and a push subscription. */
async function signedIn(store: GmailStore, email: string) {
  await connect(store, email);
  const password = store.issuePassword(email);
  const tokens = store.issueTokens(email, "webmail");
  store.subscribe(subscription(email, "sub-" + email));
  return { password, tokens };
}
function fakeStream() {
  const handlers: Record<string, (() => void)[]> = {};
  const stream = {
    ended: false,
    reply: {
      raw: {
        setHeader() {},
        write() {},
        end() {
          stream.ended = true;
          for (const fn of handlers.close ?? []) fn();
        },
        on(ev: string, fn: () => void) {
          (handlers[ev] ??= []).push(fn);
        },
      },
    } as never,
  };
  return stream;
}

describe("a new bridge password", () => {
  it("ends the account's sign-in tokens and push subscriptions and leaves other accounts alone", async () => {
    const store = openStore(tempDir(), crypto.randomBytes(32));
    const owner = await signedIn(store, OWNER);
    const neighbour = await signedIn(store, NEIGHBOUR);

    const fresh = store.issuePassword(OWNER);

    expect(store.authenticate(owner.password, OWNER)).toBeNull();
    expect(store.authenticate(fresh, OWNER)).toBe(OWNER);
    expect(store.authenticateToken(owner.tokens.accessToken)).toBeNull();
    expect(store.refreshTokens(owner.tokens.refreshToken, "webmail")).toBeNull();
    expect(store.subscriptions(OWNER)).toEqual([]);

    expect(store.authenticate(neighbour.password, NEIGHBOUR)).toBe(NEIGHBOUR);
    expect(store.authenticateToken(neighbour.tokens.accessToken)).toBe(NEIGHBOUR);
    expect(store.refreshTokens(neighbour.tokens.refreshToken, "webmail")).not.toBeNull();
    expect(store.subscriptions(NEIGHBOUR).map((s) => s.id)).toEqual(["sub-" + NEIGHBOUR]);
  });

  it("says on the page that devices were signed out, and refuses the old refresh token right after", async () => {
    const store = openStore(tempDir(), crypto.randomBytes(32));
    const { tokens } = await signedIn(store, OWNER);
    const config = {
      clientId: "test-client",
      clientSecret: "test-secret",
      origin: "https://bridge.example.com",
      redirectUri: "https://bridge.example.com/auth/google/callback",
      secureCookies: true,
      allowedEmails: new Set([OWNER]),
      oauthClients: [{ id: "webmail", redirectUris: ["https://mail.example.com/auth/callback"] }],
    } as unknown as GmailConfig;
    const connection = {
      authorization: vi.fn(async (state: string) => ({ url: `https://accounts.google.com/o/oauth2/v2/auth?state=${state}`, verifier: "v" })),
      connect: vi.fn(async () => OWNER),
      signIn: vi.fn(async () => ({ email: OWNER, needsConsent: false })),
    };
    const app = Fastify();
    cleanup.push(() => void app.close());
    await registerGmailRoutes(app, { config, connection, store, tokens: store });

    const start = await app.inject({
      method: "POST",
      url: "/auth/google/start",
      headers: { origin: config.origin, "content-type": "application/x-www-form-urlencoded" },
      payload: "issue=1",
    });
    const state = new URL(String(start.headers.location)).searchParams.get("state");
    const callback = await app.inject({
      url: `/auth/google/callback?state=${state}&code=abc`,
      headers: { cookie: String(start.headers["set-cookie"]).split(";")[0]! },
    });
    const handoff = ([] as string[])
      .concat(callback.headers["set-cookie"] as string | string[])
      .map((c) => c.split(";")[0]!)
      .find((c) => c.startsWith("gmail_result=") && c.length > "gmail_result=".length)!;
    const page = await app.inject({ url: "/auth/google/result?status=issued", headers: { cookie: handoff } });

    const refresh = await app.inject({
      method: "POST",
      url: "/oauth/token",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: new URLSearchParams({ grant_type: "refresh_token", client_id: "webmail", refresh_token: tokens.refreshToken }).toString(),
    });
    expect(refresh.statusCode).toBe(400);
    expect(refresh.json()).toEqual({ error: "invalid_grant" });

    expect(page.body).toContain("no longer works");
    expect(page.body).toContain("signed out");
    expect(page.body).toContain("push notifications have to be set up again");
    expect((await app.inject("/auth/google/result?status=issued")).body).toContain("signed out");
    expect((await app.inject("/auth/google/start")).body).toContain("signed out");
  });

  it("ends the account's open event streams, and only that account's", async () => {
    const store = openStore(tempDir(), crypto.randomBytes(32));
    await signedIn(store, OWNER);
    await signedIn(store, NEIGHBOUR);
    const log = { warn: vi.fn(), error: vi.fn(), info: vi.fn() } as never;
    const push = new GmailPush(store, () => ({}) as never, new Set([OWNER, NEIGHBOUR]), { topic: "projects/p/topics/t", token: "x".repeat(32) }, log);
    cleanup.push(() => push.stop());
    const ownerStream = fakeStream();
    const neighbourStream = fakeStream();
    push.addStream(OWNER, ownerStream.reply, null, {});
    push.addStream(NEIGHBOUR, neighbourStream.reply, null, {});

    store.issuePassword(OWNER);

    expect(ownerStream.ended).toBe(true);
    expect(neighbourStream.ended).toBe(false);
    // A stream opened with the new password stays open.
    const after = fakeStream();
    push.addStream(OWNER, after.reply, null, {});
    expect(after.ended).toBe(false);
  });

  it("ends streams at the next poll when another process issued the password", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout"] });
    const dir = tempDir();
    const key = crypto.randomBytes(32);
    const store = openStore(dir, key);
    await signedIn(store, OWNER);
    const log = { warn: vi.fn(), error: vi.fn(), info: vi.fn() } as never;
    const mail = { pushSync: vi.fn(async () => ({ changed: false, delivered: 0 })) } as never;
    // Watch renewal is not part of this: no account is allowed to renew.
    const push = new GmailPush(store, () => mail, new Set<string>(), { topic: "projects/p/topics/t", token: "x".repeat(32) }, log);
    cleanup.push(() => push.stop());
    push.start();
    const stream = fakeStream();
    push.addStream(OWNER, stream.reply, null, {});

    // The command line opens the same database in a process of its own.
    const other = openStore(dir, key);
    other.issuePassword(OWNER);
    expect(stream.ended).toBe(false);

    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(stream.ended).toBe(true);
  });
});

describe("the gmail:password command", () => {
  it("signs the account's devices out the same way", async () => {
    const dir = tempDir();
    const key = crypto.randomBytes(32);
    const before = openStore(dir, key);
    const { password, tokens } = await signedIn(before, OWNER);
    before.close();

    fs.writeFileSync(path.join(dir, "google.json"), JSON.stringify({ web: { client_id: "fake-id", client_secret: "fake-secret" } }));
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      DATA_DIR: dir,
      PROVIDERS_FILE: path.join(dir, "none.json"),
      PUBLIC_URL: "https://bridge.example.com",
      VAULT_KEY: key.toString("base64"),
      SESSION_HMAC_KEY: crypto.randomBytes(32).toString("base64"),
      GMAIL_OAUTH_CLIENT_FILE: path.join(dir, "google.json"),
      GMAIL_ALLOWED_EMAILS: OWNER,
      LOG_LEVEL: "silent",
    };
    delete env.TRUST_PROXY;
    const script = fileURLToPath(new URL("../../src/gmail/password.ts", import.meta.url));
    const output = path.join(dir, "bridge-credentials.json");
    const run = spawnSync(process.execPath, ["--import", "tsx", script, OWNER, output], { env, encoding: "utf8", timeout: 60_000 });
    expect(run.status, run.stderr).toBe(0);

    const after = openStore(dir, key);
    const issued = JSON.parse(fs.readFileSync(output, "utf8")) as { password: string };
    expect(after.authenticate(issued.password, OWNER)).toBe(OWNER);
    expect(after.authenticate(password, OWNER)).toBeNull();
    expect(after.authenticateToken(tokens.accessToken)).toBeNull();
    expect(after.refreshTokens(tokens.refreshToken, "webmail")).toBeNull();
    expect(after.subscriptions(OWNER)).toEqual([]);
    expect(run.stdout).toContain("signed out");
  }, 60_000);
});
