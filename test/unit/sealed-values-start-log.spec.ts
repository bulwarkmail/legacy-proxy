// A start that rewrites what earlier versions stored says so in one log line
// per database: how many values of each kind, in which file, and nothing of
// the values or the key. A start that rewrites nothing logs nothing.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Store } from "../../src/state/store.js";
import { GmailStore } from "../../src/gmail/store.js";
import { log } from "../../src/util/log.js";

const ANNA = "anna@gmail.test";
const BEN = "ben@gmail.test";
const cleanup: (() => void)[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const f of cleanup.splice(0).reverse()) f();
});
function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "legacy-proxy-start-log-"));
  cleanup.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function sealTheOldWay(key: Buffer, plain: Buffer): Buffer {
  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, nonce);
  const ct = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([nonce, cipher.getAuthTag(), ct]);
}
const sha256 = (s: string) => crypto.createHash("sha256").update(s).digest("hex");

/** One IMAP account; two Google grants, a cache entry, an upload in clear, a bridge password and a sign-in, all as before. */
function earlierData(key: Buffer) {
  const dir = tempDir();
  const gmail = new Database(path.join(dir, "gmail.sqlite3"));
  gmail.exec(`
    CREATE TABLE gmail_connection (email TEXT PRIMARY KEY, vault BLOB NOT NULL, snapshot TEXT NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE gmail_cache (email TEXT NOT NULL, key TEXT NOT NULL, value BLOB NOT NULL, expires INTEGER NOT NULL, touched INTEGER NOT NULL, size INTEGER NOT NULL, PRIMARY KEY(email, key));
    CREATE TABLE gmail_upload (email TEXT NOT NULL,id TEXT NOT NULL,body BLOB NOT NULL,type TEXT NOT NULL,expires INTEGER NOT NULL,PRIMARY KEY(email,id));
    CREATE TABLE gmail_password (email TEXT PRIMARY KEY, hash TEXT NOT NULL UNIQUE);
    CREATE TABLE gmail_token (hash TEXT PRIMARY KEY, email TEXT NOT NULL, client TEXT NOT NULL, kind TEXT NOT NULL, parent TEXT, expires INTEGER NOT NULL);
  `);
  for (const email of [ANNA, BEN])
    gmail.prepare("INSERT INTO gmail_connection VALUES (?,?,?,?)").run(email, sealTheOldWay(key, Buffer.from(JSON.stringify({ mech: "XOAUTH2", username: email, refreshToken: "fake-refresh" }))), "{}", 1);
  const cached = sealTheOldWay(key, Buffer.from("{}"));
  gmail.prepare("INSERT INTO gmail_cache VALUES (?,?,?,?,?,?)").run(ANNA, "profile", cached, Date.now() + 3600_000, Date.now(), cached.length);
  gmail.prepare("INSERT INTO gmail_upload VALUES (?,?,?,?,?)").run(ANNA, "gu_1", Buffer.from("upload in clear"), "text/plain", Date.now() + 3600_000);
  gmail.prepare("INSERT INTO gmail_password VALUES (?,?)").run(ANNA, sha256("gmap_" + "a".repeat(43)));
  gmail.prepare("INSERT INTO gmail_token VALUES (?,?,?,'refresh',NULL,?)").run(sha256("gmrt_" + "b".repeat(43)), ANNA, "webmail", Date.now() + 86400_000);
  gmail.prepare("INSERT INTO gmail_token VALUES (?,?,?,'access',?,?)").run(sha256("gmat_" + "c".repeat(43)), ANNA, "webmail", sha256("gmrt_" + "b".repeat(43)), Date.now() + 3600_000);
  gmail.close();
  const proxy = new Store(dir);
  proxy.upsertAccount({ slug: "generic:pat@corp.test", kind: "generic", host: "imap.test", username: "pat@corp.test", vault: sealTheOldWay(key, Buffer.from(JSON.stringify({ mech: "PLAIN", username: "pat@corp.test", password: "fake-imap-password" }))) });
  proxy.close();
  return dir;
}

describe("a start that rewrites stored values", () => {
  it("logs one line per database with the counts, and nothing of the values or the key", () => {
    const key = crypto.randomBytes(32);
    const dir = earlierData(key);
    const warn = vi.spyOn(log, "warn").mockImplementation(() => undefined);
    new Store(dir, key).close();
    new GmailStore(dir, key).close();

    expect(warn).toHaveBeenCalledTimes(2);
    const [proxyLine, gmailLine] = warn.mock.calls.map((c) => c as unknown[]);
    expect(proxyLine![0]).toEqual({ file: path.join(dir, "proxy.db"), credentials: 1 });
    expect(gmailLine![0]).toEqual({
      file: path.join(dir, "gmail.sqlite3"),
      credentials: 2,
      uploads: 1,
      cacheEntriesDropped: 1,
      passwordHashes: 1,
      tokenHashes: 2,
    });
    for (const line of [proxyLine, gmailLine]) expect(String(line![1])).toMatch(/earlier version/);
    const logged = JSON.stringify(warn.mock.calls);
    for (const secret of ["fake-imap-password", "fake-refresh", "upload in clear", key.toString("hex"), key.toString("base64")])
      expect(logged).not.toContain(secret);
  });

  it("logs nothing on a later start, nor on a start with nothing to rewrite", () => {
    const key = crypto.randomBytes(32);
    const dir = earlierData(key);
    new Store(dir, key).close();
    new GmailStore(dir, key).close();
    const warn = vi.spyOn(log, "warn").mockImplementation(() => undefined);
    new Store(dir, key).close();
    new GmailStore(dir, key).close();
    const fresh = tempDir();
    new Store(fresh, key).close();
    new GmailStore(fresh, key).close();
    expect(warn).not.toHaveBeenCalled();
  });
});
