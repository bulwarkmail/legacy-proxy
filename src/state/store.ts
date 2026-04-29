import path from "node:path";
import Database from "better-sqlite3";
import type { Database as DB } from "better-sqlite3";

export interface AccountRow {
  id: number;
  slug: string;
  kind: string;
  host: string;
  username: string;
  vault: Buffer;
  created_at: number;
}

export interface MailboxRow {
  id: number;
  account_id: number;
  name: string;
  parent_id: number | null;
  delim: string;
  role: string | null;
  special_use: string | null;
  uidvalidity: number;
  highest_modseq: number;
  total: number;
  unread: number;
  subscribed: number;
  last_seen: number;
}

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS account (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  slug        TEXT    NOT NULL UNIQUE,
  kind        TEXT    NOT NULL,
  host        TEXT    NOT NULL,
  username    TEXT    NOT NULL,
  vault       BLOB    NOT NULL,
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS mailbox (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id     INTEGER NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  name           TEXT    NOT NULL,
  parent_id      INTEGER REFERENCES mailbox(id) ON DELETE CASCADE,
  delim          TEXT    NOT NULL DEFAULT '/',
  role           TEXT,
  special_use    TEXT,
  uidvalidity    INTEGER NOT NULL DEFAULT 0,
  highest_modseq INTEGER NOT NULL DEFAULT 0,
  total          INTEGER NOT NULL DEFAULT 0,
  unread         INTEGER NOT NULL DEFAULT 0,
  subscribed     INTEGER NOT NULL DEFAULT 0,
  last_seen      INTEGER NOT NULL DEFAULT 0,
  UNIQUE (account_id, name)
);

CREATE TABLE IF NOT EXISTS email (
  account_id   INTEGER NOT NULL,
  mailbox_id   INTEGER NOT NULL REFERENCES mailbox(id) ON DELETE CASCADE,
  uid          INTEGER NOT NULL,
  modseq       INTEGER NOT NULL DEFAULT 0,
  message_id   TEXT,
  thread_root  TEXT,
  size         INTEGER NOT NULL DEFAULT 0,
  internaldate INTEGER NOT NULL DEFAULT 0,
  flags        TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (account_id, mailbox_id, uid)
);
CREATE INDEX IF NOT EXISTS email_msgid_idx  ON email(message_id);
CREATE INDEX IF NOT EXISTS email_thread_idx ON email(thread_root);

CREATE TABLE IF NOT EXISTS state_log (
  account_id INTEGER NOT NULL,
  kind       TEXT    NOT NULL,
  state      INTEGER NOT NULL,
  at         INTEGER NOT NULL,
  PRIMARY KEY (account_id, kind)
);

CREATE TABLE IF NOT EXISTS blob_cache (
  id         TEXT PRIMARY KEY,
  account_id INTEGER NOT NULL,
  ctype      TEXT,
  size       INTEGER NOT NULL,
  body       BLOB NOT NULL,
  expires    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS upload (
  id         TEXT PRIMARY KEY,
  account_id INTEGER NOT NULL,
  ctype      TEXT NOT NULL,
  size       INTEGER NOT NULL,
  body       BLOB NOT NULL,
  created_at INTEGER NOT NULL
);
`;

export class Store {
  readonly db: DB;

  constructor(dataDir: string) {
    this.db = new Database(path.join(dataDir, "proxy.db"));
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  upsertAccount(p: { slug: string; kind: string; host: string; username: string; vault: Buffer }): AccountRow {
    const now = Date.now();
    const stmt = this.db.prepare(
      `INSERT INTO account(slug, kind, host, username, vault, created_at)
       VALUES(?,?,?,?,?,?)
       ON CONFLICT(slug) DO UPDATE SET kind=excluded.kind, host=excluded.host,
         username=excluded.username, vault=excluded.vault`,
    );
    stmt.run(p.slug, p.kind, p.host, p.username, p.vault, now);
    return this.db.prepare(`SELECT * FROM account WHERE slug = ?`).get(p.slug) as AccountRow;
  }

  getAccount(slug: string): AccountRow | undefined {
    return this.db.prepare(`SELECT * FROM account WHERE slug = ?`).get(slug) as AccountRow | undefined;
  }

  getAccountById(id: number): AccountRow | undefined {
    return this.db.prepare(`SELECT * FROM account WHERE id = ?`).get(id) as AccountRow | undefined;
  }

  bumpState(accountId: number, kind: string): number {
    const row = this.db
      .prepare(`SELECT state FROM state_log WHERE account_id = ? AND kind = ?`)
      .get(accountId, kind) as { state: number } | undefined;
    const next = (row?.state ?? 0) + 1;
    this.db
      .prepare(
        `INSERT INTO state_log(account_id, kind, state, at) VALUES(?,?,?,?)
         ON CONFLICT(account_id, kind) DO UPDATE SET state = excluded.state, at = excluded.at`,
      )
      .run(accountId, kind, next, Date.now());
    return next;
  }

  getState(accountId: number, kind: string): number {
    const row = this.db
      .prepare(`SELECT state FROM state_log WHERE account_id = ? AND kind = ?`)
      .get(accountId, kind) as { state: number } | undefined;
    return row?.state ?? 0;
  }
}
