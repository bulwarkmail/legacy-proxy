// LPROXY-03: every unauthenticated request with credentials becomes an IMAP
// login from the proxy's address, without limit. Belongs in test/unit/.
//
// Fails on fe595e1: 30 wrong passwords give 30 IMAP logins and no 429.

import fs from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { bootProxy, startFakeImap, type FakeImap } from "./sec-fake-imap.js";

let imap: FakeImap;
let app: FastifyInstance;
let dir: string;
beforeAll(async () => {
  imap = await startFakeImap({ "carol@test.local": "right-password", "dave@test.local": "right-password" });
  ({ app, dir } = await bootProxy(imap));
}, 60_000);
afterAll(async () => {
  await app.close();
  await imap.close();
  // The server keeps proxy.db open until the process ends (Windows refuses the unlink).
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* left for the OS temp cleanup */
  }
});

const basic = (user: string, pass: string) => "Basic " + Buffer.from(`${user}:${pass}`).toString("base64");

describe("failed logins are limited before they reach the mail server (LPROXY-03)", () => {
  it("stops forwarding wrong passwords for one user on /api/login", async () => {
    const before = imap.failedLogins;
    const statuses: number[] = [];
    for (let i = 0; i < 30; i++) {
      const res = await app.inject({
        method: "POST",
        url: "/api/login",
        payload: { username: "carol@test.local", password: `guess-${i}` },
      });
      statuses.push(res.statusCode);
    }
    expect(imap.failedLogins - before).toBeLessThanOrEqual(10);
    expect(statuses).toContain(429);
  });

  it("stops forwarding wrong passwords for one user over Basic", async () => {
    const before = imap.failedLogins;
    const statuses: number[] = [];
    for (let i = 0; i < 30; i++) {
      const res = await app.inject({
        method: "GET",
        url: "/jmap/session",
        headers: { authorization: basic("dave@test.local", `guess-${i}`) },
      });
      statuses.push(res.statusCode);
    }
    expect(imap.failedLogins - before).toBeLessThanOrEqual(10);
    expect(statuses).toContain(429);
  });

  it("does not tell an unauthenticated caller why the server failed", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/login",
      payload: { username: "x@test.local", password: "y", provider: "__proto__" },
    });
    expect(res.statusCode).toBeLessThan(500);
    expect(res.body).not.toMatch(/Cannot read properties/);
  });
});

// Each case below comes from an address of its own, so the counts of one case
// do not leak into the next.
const loginFrom = (remoteAddress: string, payload: unknown) =>
  app.inject({ method: "POST", url: "/api/login", payload: payload as Record<string, unknown>, remoteAddress });
const failTenTimes = async (remoteAddress: string, username: string) => {
  for (let i = 0; i < 10; i++) {
    expect((await loginFrom(remoteAddress, { username, password: `guess-${i}` })).statusCode).toBe(401);
  }
};

describe("what the login limits hold and what they leave alone", () => {
  it("still forwards a wrong password for another user from the same address", async () => {
    await failTenTimes("10.1.0.1", "carol@test.local");
    const before = imap.failedLogins;
    const res = await loginFrom("10.1.0.1", { username: "dave@test.local", password: "wrong" });
    expect(res.statusCode).toBe(401);
    expect(imap.failedLogins - before).toBe(1);
  });

  it("answers the held login with Retry-After", async () => {
    await failTenTimes("10.1.0.2", "carol@test.local");
    const res = await loginFrom("10.1.0.2", { username: "carol@test.local", password: "wrong" });
    expect(res.statusCode).toBe(429);
    const retryAfter = Number(res.headers["retry-after"]);
    expect(retryAfter).toBeGreaterThan(0);
    expect(retryAfter).toBeLessThanOrEqual(15 * 60);
  });

  it("holds the right password too, without asking the mail server", async () => {
    await failTenTimes("10.1.0.3", "Carol@Test.Local");
    const before = imap.logins;
    const res = await loginFrom("10.1.0.3", { username: "carol@test.local", password: "right-password" });
    expect(res.statusCode).toBe(429);
    expect(imap.logins).toBe(before);
  });

  it("keeps a live session working while its user's login is held", async () => {
    const token = (await loginFrom("10.1.0.4", { username: "carol@test.local", password: "right-password" })).json()
      .token as string;
    await failTenTimes("10.1.0.4", "carol@test.local");
    expect((await loginFrom("10.1.0.4", { username: "carol@test.local", password: "right-password" })).statusCode).toBe(429);
    const res = await app.inject({ method: "GET", url: "/jmap/session", headers: { authorization: `Bearer ${token}` } });
    expect(res.statusCode).toBe(200);
  });

  it("clears a pair's count on a successful login", async () => {
    for (let i = 0; i < 9; i++) await loginFrom("10.1.0.5", { username: "dave@test.local", password: `guess-${i}` });
    expect((await loginFrom("10.1.0.5", { username: "dave@test.local", password: "right-password" })).statusCode).toBe(200);
    for (let i = 0; i < 9; i++) {
      expect((await loginFrom("10.1.0.5", { username: "dave@test.local", password: `again-${i}` })).statusCode).toBe(401);
    }
  });

  it("holds an address after 50 failed logins across user names", async () => {
    for (let i = 0; i < 50; i++) {
      expect((await loginFrom("10.1.0.6", { username: `user${i}@test.local`, password: "wrong" })).statusCode).toBe(401);
    }
    const before = imap.logins;
    const res = await loginFrom("10.1.0.6", { username: "carol@test.local", password: "right-password" });
    expect(res.statusCode).toBe(429);
    expect(imap.logins).toBe(before);
  });

  it("answers a failed login without the mail server's text", async () => {
    const res = await loginFrom("10.1.0.7", { username: "carol@test.local", password: "wrong" });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: "auth failed" });
  });

  it("refuses a body that is not what the route expects, before any login", async () => {
    const before = imap.logins;
    for (const payload of [
      { username: 42, password: "x" },
      { username: ["carol@test.local"], password: "x" },
      { username: "u".repeat(10_000), password: "x" },
      { username: "carol@test.local", password: { $ne: "" } },
      { username: "carol@test.local", password: "x", provider: "toString" },
      { username: "carol@test.local", password: "x", provider: "nope" },
      ["carol@test.local", "x"],
    ]) {
      const res = await loginFrom("10.1.0.8", payload);
      expect(res.statusCode, JSON.stringify(payload).slice(0, 60)).toBe(400);
      expect(res.json()).toEqual({ error: "invalid login request" });
    }
    expect(imap.logins).toBe(before);
  });
});
