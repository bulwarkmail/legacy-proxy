// Two devices of one account with two passwords the server both accepts (one
// app password per device). A sign-in with a password other than the stored
// one makes the proxy try the stored one once; while the server accepts it,
// nothing moves: no session ends, the stored password stays the first one,
// and each device's Basic header is cached like any other. Only when the
// server refuses the stored password did the offered one replace it.

import fs from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { bootProxy, startFakeImap, type FakeImap } from "./fake-imap.js";
import { openAccountCredentials } from "../../src/auth/credentials.js";

let imap: FakeImap;
let app: FastifyInstance;
let dir: string;
beforeAll(async () => {
  imap = await startFakeImap({});
  ({ app, dir } = await bootProxy(imap));
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
/** Wait until `done()` holds, for things that happen after a sign-in is answered. */
async function until(done: () => boolean | Promise<boolean>) {
  for (let i = 0; i < 100 && !(await done()); i++) await new Promise((r) => setTimeout(r, 20));
}
async function storedPassword(username: string) {
  const { Store } = await import("../../src/state/store.js");
  const store = new Store(dir);
  try {
    const row = store.getAccount(`generic:${username}`)!;
    return (await openAccountCredentials(Buffer.from(process.env.VAULT_KEY!, "base64"), row)).password;
  } finally {
    store.close();
  }
}

describe("two app passwords on two devices", () => {
  it("logs in once per device plus one check of the stored password, for twelve Basic requests", async () => {
    imap.users["vic@test.local"] = ["app-password-1", "app-password-2"];
    const before = imap.logins;
    for (let i = 0; i < 6; i++) {
      for (const pass of ["app-password-1", "app-password-2"]) {
        expect((await session(basic("vic@test.local", pass))).statusCode).toBe(200);
      }
    }
    await until(() => imap.logins - before >= 3);
    expect(imap.logins - before).toBeLessThanOrEqual(3);
    expect(await storedPassword("vic@test.local")).toBe("app-password-1");
  });

  it("costs each device one login per cache lifetime, without checking the stored password again", async () => {
    imap.users["ada@test.local"] = ["app-password-1", "app-password-2"];
    const start = Date.now();
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(start);
      for (const pass of ["app-password-1", "app-password-2"]) {
        expect((await session(basic("ada@test.local", pass))).statusCode).toBe(200);
      }
      const firstRound = imap.logins;
      await until(() => imap.logins >= firstRound + 1);
      // Each cached header lapses after five minutes; both devices sign in again.
      for (let round = 1; round <= 3; round++) {
        vi.setSystemTime(start + round * 6 * 60_000);
        const before = imap.logins;
        for (const pass of ["app-password-1", "app-password-2"]) {
          expect((await session(basic("ada@test.local", pass))).statusCode).toBe(200);
        }
        await new Promise((r) => setTimeout(r, 100));
        expect(imap.logins - before, `round ${round}`).toBe(2);
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the first device's sessions when the second signs in with its own password", async () => {
    imap.users["wen@test.local"] = ["app-password-1", "app-password-2"];
    const first = await tokenOf("wen@test.local", "app-password-1");
    const before = imap.logins;
    await tokenOf("wen@test.local", "app-password-2");
    await until(() => imap.logins - before >= 2);
    expect((await session(`Bearer ${first}`)).statusCode).toBe(200);
  });

  it("gives every session made with the new password the same fate, whatever the stored one's", async () => {
    // Accepted: both passwords stay valid.
    imap.users["kai@test.local"] = ["old-password", "new-password"];
    const keptOld = await tokenOf("kai@test.local", "old-password");
    const keptA = await tokenOf("kai@test.local", "new-password");
    const keptB = await tokenOf("kai@test.local", "new-password");
    // Refused: the new password replaced the old one.
    imap.users["lea@test.local"] = "old-password";
    const endedOld = await tokenOf("lea@test.local", "old-password");
    imap.users["lea@test.local"] = "new-password";
    const replacedA = await tokenOf("lea@test.local", "new-password");
    const replacedB = await tokenOf("lea@test.local", "new-password");
    await until(async () => (await session(`Bearer ${endedOld}`)).statusCode === 401);

    expect((await session(`Bearer ${endedOld}`)).statusCode).toBe(401);
    expect((await session(`Bearer ${keptOld}`)).statusCode).toBe(200);
    // The sessions of the new password answer alike in both cases.
    for (const t of [keptA, keptB, replacedA, replacedB]) expect((await session(`Bearer ${t}`)).statusCode).toBe(200);
    expect(await storedPassword("lea@test.local")).toBe("new-password");
    expect(await storedPassword("kai@test.local")).toBe("old-password");
  });
});
