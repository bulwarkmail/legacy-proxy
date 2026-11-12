// A check of the stored password that has no answer yet is kept in the
// database: after a restart the proxy still holds the sessions made with other
// passwords, and its attempts go on where they left off instead of starting
// over.

import fs from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { bootProxy } from "./fake-imap.js";
import { startScriptedImap, type LoginAnswer, type ScriptedImap } from "./scripted-imap.js";

const users: Record<string, { valid: string[]; answers?: Record<string, LoginAnswer> }> = {};

let imap: ScriptedImap;
let app: FastifyInstance;
let dir: string;
beforeAll(async () => {
  imap = await startScriptedImap((user, pass) => {
    const u = users[user];
    if (!u) return "no";
    return u.answers?.[pass] ?? (u.valid.includes(pass) ? "ok" : "no");
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

const session = (authorization: string) => app.inject({ method: "GET", url: "/jmap/session", headers: { authorization } });
const tokenOf = async (username: string, password: string) => {
  const res = await app.inject({ method: "POST", url: "/api/login", payload: { username, password } });
  expect(res.statusCode).toBe(200);
  return res.json().token as string;
};
const checksOf = (user: string) => imap.attempts.filter((a) => a.user === user && a.pass === "old" && a.answer !== "ok").length;

describe("a check without an answer across a restart", () => {
  it("keeps holding the old session and goes on with its attempts", async () => {
    users["eli@test.local"] = { valid: ["old"] };
    const old = await tokenOf("eli@test.local", "old");
    users["eli@test.local"] = { valid: ["new"], answers: { old: "unavailable" } };
    const mine = await tokenOf("eli@test.local", "new");
    // Two attempts without an answer (at once and 5 s later); the third is due 30 s after the second.
    expect((await session(`Bearer ${old}`)).statusCode).toBe(503);
    expect(checksOf("eli@test.local")).toBe(2);

    // The proxy restarts with the same data directory and keys.
    await app.close();
    vi.resetModules();
    ({ app } = (await import("../../src/server.js")) as unknown as { app: FastifyInstance });
    await app.ready();

    const res = await session(`Bearer ${old}`);
    expect(res.statusCode).toBe(503);
    expect(Number(res.headers["retry-after"])).toBeGreaterThan(1);
    expect((await session(`Bearer ${mine}`)).statusCode).toBe(200);
    // No attempt at start: the next one keeps its place in the schedule.
    expect(checksOf("eli@test.local")).toBe(2);

    // The server accepts the old password again and the owner signs in with it: both are valid.
    users["eli@test.local"] = { valid: ["old", "new"] };
    await tokenOf("eli@test.local", "old");
    expect((await session(`Bearer ${old}`)).statusCode).toBe(200);
    expect((await session(`Bearer ${mine}`)).statusCode).toBe(200);
  }, 30_000);
});
