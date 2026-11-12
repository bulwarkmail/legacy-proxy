// A signed-in Gmail bridge client sends its sign-in token (gmat_, Bearer) on
// every request, and access tokens expire after an hour. A valid token is
// served whatever the failure counts of its address: expired tokens of other
// clients behind the same address, and refused mail logins from it, hold
// nothing a valid bridge login needs.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { GmailStore } from "../../src/gmail/store.js";
import { registerGmailBackend } from "../../src/gmail/backend.js";
import { AllowList, GMAIL_READONLY, type GmailConfig } from "../../src/gmail/config.js";
import { LoginLimiter } from "../../src/auth/loginLimit.js";

const A = "alice@gmail.test";
const B = "bob@gmail.test";
const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const f of cleanup.splice(0)) f();
});

async function bridge(limiter: LoginLimiter) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gmail-session-"));
  const store = new GmailStore(dir, crypto.randomBytes(32));
  cleanup.push(() => {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  for (const email of [A, B]) {
    await store.save(
      email,
      { mech: "XOAUTH2", username: email, accessToken: "fake-access", refreshToken: "fake-refresh", scopes: [GMAIL_READONLY] },
      { profile: { emailAddress: email, historyId: "5", messagesTotal: 1, threadsTotal: 1 }, labels: [] },
    );
  }
  const app = Fastify();
  registerGmailBackend(
    app,
    { publicUrl: "https://bridge.test", limits: { maxCallsInRequest: 16 } } as never,
    { allowedEmails: new AllowList([A, B]) } as unknown as GmailConfig,
    store,
    {} as never,
    {},
    () => ({ accountId: "a1", writable: async () => false, canCompose: async () => false }) as never,
    limiter,
  );
  app.get("/jmap/session", async () => ({ legacy: true }));
  cleanup.push(() => void app.close());
  return { app, store };
}

const bearer = (app: import("fastify").FastifyInstance, token: string, remoteAddress: string) =>
  app.inject({ method: "GET", url: "/jmap/session", headers: { authorization: `Bearer ${token}` }, remoteAddress });

describe("Gmail bridge sessions and the login limits", () => {
  it("keeps serving a valid sign-in token after other clients' tokens expired at the same address", async () => {
    const { app, store } = await bridge(new LoginLimiter());
    const now = Date.now();
    // Ten clients behind one address whose access tokens are past their hour.
    const expired = Array.from({ length: 10 }, (_, i) => store.issueTokens(i % 2 ? A : B, "webmail", now - 2 * 3600_000));
    for (const t of expired) expect((await bearer(app, t.accessToken, "203.0.113.9")).statusCode).toBe(401);
    // Bob's current token, from the same address.
    const live = store.issueTokens(B, "webmail");
    const res = await bearer(app, live.accessToken, "203.0.113.9");
    expect(res.statusCode).toBe(200);
  });

  it("keeps serving a valid sign-in token while the address is held for refused mail logins", async () => {
    const limiter = new LoginLimiter();
    const { app, store } = await bridge(limiter);
    // 50 refused mail logins from the address, as /api/login records them.
    for (let i = 0; i < 50; i++) {
      const gate = await limiter.begin("203.0.113.10", `user${i}@imap.test`);
      if (gate.ok) gate.finish("refused");
    }
    const live = store.issueTokens(A, "webmail");
    const res = await bearer(app, live.accessToken, "203.0.113.10");
    expect(res.statusCode).toBe(200);
  });

  it("takes no login slot for a valid sign-in token", async () => {
    // A limiter with one slot, held by a mail login that has not finished.
    const limiter = new LoginLimiter({ maxInFlight: 1, maxWaitMs: 20 });
    const { app, store } = await bridge(limiter);
    const running = await limiter.begin("198.51.100.1", "someone@imap.test");
    const live = store.issueTokens(A, "webmail");
    const res = await bearer(app, live.accessToken, "203.0.113.11");
    if (running.ok) running.finish("accepted");
    expect(res.statusCode).toBe(200);
  });
});
