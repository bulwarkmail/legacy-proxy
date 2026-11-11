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
