// Bridge passwords and sign-in tokens are stored as a keyed hash (an HMAC under
// a key derived from the vault key) with a MAC that ties the row to its
// account. Someone who can write the database file but has no vault key can't
// add a password or token that works, can't move their own row to another
// account, and can't push a sign-in's end out. Passwords and sign-ins from
// before keep working across the upgrade.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { GmailStore } from "../../src/gmail/store.js";
import { GMAIL_READONLY } from "../../src/gmail/config.js";

const ANNA = "anna@gmail.test";
const BEN = "ben@gmail.test";
const DAY = 86400_000;
const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const f of cleanup.splice(0).reverse()) f();
});
function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "legacy-proxy-secret-hashes-"));
  cleanup.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
const sha256 = (s: string) => crypto.createHash("sha256").update(s).digest("hex");
const madeUp = (prefix: string) => prefix + crypto.randomBytes(32).toString("base64url");
function raw(dir: string) {
  const db = new Database(path.join(dir, "gmail.sqlite3"));
  cleanup.push(() => db.close());
  return db;
}
async function bridge() {
  const dir = tempDir();
  const key = crypto.randomBytes(32);
  const store = new GmailStore(dir, key);
  cleanup.push(() => store.close());
  for (const email of [ANNA, BEN])
    await store.save(
      email,
      { mech: "XOAUTH2", username: email, refreshToken: "fake-refresh", scopes: [GMAIL_READONLY] },
      { profile: { emailAddress: email, historyId: "5", messagesTotal: 1, threadsTotal: 1 }, labels: [] },
    );
  return { dir, key, store };
}

describe("someone who can write the database file, without the vault key", () => {
  it("can't add a bridge password or a sign-in token for an account", async () => {
    const { dir, store } = await bridge();
    const password = madeUp("gmap_");
    const access = madeUp("gmat_");
    const refresh = madeUp("gmrt_");
    const db = raw(dir);
    db.prepare("INSERT INTO gmail_password(email,hash) VALUES (?,?)").run(BEN, sha256(password));
    const far = Date.now() + 100 * DAY;
    db.prepare("INSERT INTO gmail_token(hash,email,client,kind,parent,expires,family,family_since) VALUES (?,?,?,?,?,?,?,?)").run(sha256(access), BEN, "webmail", "access", null, far, "f", Date.now());
    db.prepare("INSERT INTO gmail_token(hash,email,client,kind,parent,expires,family,family_since) VALUES (?,?,?,?,?,?,?,?)").run(sha256(refresh), BEN, "webmail", "refresh", null, far, "f", Date.now());

    expect(store.authenticate(password, BEN)).toBeNull();
    expect(store.authenticate(password)).toBeNull();
    expect(store.authenticateToken(access)).toBeNull();
    expect(store.refreshTokens(refresh, "webmail")).toBeNull();
  });

  it("can't move their own password or token to another account", async () => {
    const { dir, store } = await bridge();
    const annasPassword = store.issuePassword(ANNA);
    const annasTokens = store.issueTokens(ANNA, "webmail");
    const db = raw(dir);
    db.prepare("DELETE FROM gmail_password WHERE email=?").run(BEN);
    db.prepare("UPDATE gmail_password SET email=? WHERE email=?").run(BEN, ANNA);
    db.prepare("UPDATE gmail_token SET email=? WHERE email=?").run(BEN, ANNA);

    expect(store.authenticate(annasPassword, BEN)).toBeNull();
    expect(store.authenticate(annasPassword)).toBeNull();
    expect(store.authenticateToken(annasTokens.accessToken)).toBeNull();
    expect(store.refreshTokens(annasTokens.refreshToken, "webmail")).toBeNull();
  });

  it("can't move the end of their own sign-in", async () => {
    const { dir, store } = await bridge();
    const t0 = Date.now();
    const tokens = store.issueTokens(ANNA, "webmail", t0);
    raw(dir).prepare("UPDATE gmail_token SET family_since=?, expires=? WHERE email=?").run(t0 + 10 * 365 * DAY, t0 + 10 * 365 * DAY, ANNA);
    expect(store.authenticateToken(tokens.accessToken, t0 + 1000)).toBeNull();
    expect(store.refreshTokens(tokens.refreshToken, "webmail", t0 + 1000)).toBeNull();
  });

  it("finds no plain SHA-256 of a secret in the file", async () => {
    const { dir, store } = await bridge();
    const password = store.issuePassword(ANNA);
    const tokens = store.issueTokens(ANNA, "webmail");
    const db = raw(dir);
    const hashes = [
      ...(db.prepare("SELECT hash FROM gmail_password").all() as { hash: string }[]),
      ...(db.prepare("SELECT hash FROM gmail_token").all() as { hash: string }[]),
    ].map((r) => r.hash);
    for (const secret of [password, tokens.accessToken, tokens.refreshToken]) expect(hashes).not.toContain(sha256(secret));
    // And they still work for the right account.
    expect(store.authenticate(password, ANNA)).toBe(ANNA);
    expect(store.authenticateToken(tokens.accessToken)).toBe(ANNA);
  });
});

describe("bridge passwords and sign-ins stored by earlier versions", () => {
  it("keep working after the upgrade, and a second start leaves them as they are", () => {
    const dir = tempDir();
    const key = crypto.randomBytes(32);
    const password = madeUp("gmap_");
    const refresh = madeUp("gmrt_");
    const access = madeUp("gmat_");
    // Tables and values as the bridge wrote them before: grant sealed with the key itself, plain SHA-256 hashes.
    const old = new Database(path.join(dir, "gmail.sqlite3"));
    old.exec(`
      CREATE TABLE gmail_connection (email TEXT PRIMARY KEY, vault BLOB NOT NULL, snapshot TEXT NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE gmail_password (email TEXT PRIMARY KEY, hash TEXT NOT NULL UNIQUE);
      CREATE TABLE gmail_token (hash TEXT PRIMARY KEY, email TEXT NOT NULL, client TEXT NOT NULL, kind TEXT NOT NULL, parent TEXT, expires INTEGER NOT NULL);
    `);
    const nonce = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", key, nonce);
    const ct = Buffer.concat([cipher.update(JSON.stringify({ mech: "XOAUTH2", username: ANNA, refreshToken: "fake-refresh" })), cipher.final()]);
    old.prepare("INSERT INTO gmail_connection VALUES (?,?,?,?)").run(ANNA, Buffer.concat([nonce, cipher.getAuthTag(), ct]), "{}", 1);
    old.prepare("INSERT INTO gmail_password VALUES (?,?)").run(ANNA, sha256(password));
    old.prepare("INSERT INTO gmail_token VALUES (?,?,?,'refresh',NULL,?)").run(sha256(refresh), ANNA, "webmail", Date.now() + 100 * DAY);
    old.prepare("INSERT INTO gmail_token VALUES (?,?,?,'access',?,?)").run(sha256(access), ANNA, "webmail", sha256(refresh), Date.now() + 3600_000);
    old.close();

    const first = new GmailStore(dir, key);
    expect(first.authenticate(password, ANNA)).toBe(ANNA);
    expect(first.authenticate(password)).toBe(ANNA);
    expect(first.authenticateToken(access)).toBe(ANNA);
    first.close();
    const rows = () => {
      const db = new Database(path.join(dir, "gmail.sqlite3"), { readonly: true });
      const out = [db.prepare("SELECT * FROM gmail_password").all(), db.prepare("SELECT * FROM gmail_token ORDER BY hash").all()];
      db.close();
      return out;
    };
    const afterFirst = rows();
    const second = new GmailStore(dir, key);
    cleanup.push(() => second.close());
    expect(rows()).toEqual(afterFirst);
    expect(second.authenticate(password, ANNA)).toBe(ANNA);
    expect(second.authenticateToken(access)).toBe(ANNA);
    const next = second.refreshTokens(refresh, "webmail");
    expect(next).not.toBeNull();
    expect(second.authenticateToken(next!.accessToken)).toBe(ANNA);
    // Revoking the new refresh token ends the whole sign-in, the old access token included.
    second.revokeToken(next!.refreshToken, "webmail");
    expect(second.authenticateToken(access)).toBeNull();
  });
});
