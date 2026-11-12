// How a check of the stored password ends, and what it holds until then: push
// subscriptions made before it deliver again once it ends "accepted"; a check
// without an answer ends as refused after a day; sign-ins with the new
// password neither end it nor add attempts; the opener's own address being
// held doesn't delay it; and the owner's new session is served throughout.
// Scripted IMAP and a push sink on 127.0.0.1.

import fs from "node:fs";
import http from "node:http";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { bootProxy } from "./fake-imap.js";
import { startScriptedImap, type LoginAnswer, type ScriptedImap } from "./scripted-imap.js";
import { openAccountCredentials } from "../../src/auth/credentials.js";

/** Per user: the answer for each password; anything else is refused. */
const answers: Record<string, Record<string, () => LoginAnswer>> = {};
const received: string[] = [];
let sink: http.Server;
let sinkPort = 0;
let imap: ScriptedImap;
let app: FastifyInstance;
let dir: string;
beforeAll(async () => {
  sink = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      received.push(req.url ?? "");
      res.writeHead(201).end();
    });
  });
  await new Promise<void>((r) => sink.listen(0, "127.0.0.1", r));
  sinkPort = (sink.address() as { port: number }).port;
  imap = await startScriptedImap((user, pass) => answers[user]?.[pass]?.() ?? "no");
  process.env.PUSH_ALLOW_PRIVATE_URLS = "1";
  ({ app, dir } = await bootProxy(imap as never));
}, 60_000);
afterAll(async () => {
  vi.useRealTimers();
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

const ok = (): LoginAnswer => "ok";
const unavailable = (): LoginAnswer => "unavailable";
const login = (username: string, password: string, remoteAddress = "192.0.2.50") =>
  app.inject({ method: "POST", url: "/api/login", payload: { username, password }, remoteAddress });
const tokenOf = async (username: string, password: string, remoteAddress?: string) => {
  const res = await login(username, password, remoteAddress);
  expect(res.statusCode).toBe(200);
  return res.json() as { token: string; accountId: string };
};
const session = (token: string) => app.inject({ method: "GET", url: "/jmap/session", headers: { authorization: `Bearer ${token}` } });
const checksOf = (user: string, pass: string) => imap.attempts.filter((a) => a.user === user && a.pass === pass && a.answer !== "ok").length;
async function changeSomething(t: { token: string; accountId: string }, name: string) {
  const set = await app.inject({
    method: "POST",
    url: "/jmap",
    headers: { authorization: `Bearer ${t.token}` },
    payload: {
      using: ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail", "urn:ietf:params:jmap:submission"],
      methodCalls: [["Identity/set", { accountId: t.accountId, update: { [`i-${t.accountId}`]: { name } } }, "0"]],
    },
  });
  expect(set.body).toContain(`"updated":{"i-${t.accountId}"`);
}
async function withStore<T>(fn: (s: import("../../src/state/store.js").Store) => T | Promise<T>): Promise<T> {
  const { Store } = await import("../../src/state/store.js");
  const store = new Store(dir);
  try {
    return await fn(store);
  } finally {
    store.close();
  }
}
const subscribe = (username: string, id: string) =>
  withStore((s) =>
    s.insertPushSubscription({
      id,
      accountId: s.getAccount(`generic:${username}`)!.id,
      deviceClientId: null,
      url: `http://127.0.0.1:${sinkPort}/${id}`,
      types: null,
      expires: Date.now() + 7 * 86400_000,
      verificationCode: null,
      verified: true,
      createdAt: Date.now(),
      lastPushAt: null,
    }),
  );
const row = (username: string) =>
  withStore(async (s) => {
    const r = s.getAccount(`generic:${username}`)!;
    return {
      gen: r.cred_gen,
      open: !!r.cred_check_tag,
      inRow: (await openAccountCredentials(Buffer.from(process.env.VAULT_KEY!, "base64"), r)).password,
      subscriptions: s.listPushSubscriptions(r.id).map((p) => p.id),
    };
  });
async function untilClosed(username: string) {
  for (let i = 0; i < 300 && (await row(username)).open; i++) await new Promise((r) => setTimeout(r, 50));
}
const delivered = (id: string) => received.filter((u) => u === `/${id}`).length;

describe("the end of a check of the stored password", () => {
  it("lets subscriptions made before it deliver again once it ends accepted", async () => {
    const user = "lia@test.local";
    answers[user] = { old: ok };
    await tokenOf(user, "old");
    await subscribe(user, "lia-before");
    answers[user] = { old: unavailable, new: ok };
    const mine = await tokenOf(user, "new");
    await changeSomething(mine, "During the check");
    await new Promise((r) => setTimeout(r, 1500));
    expect(delivered("lia-before")).toBe(0);
    expect((await session(mine.token)).statusCode).toBe(200);

    // The server takes the old password again; the next attempt answers "accepted".
    answers[user] = { old: ok, new: ok };
    await untilClosed(user);
    expect(await row(user)).toMatchObject({ gen: 0, open: false, inRow: "old", subscriptions: ["lia-before"] });
    await changeSomething(mine, "After the check");
    for (let i = 0; i < 60 && delivered("lia-before") === 0; i++) await new Promise((r) => setTimeout(r, 50));
    expect(delivered("lia-before")).toBe(1);
  }, 30_000);

  it("ends a check without an answer after a day as refused, without another login", async () => {
    const user = "max@test.local";
    const start = Date.now();
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(start);
      answers[user] = { old: ok };
      const old = await tokenOf(user, "old");
      await subscribe(user, "max-before");
      answers[user] = { old: unavailable, new: ok };
      // The faked clock stands still; the check opens a second after the subscription.
      vi.setSystemTime(start + 1_000);
      const mine = await tokenOf(user, "new");
      for (let i = 0; i < 50 && checksOf(user, "old") < 1; i++) await new Promise((r) => setTimeout(r, 20));
      expect(checksOf(user, "old")).toBe(1);

      // Signing in with the new password again neither ends the check nor makes an attempt.
      for (let i = 0; i < 3; i++) await tokenOf(user, "new");
      expect(checksOf(user, "old")).toBe(1);
      expect((await row(user)).open).toBe(true);
      expect((await session(mine.token)).statusCode).toBe(200);

      // A day later the check expires when its next attempt is due: refused, no login.
      vi.setSystemTime(start + 1_000 + 24 * 60 * 60_000 + 1_000);
      expect((await session(old.token)).statusCode).toBe(401);
      expect(checksOf(user, "old")).toBe(1);
      expect(await row(user)).toMatchObject({ gen: 1, open: false, inRow: "new", subscriptions: [] });
      expect((await session(mine.token)).statusCode).toBe(200);
    } finally {
      vi.useRealTimers();
    }
  }, 30_000);

  it("asks the server again at the first retry when the opener's own address is held", async () => {
    const user = "ned@test.local";
    answers[user] = { "owner-password": ok, "second-app-password": ok };
    const owner = await tokenOf(user, "owner-password", "192.0.2.60");
    let first = true;
    answers[user]["owner-password"] = () => {
      if (!first) return "ok";
      first = false;
      return "unavailable";
    };
    await tokenOf(user, "second-app-password", "10.60.0.1");
    // The opener's address held: 50 wrong logins for names that don't exist.
    for (let i = 0; i < 50; i++) await login(`nobody${i}@test.local`, "x", "10.60.0.1");
    expect((await login(user, "second-app-password", "10.60.0.1")).statusCode).toBe(429);
    await untilClosed(user);
    expect(imap.attempts.filter((a) => a.user === user && a.pass === "owner-password").map((a) => a.answer)).toEqual([
      "ok",
      "unavailable",
      "ok",
    ]);
    expect(await row(user)).toMatchObject({ open: false, inRow: "owner-password" });
    expect((await session(owner.token)).statusCode).toBe(200);
  }, 30_000);
});
