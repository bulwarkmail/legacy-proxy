// A session token and a cached Basic login belong to the password they were
// made with: once the owner signs in with a new password, the ones made with
// the old password are refused. /api/logout ends the caller's own token.

import fs from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { bootProxy, startFakeImap, type FakeImap } from "./fake-imap.js";

let imap: FakeImap;
let app: FastifyInstance;
let dir: string;
beforeAll(async () => {
  imap = await startFakeImap({ "alice@test.local": "old-password", "erin@test.local": "old-password" });
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
const login = (username: string, password: string) =>
  app.inject({ method: "POST", url: "/api/login", payload: { username, password } });
const session = (authorization: string) =>
  app.inject({ method: "GET", url: "/jmap/session", headers: { authorization } });

describe("sessions end when the password they were made with is replaced", () => {
  it("refuses a token issued for the old password once the owner signed in with the new one", async () => {
    const oldToken = (await login("alice@test.local", "old-password")).json().token as string;
    expect((await session(`Bearer ${oldToken}`)).statusCode).toBe(200);

    imap.users["alice@test.local"] = "new-password";
    const fresh = await login("alice@test.local", "new-password");
    expect(fresh.statusCode).toBe(200);

    expect((await session(`Bearer ${fresh.json().token as string}`)).statusCode).toBe(200);
    expect((await session(`Bearer ${oldToken}`)).statusCode).toBe(401);
  });

  it("refuses a cached Basic header once the owner signed in with the new password", async () => {
    expect((await session(basic("erin@test.local", "old-password"))).statusCode).toBe(200);

    imap.users["erin@test.local"] = "new-password";
    expect((await session(basic("erin@test.local", "new-password"))).statusCode).toBe(200);

    expect((await session(basic("erin@test.local", "old-password"))).statusCode).toBe(401);
  });
});

const tokenOf = async (username: string, password: string) => {
  const res = await login(username, password);
  expect(res.statusCode).toBe(200);
  return res.json().token as string;
};
const logout = (authorization?: string) =>
  app.inject({ method: "POST", url: "/api/logout", headers: authorization ? { authorization } : {} });

describe("what a password change and a sign-out leave working", () => {
  it("keeps two devices signed in with the same password working", async () => {
    imap.users["gina@test.local"] = "same-password";
    const a = await tokenOf("gina@test.local", "same-password");
    const b = await tokenOf("gina@test.local", "same-password");
    expect((await session(`Bearer ${a}`)).statusCode).toBe(200);
    expect((await session(`Bearer ${b}`)).statusCode).toBe(200);
  });

  it("keeps a device's token when it signs in again with the same password", async () => {
    imap.users["hank@test.local"] = "same-password";
    const first = await tokenOf("hank@test.local", "same-password");
    await tokenOf("hank@test.local", "same-password");
    expect((await session(`Bearer ${first}`)).statusCode).toBe(200);
  });

  it("closes the connections logged in with the old password", async () => {
    imap.users["ivy@test.local"] = "old-password";
    await tokenOf("ivy@test.local", "old-password");
    const logouts = () => imap.lines.filter((l) => / LOGOUT$/i.test(l)).length;
    const before = logouts();
    imap.users["ivy@test.local"] = "new-password";
    await tokenOf("ivy@test.local", "new-password");
    // The stored password is checked after the sign-in is answered.
    for (let i = 0; i < 100 && logouts() <= before; i++) await new Promise((r) => setTimeout(r, 20));
    expect(logouts()).toBeGreaterThan(before);
  });

  it("keeps a token issued before generations existed until the password changes", async () => {
    imap.users["jay@test.local"] = "old-password";
    await tokenOf("jay@test.local", "old-password");
    const { signSession } = await import("../../src/auth/session.js");
    const now = Math.floor(Date.now() / 1000);
    const legacy = signSession(Buffer.from(process.env.SESSION_HMAC_KEY!, "base64"), {
      accountSlug: "generic:jay@test.local",
      username: "jay@test.local",
      iat: now,
      exp: now + 3600,
    });
    expect((await session(`Bearer ${legacy}`)).statusCode).toBe(200);

    imap.users["jay@test.local"] = "new-password";
    await tokenOf("jay@test.local", "new-password");
    expect((await session(`Bearer ${legacy}`)).statusCode).toBe(401);
  });

  it("ends the caller's own token on /api/logout and nothing else", async () => {
    imap.users["kim@test.local"] = "pw";
    const mine = await tokenOf("kim@test.local", "pw");
    const other = await tokenOf("kim@test.local", "pw");

    expect((await logout()).statusCode).toBe(401);
    expect((await logout(`Bearer ${mine}`)).statusCode).toBe(204);
    expect((await session(`Bearer ${mine}`)).statusCode).toBe(401);
    expect((await logout(`Bearer ${mine}`)).statusCode).toBe(401);
    expect((await session(`Bearer ${other}`)).statusCode).toBe(200);
  });

  it("answers an old token with 401, without a login, once the server refused the stored password", async () => {
    imap.users["lou@test.local"] = "old-password";
    const token = await tokenOf("lou@test.local", "old-password");
    // The pool and the IDLE worker report refusals of the stored password to the store.
    const { Store } = await import("../../src/state/store.js");
    const other = new Store(dir);
    try {
      const row = other.getAccount("generic:lou@test.local")!;
      for (let i = 0; i < 3; i++) other.noteCredentialRefusal(row.id, row.cred_gen);
    } finally {
      other.close();
    }
    const before = imap.logins;
    expect((await session(`Bearer ${token}`)).statusCode).toBe(401);
    expect(imap.logins).toBe(before);
  });
});
