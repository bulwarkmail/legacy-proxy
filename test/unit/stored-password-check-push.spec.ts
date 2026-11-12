// While a check of the stored password is open, only the new password's
// sessions are served, and push subscriptions made before the check (by the
// old password's sessions) get nothing; a subscription made during the check
// gets the change. Scripted IMAP and a push sink on 127.0.0.1.

import fs from "node:fs";
import http from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { bootProxy } from "./fake-imap.js";
import { startScriptedImap, type ScriptedImap } from "./scripted-imap.js";

const received: string[] = [];
let sink: http.Server;
let sinkPort = 0;
let stored: "ok" | "unavailable" = "ok";
let imap: ScriptedImap;
let app: FastifyInstance;
let dir: string;
beforeAll(async () => {
  sink = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      received.push(`${req.url} ${body}`);
      res.writeHead(201).end();
    });
  });
  await new Promise<void>((r) => sink.listen(0, "127.0.0.1", r));
  sinkPort = (sink.address() as { port: number }).port;
  imap = await startScriptedImap((user, pass) => {
    if (user !== "pam@test.local") return "no";
    if (pass === "old-password") return stored;
    return pass === "new-password" ? "ok" : "no";
  });
  process.env.PUSH_ALLOW_PRIVATE_URLS = "1";
  ({ app, dir } = await bootProxy(imap as never));
}, 60_000);
afterAll(async () => {
  delete process.env.PUSH_ALLOW_PRIVATE_URLS;
  await app.close();
  await imap.close();
  await new Promise<void>((r) => sink.close(() => r()));
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* left for the OS temp cleanup */
  }
});

const login = async (password: string) => {
  const res = await app.inject({ method: "POST", url: "/api/login", payload: { username: "pam@test.local", password } });
  expect(res.statusCode).toBe(200);
  return res.json() as { token: string; accountId: string };
};
async function addVerifiedSubscription(id: string, path: string) {
  const { Store } = await import("../../src/state/store.js");
  const other = new Store(dir);
  try {
    const row = other.getAccount("generic:pam@test.local")!;
    other.insertPushSubscription({
      id,
      accountId: row.id,
      deviceClientId: null,
      url: `http://127.0.0.1:${sinkPort}${path}`,
      types: null,
      expires: Date.now() + 7 * 86400_000,
      verificationCode: null,
      verified: true,
      createdAt: Date.now(),
      lastPushAt: null,
    });
  } finally {
    other.close();
  }
}

describe("push while a check of the stored password has no answer", () => {
  it("delivers nothing to subscriptions made before the check", async () => {
    await login("old-password");
    // A subscription made with the old password (by whoever held a session then).
    await addVerifiedSubscription("before", "/made-before-the-check");
    // The password changes at the server, which answers the old one with "try again later" from now on.
    stored = "unavailable";
    const mine = await login("new-password");
    await new Promise((r) => setTimeout(r, 300));
    // A subscription the new password's session makes during the check (control).
    await addVerifiedSubscription("during", "/made-during-the-check");
    // The owner changes something.
    const set = await app.inject({
      method: "POST",
      url: "/jmap",
      headers: { authorization: `Bearer ${mine.token}` },
      payload: {
        using: ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail", "urn:ietf:params:jmap:submission"],
        methodCalls: [["Identity/set", { accountId: mine.accountId, update: { [`i-${mine.accountId}`]: { name: "During the check" } } }, "0"]],
      },
    });
    expect(set.body).toContain(`"updated":{"i-${mine.accountId}"`);
    await new Promise((r) => setTimeout(r, 1500));
    expect(received.some((r) => r.startsWith("/made-during-the-check"))).toBe(true);
    expect(received.filter((r) => r.startsWith("/made-before-the-check"))).toEqual([]);
  }, 30_000);
});
