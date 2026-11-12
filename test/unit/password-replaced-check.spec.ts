// The password changes at the mail server and the owner signs in with the new
// one. The proxy then checks the stored password; a session and a Basic header
// made with the old password are not served until the check has its answer,
// and end with it: when the check is slow, and when its first attempt gets no
// answer and a later one does.

import fs from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { bootProxy } from "./fake-imap.js";
import { startScriptedImap, type LoginAnswer, type ScriptedImap } from "./scripted-imap.js";

interface UserScript {
  valid: string[];
  /** Answer for one password instead of the default. */
  special?: Record<string, { answer: LoginAnswer; delayMs?: number }>;
}
const users: Record<string, UserScript> = {};

let imap: ScriptedImap;
let app: FastifyInstance;
let dir: string;
beforeAll(async () => {
  imap = await startScriptedImap(async (user, pass) => {
    const u = users[user];
    if (!u) return "no";
    const s = u.special?.[pass];
    if (s) {
      if (s.delayMs) await new Promise((r) => setTimeout(r, s.delayMs));
      return s.answer;
    }
    return u.valid.includes(pass) ? "ok" : "no";
  });
  ({ app, dir } = await bootProxy(imap as never));
}, 60_000);
afterAll(async () => {
  await app.close();
  await imap.close();
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* left for the OS temp cleanup */
  }
});

const basic = (user: string, pass: string) => "Basic " + Buffer.from(`${user}:${pass}`).toString("base64");
const session = (authorization: string) => app.inject({ method: "GET", url: "/jmap/session", headers: { authorization } });
const tokenOf = async (username: string, password: string) => {
  const res = await app.inject({ method: "POST", url: "/api/login", payload: { username, password } });
  expect(res.statusCode).toBe(200);
  return res.json().token as string;
};
/** Logins with `pass` the server did not accept: the checks of a replaced password. */
const checksOf = (user: string, pass: string) =>
  imap.attempts.filter((a) => a.user === user && a.pass === pass && a.answer !== "ok").length;

describe("the owner signs in with the new password", () => {
  it("over /api/login: the old session's very next request is refused", async () => {
    users["ana@test.local"] = { valid: ["old"] };
    const old = await tokenOf("ana@test.local", "old");
    users["ana@test.local"] = { valid: ["new"] };
    const mine = await tokenOf("ana@test.local", "new");
    const t0 = Date.now();
    expect((await session(`Bearer ${old}`)).statusCode).toBe(401);
    expect(Date.now() - t0).toBeLessThan(10_000);
    expect((await session(`Bearer ${mine}`)).statusCode).toBe(200);
  });

  it("over Basic: the old session and the old Basic header are refused on the very next request", async () => {
    users["ben@test.local"] = { valid: ["old"] };
    const old = await tokenOf("ben@test.local", "old");
    expect((await session(basic("ben@test.local", "old"))).statusCode).toBe(200);
    users["ben@test.local"] = { valid: ["new"] };
    expect((await session(basic("ben@test.local", "new"))).statusCode).toBe(200);
    expect((await session(`Bearer ${old}`)).statusCode).toBe(401);
    expect((await session(basic("ben@test.local", "old"))).statusCode).toBe(401);
    expect((await session(basic("ben@test.local", "new"))).statusCode).toBe(200);
  });

  it("does not serve the old session while a slow check of the stored password runs", async () => {
    users["cid@test.local"] = { valid: ["old"] };
    const old = await tokenOf("cid@test.local", "old");
    // The server takes 12 s to refuse the replaced password (a slow login, or a wait for a login slot).
    users["cid@test.local"] = { valid: ["new"], special: { old: { answer: "no", delayMs: 12_000 } } };
    await tokenOf("cid@test.local", "new");
    const res = await session(`Bearer ${old}`);
    expect(res.statusCode).toBe(401);
  }, 40_000);

  it("ends the old session soon also when the check gets no answer the first time", async () => {
    users["dee@test.local"] = { valid: ["old"] };
    const old = await tokenOf("dee@test.local", "old");
    // The replaced password: the server says "try again later" once, then refuses it.
    let first = true;
    users["dee@test.local"] = { valid: ["new"] };
    imap.decide = ((orig) => async (user: string, pass: string) => {
      if (user === "dee@test.local" && pass === "old") {
        if (first) {
          first = false;
          return "unavailable";
        }
        return "no";
      }
      return orig(user, pass);
    })(imap.decide);
    await tokenOf("dee@test.local", "new");
    let status = 200;
    for (let i = 0; i < 15 && status === 200; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      status = (await session(`Bearer ${old}`)).statusCode;
    }
    // One check that got "try again later", then a second one that gets the refusal.
    const checks = checksOf("dee@test.local", "old");
    expect({ status, checks }).toEqual({ status: 401, checks: 2 });
  }, 40_000);
});
