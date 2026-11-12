// While the proxy checks an account's stored password after a sign-in with a
// new one, only sessions made with the new password are served. Everything
// else waits for the answer or is told to come back (503 with Retry-After),
// and an answer that only says "try again later" is never taken for a
// refusal of the stored password.

import fs from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { bootProxy } from "./fake-imap.js";
import { startScriptedImap, type LoginAnswer, type ScriptedImap } from "./scripted-imap.js";
import { openCredentials } from "../../src/auth/credentials.js";

/** Per user: the passwords the server accepts, and answers that replace the default for one password. */
const users: Record<string, { valid: string[]; answers?: Record<string, () => LoginAnswer | Promise<LoginAnswer>> }> = {};

let imap: ScriptedImap;
let app: FastifyInstance;
let dir: string;
beforeAll(async () => {
  imap = await startScriptedImap(async (user, pass) => {
    const u = users[user];
    if (!u) return "no";
    const answer = u.answers?.[pass];
    if (answer) return answer();
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

/** Logins the test answers itself, later. */
function heldLogins() {
  let waiting: Array<(a: LoginAnswer) => void> = [];
  return {
    next: () => new Promise<LoginAnswer>((resolve) => waiting.push(resolve)),
    get count() {
      return waiting.length;
    },
    answer(a: LoginAnswer) {
      const w = waiting;
      waiting = [];
      for (const resolve of w) resolve(a);
    },
  };
}

const basic = (user: string, pass: string) => "Basic " + Buffer.from(`${user}:${pass}`).toString("base64");
const session = (authorization: string) => app.inject({ method: "GET", url: "/jmap/session", headers: { authorization } });
const signIn = (username: string, password: string) =>
  app.inject({ method: "POST", url: "/api/login", payload: { username, password } });
const tokenOf = async (username: string, password: string) => {
  const res = await signIn(username, password);
  expect(res.statusCode).toBe(200);
  return res.json() as { token: string; accountId: string };
};
const mailboxes = (token: string, accountId: string) =>
  app.inject({
    method: "POST",
    url: "/jmap",
    headers: { authorization: `Bearer ${token}` },
    payload: { using: ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail"], methodCalls: [["Mailbox/get", { accountId }, "0"]] },
  });
async function until(done: () => boolean) {
  for (let i = 0; i < 200 && !done(); i++) await new Promise((r) => setTimeout(r, 25));
}
async function row(username: string) {
  const { Store } = await import("../../src/state/store.js");
  const store = new Store(dir);
  try {
    const r = store.getAccount(`generic:${username}`)!;
    const key = Buffer.from(process.env.VAULT_KEY!, "base64");
    return {
      gen: r.cred_gen,
      checkOpen: !!r.cred_check_tag,
      stored: (await openCredentials(key, r.cred_check_vault ?? r.vault)).password,
    };
  } finally {
    store.close();
  }
}

describe("while the stored password is being checked", () => {
  it("serves the owner's new session at once and holds the old one until the answer", async () => {
    const held = heldLogins();
    users["ann@test.local"] = { valid: ["old"] };
    const old = await tokenOf("ann@test.local", "old");
    expect((await session(basic("ann@test.local", "old"))).statusCode).toBe(200);

    users["ann@test.local"] = { valid: ["new"], answers: { old: () => held.next() } };
    const mine = await tokenOf("ann@test.local", "new");
    await until(() => held.count === 1);
    // The check's login is open at the server; the owner's session works.
    expect((await session(`Bearer ${mine.token}`)).statusCode).toBe(200);
    expect((await session(basic("ann@test.local", "new"))).statusCode).toBe(200);
    expect((await mailboxes(mine.token, mine.accountId)).statusCode).toBe(200);
    expect(held.count).toBe(1);

    // The old session and Basic header wait for the answer, then end with it.
    const oldBearer = session(`Bearer ${old.token}`);
    const oldBasic = session(basic("ann@test.local", "old"));
    users["ann@test.local"].answers = {};
    held.answer("no");
    expect((await oldBearer).statusCode).toBe(401);
    expect((await oldBasic).statusCode).toBe(401);
    expect((await session(`Bearer ${mine.token}`)).statusCode).toBe(200);
    expect(await row("ann@test.local")).toMatchObject({ gen: 1, checkOpen: false, stored: "new" });
  });

  it("never takes 'try again later' or a dropped connection for a refusal of the stored password", async () => {
    const answers: LoginAnswer[] = ["drop", "contactadmin"];
    users["bea@test.local"] = { valid: ["old"] };
    const old = await tokenOf("bea@test.local", "old");
    users["bea@test.local"] = { valid: ["new", "third"], answers: { old: () => answers.shift() ?? "contactadmin" } };
    const mine = await tokenOf("bea@test.local", "new");

    // The old session waits for the second attempt, which gets no answer either: 503, come back later.
    const res = await session(`Bearer ${old.token}`);
    expect(res.statusCode).toBe(503);
    expect(Number(res.headers["retry-after"])).toBeGreaterThanOrEqual(1);
    const checks = imap.attempts.filter((a) => a.user === "bea@test.local" && a.pass === "old" && a.answer !== "ok");
    expect(checks.map((a) => a.answer)).toEqual(["drop", "contactadmin"]);
    // Nothing moved: the stored password is still the old one, and the check stays open.
    expect(await row("bea@test.local")).toMatchObject({ gen: 0, checkOpen: true, stored: "old" });
    expect((await session(`Bearer ${mine.token}`)).statusCode).toBe(200);

    // A sign-in with yet another password the server accepts waits too.
    const third = await signIn("bea@test.local", "third");
    expect(third.statusCode).toBe(503);
    expect(third.headers["retry-after"]).toBeDefined();

    // A sign-in with the stored password is the answer: both are valid.
    users["bea@test.local"].answers = {};
    users["bea@test.local"].valid = ["old", "new", "third"];
    await tokenOf("bea@test.local", "old");
    expect((await session(`Bearer ${old.token}`)).statusCode).toBe(200);
    expect((await session(`Bearer ${mine.token}`)).statusCode).toBe(200);
    expect(await row("bea@test.local")).toMatchObject({ gen: 0, checkOpen: false, stored: "old" });
  }, 30_000);

  it("tells the caller with the new password nothing about the answer", async () => {
    /** What the caller who signs in with the new password sees, before and after the answer. */
    async function seenByCaller(user: string, answer: LoginAnswer) {
      const held = heldLogins();
      users[user] = { valid: ["old"] };
      await tokenOf(user, "old");
      users[user] = { valid: answer === "ok" ? ["old", "new"] : ["new"], answers: { old: () => held.next() } };
      const res = await signIn(user, "new");
      const signedIn = { status: res.statusCode, keys: Object.keys(res.json()).sort(), checkWasOpen: false };
      await until(() => held.count === 1);
      signedIn.checkWasOpen = held.count === 1;
      const { token, accountId } = res.json() as { token: string; accountId: string };
      const during = [
        (await session(`Bearer ${token}`)).statusCode,
        (await session(basic(user, "new"))).statusCode,
        (await mailboxes(token, accountId)).statusCode,
      ];
      held.answer(answer);
      await until(() => imap.attempts.some((a) => a.user === user && a.pass === "old" && a.answer === answer));
      const after = [
        (await session(`Bearer ${token}`)).statusCode,
        (await session(basic(user, "new"))).statusCode,
        (await mailboxes(token, accountId)).statusCode,
      ];
      return { signedIn, during, after };
    }
    const accepted = await seenByCaller("cal@test.local", "ok");
    const refused = await seenByCaller("dan@test.local", "no");
    expect(accepted).toEqual({
      signedIn: { status: 200, keys: ["accountId", "apiUrl", "token"], checkWasOpen: true },
      during: [200, 200, 200],
      after: [200, 200, 200],
    });
    expect(refused).toEqual(accepted);
  });
});
