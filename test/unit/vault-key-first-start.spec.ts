// A mistyped VAULT_KEY on the first start must not lock the right key out.
// The server checks every database it uses before it opens any, so a typo
// start writes nothing. And a key check that doesn't open, in a database that
// holds nothing that depends on the key, is replaced instead of refused, so no
// order of opening can pin a wrong key where there is nothing to protect.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { Store } from "../../src/state/store.js";
import { GmailStore } from "../../src/gmail/store.js";
import { openAccountCredentials, sealCredentials, sealPlace } from "../../src/auth/credentials.js";

const ANNA = "anna@gmail.test";
const SLUG = "generic:pat@corp.test";
const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const f of cleanup.splice(0).reverse()) f();
});

function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "legacy-proxy-key-first-start-"));
  cleanup.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function sealTheOldWay(key: Buffer, plain: Buffer): Buffer {
  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, nonce);
  const ct = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([nonce, cipher.getAuthTag(), ct]);
}
/** A data directory as an earlier version left it, with Gmail connections, IMAP accounts, both or neither. */
function earlierData(key: Buffer, what: { gmail: boolean; imap: boolean; proxyDb: boolean }) {
  const dir = tempDir();
  if (what.gmail) {
    const gmail = new Database(path.join(dir, "gmail.sqlite3"));
    gmail.exec("CREATE TABLE gmail_connection (email TEXT PRIMARY KEY, vault BLOB NOT NULL, snapshot TEXT NOT NULL, updated_at INTEGER NOT NULL)");
    const grant = { mech: "XOAUTH2", username: ANNA, refreshToken: "fake-refresh", scopes: [] };
    gmail.prepare("INSERT INTO gmail_connection VALUES (?,?,?,?)").run(ANNA, sealTheOldWay(key, Buffer.from(JSON.stringify(grant))), "{}", 1);
    gmail.close();
  }
  if (what.proxyDb || what.imap) {
    const proxy = new Store(dir); // tables only, as before
    if (what.imap)
      proxy.upsertAccount({
        slug: SLUG,
        kind: "generic",
        host: "imap.test",
        username: "pat@corp.test",
        vault: sealTheOldWay(key, Buffer.from(JSON.stringify({ mech: "PLAIN", username: "pat@corp.test", password: "fake-imap-password" }))),
      });
    proxy.close();
  }
  return dir;
}
/**
 * Every row of every table of both databases, read through SQLite (so what a
 * process left in the write-ahead log counts too). Tables only: the start adds
 * none before its check.
 */
function contents(dir: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const file of ["proxy.db", "gmail.sqlite3"]) {
    if (!fs.existsSync(path.join(dir, file))) continue;
    const db = new Database(path.join(dir, file), { readonly: true });
    for (const { name } of db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as { name: string }[])
      out[`${file}.${name}`] = db.prepare(`SELECT * FROM ${name}`).all();
    db.close();
  }
  return out;
}
/** What src/server.ts does: check every database it uses, then open them, proxy.db first. */
function serverStart(dir: string, key: Buffer, gmail: boolean): string {
  try {
    Store.verifyVaultKey(dir, key);
    if (gmail) GmailStore.verifyVaultKey(dir, key);
    new Store(dir, key).close();
    if (gmail) new GmailStore(dir, key).close();
    return "started";
  } catch (e) {
    return (e as Error).message;
  }
}
/** The stores opened one after the other with no check first (a tool that opens one database, say). */
function openInTurn(dir: string, key: Buffer, gmail: boolean): string {
  try {
    new Store(dir, key).close();
    if (gmail) new GmailStore(dir, key).close();
    return "started";
  } catch (e) {
    return (e as Error).message;
  }
}
async function gmailWorks(dir: string, key: Buffer) {
  const g = new GmailStore(dir, key);
  try {
    return (await g.load(ANNA))?.credentials.refreshToken;
  } finally {
    g.close();
  }
}
async function imapWorks(dir: string, key: Buffer) {
  const s = new Store(dir, key);
  try {
    return (await openAccountCredentials(key, s.getAccount(SLUG)!)).password;
  } finally {
    s.close();
  }
}

describe("a mistyped VAULT_KEY on the first start, then the right one", () => {
  for (const [name, start] of [["the server", serverStart], ["the stores opened in turn", openInTurn]] as const) {
    for (const proxyDb of [true, false]) {
      it(`Gmail bridge only (proxy.db ${proxyDb ? "from before" : "new"}), ${name}: the proxy starts and every Gmail connection works`, async () => {
        const right = crypto.randomBytes(32);
        const dir = earlierData(right, { gmail: true, imap: false, proxyDb });
        expect(start(dir, crypto.randomBytes(32), true)).toMatch(/VAULT_KEY does not open the sealed values in .*gmail\.sqlite3/);
        expect(start(dir, right, true)).toBe("started");
        expect(await gmailWorks(dir, right)).toBe("fake-refresh");
      });
    }

    it(`IMAP accounts only, ${name}: refused, then the proxy starts and the accounts work`, async () => {
      const right = crypto.randomBytes(32);
      const dir = earlierData(right, { gmail: false, imap: true, proxyDb: true });
      expect(start(dir, crypto.randomBytes(32), false)).toMatch(/proxy\.db/);
      expect(start(dir, right, false)).toBe("started");
      expect(await imapWorks(dir, right)).toBe("fake-imap-password");
    });

    it(`both, ${name}: refused, then the proxy starts and both work`, async () => {
      const right = crypto.randomBytes(32);
      const dir = earlierData(right, { gmail: true, imap: true, proxyDb: true });
      expect(start(dir, crypto.randomBytes(32), true)).toMatch(/proxy\.db/);
      expect(start(dir, right, true)).toBe("started");
      expect(await imapWorks(dir, right)).toBe("fake-imap-password");
      expect(await gmailWorks(dir, right)).toBe("fake-refresh");
    });

    it(`two empty databases, ${name}: either key starts until something is sealed, then only that key`, async () => {
      const dir = tempDir();
      const typo = crypto.randomBytes(32);
      const right = crypto.randomBytes(32);
      expect(start(dir, typo, true)).toBe("started");
      expect(start(dir, right, true)).toBe("started");
      // Now an account is stored under the right key: the typo no longer opens anything.
      const s = new Store(dir, right);
      s.upsertAccount({ slug: SLUG, kind: "generic", host: "imap.test", username: "pat@corp.test", vault: await sealCredentials(right, sealPlace.account(SLUG), { mech: "PLAIN", username: "pat@corp.test", password: "p" }) });
      s.close();
      expect(start(dir, typo, true)).toMatch(/proxy\.db/);
      expect(start(dir, right, true)).toBe("started");
    });
  }

  it("the server's check writes nothing: after a typo start neither database changed", () => {
    const right = crypto.randomBytes(32);
    const dir = earlierData(right, { gmail: true, imap: false, proxyDb: true });
    const before = contents(dir);
    expect(serverStart(dir, crypto.randomBytes(32), true)).toMatch(/gmail\.sqlite3/);
    expect(contents(dir)).toEqual(before);
  });
});

describe("the keying of bridge password and token hashes", () => {
  it("never runs twice, also when a database looks like a first start again", async () => {
    const dir = tempDir();
    const key = crypto.randomBytes(32);
    const g = new GmailStore(dir, key);
    await g.save(ANNA, { mech: "XOAUTH2", username: ANNA, refreshToken: "fake-refresh", scopes: [] }, { profile: { emailAddress: ANNA, historyId: "5", messagesTotal: 1, threadsTotal: 1 }, labels: [] });
    const password = g.issuePassword(ANNA);
    const tokens = g.issueTokens(ANNA, "webmail");
    g.close();
    // No key check and no sealed grant left: what a first start looks like.
    const raw = new Database(path.join(dir, "gmail.sqlite3"));
    raw.exec("DELETE FROM vault_check; DELETE FROM gmail_connection;");
    const hashes = () => raw.prepare("SELECT hash FROM gmail_password UNION ALL SELECT hash FROM gmail_token ORDER BY 1").all();
    const before = hashes();
    const again = new GmailStore(dir, key);
    cleanup.push(() => again.close());
    expect(hashes()).toEqual(before);
    raw.close();
    expect(again.authenticate(password, ANNA)).toBe(ANNA);
    expect(again.authenticateToken(tokens.accessToken)).toBe(ANNA);
  });
});

describe("the proxy started with a mistyped key on a Gmail-only directory", () => {
  it("exits with the message for gmail.sqlite3 and leaves proxy.db as it was", () => {
    const right = crypto.randomBytes(32);
    const dir = earlierData(right, { gmail: true, imap: false, proxyDb: true });
    fs.writeFileSync(path.join(dir, "google.json"), JSON.stringify({ web: { client_id: "fake-id", client_secret: "fake-secret" } }));
    const before = contents(dir);
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
    expect(run.stderr).toMatch(/^legacy-proxy: VAULT_KEY does not open the sealed values in .*gmail\.sqlite3/m);
    expect(contents(dir)).toEqual(before);
  }, 120_000);
});
