// When the proxy opens its databases with the vault key, the first start of
// this version seals the values earlier versions sealed with the key itself
// again for their row, drops cache entries in the earlier format and seals
// uploads stored before uploads were sealed, all in one transaction. After
// that a value in the earlier format opens nowhere, and a later start changes
// nothing. A key that opens none of the stored values is refused before any
// row is changed.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { GmailStore } from "../../src/gmail/store.js";
import { Store } from "../../src/state/store.js";
import { GMAIL_READONLY } from "../../src/gmail/config.js";
import { openAccountCredentials, openCredentials, sealPlace, unseal, type Credentials } from "../../src/auth/credentials.js";

const ANNA = "anna@gmail.test";
const BEN = "ben@gmail.test";
const SLUG = "generic:pat@corp.test";
const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const f of cleanup.splice(0).reverse()) f();
});

function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "legacy-proxy-sealed-start-"));
  cleanup.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function sealTheOldWay(key: Buffer, plain: Buffer): Buffer {
  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, nonce);
  const ct = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([nonce, cipher.getAuthTag(), ct]);
}
function opensTheOldWay(key: Buffer, sealed: Buffer): boolean {
  try {
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, sealed.subarray(0, 12));
    decipher.setAuthTag(sealed.subarray(12, 28));
    Buffer.concat([decipher.update(sealed.subarray(28)), decipher.final()]);
    return true;
  } catch {
    return false;
  }
}
const grant = (email: string): Credentials => ({
  mech: "XOAUTH2",
  username: email,
  accessToken: "fake-access-" + email,
  refreshToken: "fake-refresh-" + email,
  scopes: [GMAIL_READONLY],
});
const imapCreds: Credentials = { mech: "PLAIN", username: "pat@corp.test", password: "fake-imap-password" };
const snapshot = (email: string) =>
  JSON.stringify({ profile: { emailAddress: email, historyId: "5", messagesTotal: 1, threadsTotal: 1 }, labels: [] });

/** A data directory as versions before this one left it: everything sealed with the vault key itself, uploads in clear. */
function earlierVersionData(key: Buffer) {
  const dir = tempDir();
  const gmail = new Database(path.join(dir, "gmail.sqlite3"));
  gmail.exec(`
    CREATE TABLE gmail_connection (email TEXT PRIMARY KEY, vault BLOB NOT NULL, snapshot TEXT NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE gmail_cache (
      email TEXT NOT NULL, key TEXT NOT NULL, value BLOB NOT NULL,
      expires INTEGER NOT NULL, touched INTEGER NOT NULL, size INTEGER NOT NULL, PRIMARY KEY(email, key)
    );
    CREATE TABLE gmail_upload (email TEXT NOT NULL,id TEXT NOT NULL,body BLOB NOT NULL,type TEXT NOT NULL,expires INTEGER NOT NULL,PRIMARY KEY(email,id));
    CREATE TABLE gmail_password (email TEXT PRIMARY KEY, hash TEXT NOT NULL UNIQUE);
    CREATE TABLE gmail_token (hash TEXT PRIMARY KEY, email TEXT NOT NULL, client TEXT NOT NULL, kind TEXT NOT NULL, parent TEXT, expires INTEGER NOT NULL);
  `);
  for (const email of [ANNA, BEN])
    gmail.prepare("INSERT INTO gmail_connection VALUES (?,?,?,?)").run(email, sealTheOldWay(key, Buffer.from(JSON.stringify(grant(email)))), snapshot(email), 1);
  const cached = sealTheOldWay(key, Buffer.from(JSON.stringify({ subject: "Cached before" })));
  gmail.prepare("INSERT INTO gmail_cache VALUES (?,?,?,?,?,?)").run(ANNA, "meta:v2:x", cached, Date.now() + 3600_000, Date.now(), cached.length);
  gmail.prepare("INSERT INTO gmail_upload VALUES (?,?,?,?,?)").run(ANNA, "gu_before", Buffer.from("Uploaded before the upgrade"), "text/plain", Date.now() + 3600_000);
  gmail.prepare("INSERT INTO gmail_token VALUES (?,?,?,'refresh',NULL,?)").run("a".repeat(64), ANNA, "webmail", Date.now() + 86400_000);
  gmail.close();
  const proxy = new Store(dir); // no key: tables only, as before
  proxy.upsertAccount({ slug: SLUG, kind: "generic", host: "imap.test", username: "pat@corp.test", vault: sealTheOldWay(key, Buffer.from(JSON.stringify(imapCreds))) });
  if (proxy.db.prepare("SELECT 1 FROM sqlite_master WHERE name='vault_check'").get()) proxy.db.prepare("DELETE FROM vault_check").run();
  proxy.close();
  return dir;
}

/** Every row of the tables that hold sealed values or tokens, in the columns earlier versions had. */
function dump(dir: string) {
  const out: Record<string, unknown[]> = {};
  const gmail = new Database(path.join(dir, "gmail.sqlite3"), { readonly: true });
  for (const [table, columns] of [
    ["gmail_connection", "email, vault, snapshot, updated_at"],
    ["gmail_cache", "email, key, value, expires, touched, size"],
    ["gmail_upload", "email, id, body, type, expires"],
    ["gmail_token", "hash, email, client, kind, parent, expires"],
  ] as const)
    out[table] = gmail.prepare(`SELECT ${columns} FROM ${table} ORDER BY 1, 2`).all();
  const hasCheck = gmail.prepare("SELECT 1 FROM sqlite_master WHERE name='vault_check'").get();
  out.gmail_check = hasCheck ? gmail.prepare("SELECT value FROM vault_check").all() : [];
  const tokenColumns = (gmail.prepare("PRAGMA table_info(gmail_token)").all() as { name: string }[]).map((c) => c.name);
  out.token_family = tokenColumns.includes("family_since")
    ? gmail.prepare("SELECT hash, family, family_since FROM gmail_token WHERE family IS NOT NULL OR family_since IS NOT NULL").all()
    : [];
  gmail.close();
  const proxy = new Database(path.join(dir, "proxy.db"), { readonly: true });
  out.account = proxy.prepare("SELECT id, slug, vault FROM account ORDER BY id").all();
  out.proxy_check = proxy.prepare("SELECT 1 FROM sqlite_master WHERE name='vault_check'").get() ? proxy.prepare("SELECT value FROM vault_check").all() : [];
  proxy.close();
  return out;
}
const vaultOf = (dir: string, email: string) => {
  const db = new Database(path.join(dir, "gmail.sqlite3"), { readonly: true });
  const v = (db.prepare("SELECT vault FROM gmail_connection WHERE email=?").get(email) as { vault: Buffer }).vault;
  db.close();
  return v;
};

describe("the first start of this version", () => {
  it("seals earlier values again for their row, drops old cache entries and seals old uploads", async () => {
    const key = crypto.randomBytes(32);
    const dir = earlierVersionData(key);

    const proxy = new Store(dir, key);
    cleanup.push(() => proxy.close());
    const gmail = new GmailStore(dir, key);
    cleanup.push(() => gmail.close());

    // The user stays signed in: credentials and grant open.
    expect((await openAccountCredentials(key, proxy.getAccount(SLUG)!)).password).toBe("fake-imap-password");
    expect((await gmail.load(ANNA))?.credentials.refreshToken).toBe("fake-refresh-" + ANNA);
    // And they are in the current form now, bound to their row.
    const raw = new Database(path.join(dir, "gmail.sqlite3"), { readonly: true });
    cleanup.push(() => raw.close());
    expect(opensTheOldWay(key, proxy.getAccount(SLUG)!.vault)).toBe(false);
    expect(opensTheOldWay(key, vaultOf(dir, ANNA))).toBe(false);
    expect((await openCredentials(key, sealPlace.gmailConnection(BEN), vaultOf(dir, BEN))).username).toBe(BEN);
    // The cache entry in the earlier format is gone; it is fetched again.
    expect(raw.prepare("SELECT COUNT(*) AS n FROM gmail_cache").get()).toEqual({ n: 0 });
    // The upload is sealed for its row and still reads back.
    const body = (raw.prepare("SELECT body FROM gmail_upload WHERE id='gu_before'").get() as { body: Buffer }).body;
    expect(body.toString("latin1")).not.toContain("Uploaded before");
    expect(unseal(key, sealPlace.gmailUpload(ANNA, "gu_before"), body).toString()).toBe("Uploaded before the upgrade");
    expect(gmail.uploaded(ANNA, "gu_before")?.body.toString()).toBe("Uploaded before the upgrade");
  });

  it("happens once: a second start changes nothing", () => {
    const key = crypto.randomBytes(32);
    const dir = earlierVersionData(key);
    new Store(dir, key).close();
    new GmailStore(dir, key).close();
    const after = dump(dir);
    new Store(dir, key).close();
    new GmailStore(dir, key).close();
    expect(dump(dir)).toEqual(after);
  });
});

describe("after the first start", () => {
  it("a value in the earlier format opens nowhere, also one copied in from an old backup", async () => {
    const key = crypto.randomBytes(32);
    const dir = earlierVersionData(key);
    new Store(dir, key).close();
    new GmailStore(dir, key).close();

    // An old backup's values, written into the rows.
    const raw = new Database(path.join(dir, "gmail.sqlite3"));
    raw.prepare("UPDATE gmail_connection SET vault=? WHERE email=?").run(sealTheOldWay(key, Buffer.from(JSON.stringify(grant(ANNA)))), BEN);
    const old = sealTheOldWay(key, Buffer.from(JSON.stringify({ subject: "From the backup" })));
    raw.prepare("INSERT INTO gmail_cache VALUES (?,?,?,?,?,?)").run(BEN, "meta:v2:y", old, Date.now() + 3600_000, Date.now(), old.length);
    raw.close();
    const rawProxy = new Database(path.join(dir, "proxy.db"));
    rawProxy.prepare("UPDATE account SET vault=? WHERE slug=?").run(sealTheOldWay(key, Buffer.from(JSON.stringify(imapCreds))), SLUG);
    rawProxy.close();

    const proxy = new Store(dir, key);
    cleanup.push(() => proxy.close());
    const gmail = new GmailStore(dir, key);
    cleanup.push(() => gmail.close());
    await expect(gmail.load(BEN)).rejects.toThrow(/VAULT_KEY|moved/);
    expect(opensTheOldWay(key, vaultOf(dir, BEN))).toBe(true); // left as it was, not sealed for the row
    expect(gmail.cached(BEN, "meta:v2:y")).toBeNull();
    await expect(openAccountCredentials(key, proxy.getAccount(SLUG)!)).rejects.toThrow(/VAULT_KEY|moved/);
    expect((await gmail.load(ANNA))?.credentials.refreshToken).toBe("fake-refresh-" + ANNA);
  });
});

describe("a VAULT_KEY that is not the one the values were sealed with", () => {
  for (const when of ["before the first start", "after the first start"] as const) {
    it(`is refused ${when}, naming VAULT_KEY, and no row is changed`, () => {
      const key = crypto.randomBytes(32);
      const dir = earlierVersionData(key);
      if (when === "after the first start") {
        new Store(dir, key).close();
        new GmailStore(dir, key).close();
      }
      const before = dump(dir);
      const other = crypto.randomBytes(32);
      for (const open of [() => new Store(dir, other), () => new GmailStore(dir, other)]) {
        let error: Error | undefined;
        try {
          open();
        } catch (e) {
          error = e as Error;
        }
        expect(error?.name).toBe("VaultKeyMismatch");
        expect(error?.message).toMatch(/VAULT_KEY does not open the sealed values in .*(proxy\.db|gmail\.sqlite3)/);
        expect(error?.message).toContain("No row was changed");
      }
      expect(dump(dir)).toEqual(before);
    });
  }

  it("stops the proxy at start with one line and no stack, and stops gmail:password before it changes anything", async () => {
    const key = crypto.randomBytes(32);
    const dir = tempDir();
    const proxy = new Store(dir, key);
    proxy.upsertAccount({ slug: SLUG, kind: "generic", host: "imap.test", username: "pat@corp.test", vault: Buffer.alloc(40) });
    proxy.close();
    const gmail = new GmailStore(dir, key);
    await gmail.save(ANNA, grant(ANNA), { profile: { emailAddress: ANNA, historyId: "5", messagesTotal: 1, threadsTotal: 1 }, labels: [] });
    gmail.close();
    fs.writeFileSync(path.join(dir, "google.json"), JSON.stringify({ web: { client_id: "fake-id", client_secret: "fake-secret" } }));
    const before = fs.readFileSync(path.join(dir, "gmail.sqlite3"));
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PORT: "0",
      LISTEN_HOST: "127.0.0.1",
      DATA_DIR: dir,
      PROVIDERS_FILE: path.join(dir, "none.json"),
      PUBLIC_URL: "https://bridge.example.com",
      VAULT_KEY: crypto.randomBytes(32).toString("base64"),
      SESSION_HMAC_KEY: crypto.randomBytes(32).toString("base64"),
      GMAIL_OAUTH_CLIENT_FILE: path.join(dir, "google.json"),
      GMAIL_ALLOWED_EMAILS: ANNA,
      LOG_LEVEL: "silent",
    };
    delete env.TRUST_PROXY;
    const server = fileURLToPath(new URL("../../src/server.ts", import.meta.url));
    const run = spawnSync(process.execPath, ["--import", "tsx", server], { env, encoding: "utf8", timeout: 60_000 });
    expect(run.status).toBe(1);
    expect(run.stderr).toMatch(/^legacy-proxy: VAULT_KEY does not open the sealed values in .*proxy\.db/m);
    expect(run.stderr).not.toMatch(/^\s+at /m);

    const script = fileURLToPath(new URL("../../src/gmail/password.ts", import.meta.url));
    const cli = spawnSync(process.execPath, ["--import", "tsx", script, ANNA, path.join(dir, "out.json")], { env, encoding: "utf8", timeout: 60_000 });
    expect(cli.status).toBe(1);
    expect(cli.stderr).toContain("VAULT_KEY does not open");
    expect(fs.existsSync(path.join(dir, "out.json"))).toBe(false);
    expect(fs.readFileSync(path.join(dir, "gmail.sqlite3")).equals(before)).toBe(true);
  }, 120_000);
});
