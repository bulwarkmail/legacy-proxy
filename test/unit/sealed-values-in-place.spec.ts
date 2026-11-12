// What the proxy seals on disk opens only in the row it was sealed for: the
// Gmail cache, Gmail uploads, the stored Google grant and the IMAP backend's
// stored mail credentials. A value copied into another account's row (or
// another row of the same account) does not open there. Values earlier
// versions sealed are handled at start (sealed-values-at-start.spec.ts).
// proxy.db is readable by its owner only.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GmailStore } from "../../src/gmail/store.js";
import { GmailMail } from "../../src/gmail/mail.js";
import { GMAIL_READONLY } from "../../src/gmail/config.js";
import { Store } from "../../src/state/store.js";
import {
  openAccountCredentials,
  openCredentials,
  seal,
  sealCredentials,
  sealPlace,
  unseal,
  type Credentials,
} from "../../src/auth/credentials.js";

const ANNA = "anna@gmail.test";
const BEN = "ben@gmail.test";
const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const f of cleanup.splice(0).reverse()) f();
  vi.restoreAllMocks();
});

function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "legacy-proxy-sealed-"));
  cleanup.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function gmailStore(dir: string, key: Buffer) {
  const store = new GmailStore(dir, key);
  cleanup.push(() => store.close());
  return store;
}
function proxyStore(dir: string) {
  const store = new Store(dir);
  cleanup.push(() => store.close());
  return store;
}
const grant = (email: string): Credentials => ({
  mech: "XOAUTH2",
  username: email,
  accessToken: "fake-access-" + email,
  refreshToken: "fake-refresh-" + email,
  scopes: [GMAIL_READONLY],
});
async function connect(store: GmailStore, email: string) {
  await store.save(email, grant(email), {
    profile: { emailAddress: email, historyId: "5", messagesTotal: 1, threadsTotal: 1 },
    labels: [],
  });
}
/** Writes into the database file directly, the way a copy of one row into another would. */
function rawDb(dir: string, file = "gmail.sqlite3") {
  const db = new Database(path.join(dir, file));
  cleanup.push(() => db.close());
  return db;
}
describe("a sealed value copied into another row", () => {
  it("Gmail cache: does not open under another account, nor under another key of the same account", async () => {
    const dir = tempDir();
    const store = gmailStore(dir, crypto.randomBytes(32));
    await connect(store, ANNA);
    await connect(store, BEN);
    store.cache(ANNA, "message:v2:a", { subject: "Anna's subject" }, 60_000);
    store.cache(BEN, "message:v2:a", { subject: "Ben's subject" }, 60_000);
    store.cache(BEN, "message:v2:b", { subject: "Ben's other subject" }, 60_000);
    const db = rawDb(dir);
    const annas = (db.prepare("SELECT value FROM gmail_cache WHERE email=? AND key=?").get(ANNA, "message:v2:a") as { value: Buffer }).value;
    db.prepare("UPDATE gmail_cache SET value=? WHERE email=? AND key=?").run(annas, BEN, "message:v2:a");
    const bens = (db.prepare("SELECT value FROM gmail_cache WHERE email=? AND key=?").get(BEN, "message:v2:b") as { value: Buffer }).value;
    db.prepare("INSERT INTO gmail_cache(email,key,value,expires,touched,size) VALUES(?,?,?,?,?,?)").run(BEN, "message:v2:c", bens, Date.now() + 60_000, Date.now(), bens.length);

    expect(store.cached(BEN, "message:v2:a")).toBeNull();
    expect(store.cached(BEN, "message:v2:c")).toBeNull();
    expect(store.cached(ANNA, "message:v2:a")).toEqual({ subject: "Anna's subject" });
    expect(store.cached(BEN, "message:v2:b")).toEqual({ subject: "Ben's other subject" });
  });

  it("Gmail grant: another account's grant copied into a row does not open there", async () => {
    const dir = tempDir();
    const store = gmailStore(dir, crypto.randomBytes(32));
    await connect(store, ANNA);
    await connect(store, BEN);
    const db = rawDb(dir);
    const annas = (db.prepare("SELECT vault FROM gmail_connection WHERE email=?").get(ANNA) as { vault: Buffer }).vault;
    db.prepare("UPDATE gmail_connection SET vault=? WHERE email=?").run(annas, BEN);

    await expect(store.load(BEN)).rejects.toThrow(/VAULT_KEY|moved/);
    expect((await store.load(ANNA))?.credentials.refreshToken).toBe("fake-refresh-" + ANNA);
  });

  it("Gmail upload: another account's upload copied into a row is no upload there, and asking for it fails like an unknown one", async () => {
    const dir = tempDir();
    const store = gmailStore(dir, crypto.randomBytes(32));
    await connect(store, ANNA);
    await connect(store, BEN);
    const annasId = store.upload(ANNA, Buffer.from("Anna's attachment"), "text/plain");
    const bensId = store.upload(BEN, Buffer.from("Ben's attachment"), "text/plain");
    const db = rawDb(dir);
    const annas = (db.prepare("SELECT body FROM gmail_upload WHERE email=? AND id=?").get(ANNA, annasId) as { body: Buffer }).body;
    db.prepare("UPDATE gmail_upload SET body=? WHERE email=? AND id=?").run(annas, BEN, bensId);

    expect(store.uploaded(BEN, bensId)).toBeNull();
    expect(store.uploaded(ANNA, annasId)?.body.toString()).toBe("Anna's attachment");
    const bens = new GmailMail(BEN, {} as never, store);
    await expect(bens.download(bensId)).rejects.toMatchObject({ type: "notFound" });
    await expect(bens.download("gu_never_uploaded")).rejects.toMatchObject({ type: "notFound" });
    expect((await new GmailMail(ANNA, {} as never, store).download(annasId)).body.toString()).toBe("Anna's attachment");
  });

  it("IMAP backend: another account's stored password copied into a row does not open there", async () => {
    const dir = tempDir();
    const key = crypto.randomBytes(32);
    const store = proxyStore(dir);
    const save = async (username: string, password: string) => {
      const slug = `generic:${username}`;
      return store.upsertAccount({
        slug,
        kind: "generic",
        host: "imap.test",
        username,
        vault: await sealCredentials(key, sealPlace.account(slug), { mech: "PLAIN", username, password }),
      });
    };
    const anna = await save("anna@corp.test", "annas-fake-password");
    await save("ben@corp.test", "bens-fake-password");
    store.db.prepare("UPDATE account SET vault=? WHERE slug=?").run(anna.vault, "generic:ben@corp.test");

    const ben = store.getAccount("generic:ben@corp.test")!;
    await expect(openAccountCredentials(key, ben)).rejects.toThrow(/VAULT_KEY|moved/);
    expect((await openAccountCredentials(key, store.getAccount("generic:anna@corp.test")!)).password).toBe("annas-fake-password");
  });

  it("keeps the parts of a place apart whatever characters an address or key holds", () => {
    const key = crypto.randomBytes(32);
    const sealed = seal(key, { table: "gmail_cache", account: "a|b", key: "c" }, Buffer.from("x"));
    expect(() => unseal(key, { table: "gmail_cache", account: "a", key: "b|c" }, sealed)).toThrow();
    const quoted = seal(key, { table: "gmail_cache", account: 'a","b', key: "c" }, Buffer.from("x"));
    expect(() => unseal(key, { table: "gmail_cache", account: "a", key: 'b","c' }, quoted)).toThrow();
    expect(() => unseal(key, { table: "gmail_upload", account: 'a","b', key: "c" }, quoted)).toThrow();
    expect(unseal(key, { table: "gmail_cache", account: 'a","b', key: "c" }, quoted).toString()).toBe("x");
  });

  it("fails with a message that names VAULT_KEY when the key is not the one it was sealed with", async () => {
    const place = sealPlace.gmailConnection(ANNA);
    const sealed = await sealCredentials(crypto.randomBytes(32), place, grant(ANNA));
    await expect(openCredentials(crypto.randomBytes(32), place, sealed)).rejects.toThrow(/VAULT_KEY/);
  });
});

describe("uploads at rest", () => {
  it("are not stored as they came, and come back as they came", async () => {
    const dir = tempDir();
    const store = gmailStore(dir, crypto.randomBytes(32));
    await connect(store, ANNA);
    const text = "Quarterly figures, draft three. ".repeat(8);
    const id = store.upload(ANNA, Buffer.from(text), "text/plain");
    const row = rawDb(dir).prepare("SELECT body FROM gmail_upload WHERE id=?").get(id) as { body: Buffer };
    expect(row.body.toString("latin1")).not.toContain("Quarterly figures");
    expect(store.uploaded(ANNA, id)).toEqual({ body: Buffer.from(text), type: "text/plain" });
  });
});

describe("the upload table", () => {
  it("keeps the shape an earlier version writes to, so a rollback can still store uploads", async () => {
    const dir = tempDir();
    const key = crypto.randomBytes(32);
    const store = gmailStore(dir, key);
    await connect(store, ANNA);
    const id = store.upload(ANNA, Buffer.from("written by this version"), "text/plain");
    const db = rawDb(dir);
    // The earlier version's insert names no columns, and works.
    db.prepare("INSERT INTO gmail_upload VALUES(?,?,?,?,?)").run(ANNA, "gu_rolled_back", Buffer.from("written after a rollback"), "text/plain", Date.now() + 3600_000);
    expect(store.uploaded(ANNA, id)?.body.toString()).toBe("written by this version");
    // Back on this version, an upload the earlier one stored in clear is answered like an unknown one.
    expect(store.uploaded(ANNA, "gu_rolled_back")).toBeNull();
  });
});

describe("proxy.db", () => {
  it("is created for its owner only, and an existing one is narrowed to that", () => {
    const openSync = vi.spyOn(fs, "openSync");
    const chmodSync = vi.spyOn(fs, "chmodSync");
    const dir = tempDir();
    proxyStore(dir);
    const file = path.join(dir, "proxy.db");
    expect(openSync).toHaveBeenCalledWith(file, "a", 0o600);
    expect(chmodSync).toHaveBeenCalledWith(file, 0o600);
    if (process.platform !== "win32") expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });
});
