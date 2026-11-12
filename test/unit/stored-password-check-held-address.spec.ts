// The attempts of a check of the stored password are the proxy's own logins.
// Someone who knows one valid password of the account (a second app password)
// signs in with it and, once the first attempt went unanswered (here: the
// server says "try again later" once), holds their own address with wrong
// logins for other names. The check still asks the server again: the stored
// password is accepted, goes back into the row, and the owner is served.

import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { bootProxy } from "./fake-imap.js";
import { startScriptedImap, type ScriptedImap } from "./scripted-imap.js";
import { openCredentials } from "../../src/auth/credentials.js";

let unavailableOnce = false;
let imap: ScriptedImap;
let app: FastifyInstance;
let dir: string;
beforeAll(async () => {
  imap = await startScriptedImap((user, pass) => {
    if (user !== "quin@test.local") return "no";
    if (pass === "owner-password") {
      if (unavailableOnce) {
        unavailableOnce = false;
        return "unavailable";
      }
      return "ok";
    }
    return pass === "second-app-password" ? "ok" : "no";
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

const login = (username: string, password: string, remoteAddress: string) =>
  app.inject({ method: "POST", url: "/api/login", payload: { username, password }, remoteAddress });

describe("a check opened by someone with one valid password", () => {
  it("still asks the server, and the owner is served again, when that client's address is held", async () => {
    const owner = (await login("quin@test.local", "owner-password", "192.0.2.30")).json().token as string;
    unavailableOnce = true;
    expect((await login("quin@test.local", "second-app-password", "10.30.0.1")).statusCode).toBe(200);
    await new Promise((r) => setTimeout(r, 300));
    // Their own address held: 50 wrong logins for names that don't exist.
    for (let i = 0; i < 50; i++) await login(`nobody${i}@test.local`, "x", "10.30.0.1");
    // The retries at 5 s and 35 s.
    await new Promise((r) => setTimeout(r, 37_000));
    const db = new Database(path.join(dir, "proxy.db"), { readonly: true });
    let row: { vault: Buffer; cred_check_tag: string | null };
    try {
      row = db.prepare("SELECT vault, cred_check_tag FROM account WHERE slug = ?").get("generic:quin@test.local") as typeof row;
    } finally {
      db.close();
    }
    const inRow = (await openCredentials(Buffer.from(process.env.VAULT_KEY!, "base64"), row.vault)).password;
    const ownerStatus = (await app.inject({ method: "GET", url: "/jmap/session", headers: { authorization: `Bearer ${owner}` }, remoteAddress: "192.0.2.30" })).statusCode;
    expect({ open: row.cred_check_tag !== null, inRow, ownerStatus }).toEqual({ open: false, inRow: "owner-password", ownerStatus: 200 });
  }, 60_000);
});
