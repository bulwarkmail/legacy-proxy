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

-- One row per account: the editable Identity properties (signatures, display
-- name, replyTo). The base identity is always derived from the IMAP
-- credentials; this table carries only the bits the client may edit.
CREATE TABLE IF NOT EXISTS identity_settings (
  account_id      INTEGER PRIMARY KEY REFERENCES account(id) ON DELETE CASCADE,
  display_name    TEXT,
  reply_to        TEXT, -- JSON array of {name?, email}
  text_signature  TEXT,
  html_signature  TEXT,
  updated_at      INTEGER NOT NULL
);

-- sortOrder is opaque to IMAP and lives only on the JMAP side. We keep it as
-- a side table so the main mailbox row stays in sync with what LIST returns.
CREATE TABLE IF NOT EXISTS mailbox_sort_order (
  account_id INTEGER NOT NULL,
  mailbox_id INTEGER NOT NULL REFERENCES mailbox(id) ON DELETE CASCADE,
  sort_order INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (account_id, mailbox_id)
);

-- RFC 8620 §7.2 PushSubscription. We persist verified+unverified records so
-- pushes survive restarts and the IDLE manager can resume after a crash.
-- The types column is a JSON array of JMAP type names (Email, EmailDelivery,
-- ...) the client cares about; we filter outgoing StateChange bodies against
-- it. verification_code is one-shot: cleared the moment the client confirms
-- it via PushSubscription/set update.
CREATE TABLE IF NOT EXISTS push_subscription (
  id                TEXT    PRIMARY KEY,
  account_id        INTEGER NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  device_client_id  TEXT,
  url               TEXT    NOT NULL,
  types             TEXT,
  expires           INTEGER,
  verification_code TEXT,
  verified          INTEGER NOT NULL DEFAULT 0,
  created_at        INTEGER NOT NULL,
  last_push_at      INTEGER
);
CREATE INDEX IF NOT EXISTS push_sub_account_idx ON push_subscription(account_id);
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

  // In-memory change log. Each entry records a single id-level mutation
  // (`created` / `updated` / `destroyed`) tagged with the post-mutation state
  // for its kind, so `*/changes(sinceState)` can replay the diff. The log is
  // bounded per (account, kind) — when the buffer is exceeded we accept that
  // any sinceState referring to an evicted entry must answer
  // `cannotCalculateChanges`.
  //
  // We keep this in memory because it doesn't need to survive a restart: the
  // proxy promises `cannotCalculateChanges` whenever the log can't reconstruct
  // the diff, and a restart is one such case. Persisting it would add IO
  // pressure on every Email/set / Mailbox/set without changing what clients
  // can observe.
  private static readonly CHANGE_LOG_LIMIT = 1024;
  private changeLog = new Map<string, ChangeLogEntry[]>();

  recordChanges(
    accountId: number,
    kind: string,
    diff: { created?: string[]; updated?: string[]; destroyed?: string[] },
  ): number {
    const created = diff.created ?? [];
    const updated = diff.updated ?? [];
    const destroyed = diff.destroyed ?? [];
    if (created.length === 0 && updated.length === 0 && destroyed.length === 0) {
      return this.getState(accountId, kind);
    }
    const newState = this.bumpState(accountId, kind);
    const key = `${accountId}|${kind}`;
    const buf = this.changeLog.get(key) ?? [];
    for (const id of created) buf.push({ state: newState, action: "created", id });
    for (const id of updated) buf.push({ state: newState, action: "updated", id });
    for (const id of destroyed) buf.push({ state: newState, action: "destroyed", id });
    while (buf.length > Store.CHANGE_LOG_LIMIT) buf.shift();
    this.changeLog.set(key, buf);
    return newState;
  }

  // Resolve a sinceState string against the change log. Returns either the
  // entries the caller can stream out as created/updated/destroyed, or null
  // when the log can't account for the period (the caller should answer
  // `cannotCalculateChanges`).
  entriesSince(accountId: number, kind: string, sinceState: number, currentState: number): ChangeLogEntry[] | null {
    if (sinceState === currentState) return [];
    if (sinceState > currentState) return null;
    const key = `${accountId}|${kind}`;
    const buf = this.changeLog.get(key);
    if (!buf || buf.length === 0) return null;
    // If the oldest entry's state > sinceState + 1 then we're missing the
    // intermediate ones (got evicted). Conservative: bail.
    if (buf[0]!.state > sinceState + 1) return null;
    return buf.filter((e) => e.state > sinceState && e.state <= currentState);
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
    this.stateListener?.(accountId, kind, next);
    return next;
  }

  // The push dispatcher hooks here so every state bump (whether from a JMAP
  // request handler or the IDLE worker) gets fanned out to SSE clients and
  // any verified PushSubscription URLs. Set once at startup; subsequent calls
  // overwrite — there's only ever one dispatcher.
  setStateListener(fn: ((accountId: number, kind: string, state: number) => void) | undefined): void {
    this.stateListener = fn;
  }
  private stateListener?: (accountId: number, kind: string, state: number) => void;

  getState(accountId: number, kind: string): number {
    const row = this.db
      .prepare(`SELECT state FROM state_log WHERE account_id = ? AND kind = ?`)
      .get(accountId, kind) as { state: number } | undefined;
    return row?.state ?? 0;
  }

  getIdentitySettings(accountId: number): IdentitySettings {
    const row = this.db
      .prepare(
        `SELECT display_name, reply_to, text_signature, html_signature FROM identity_settings WHERE account_id = ?`,
      )
      .get(accountId) as
      | {
          display_name: string | null;
          reply_to: string | null;
          text_signature: string | null;
          html_signature: string | null;
        }
      | undefined;
    if (!row) return { displayName: null, replyTo: null, textSignature: null, htmlSignature: null };
    let replyTo: IdentitySettings["replyTo"] = null;
    if (row.reply_to) {
      try {
        replyTo = JSON.parse(row.reply_to);
      } catch {
        replyTo = null;
      }
    }
    return {
      displayName: row.display_name,
      replyTo,
      textSignature: row.text_signature,
      htmlSignature: row.html_signature,
    };
  }

  putUpload(p: { id: string; accountId: number; ctype: string; body: Buffer }): void {
    this.db
      .prepare(
        `INSERT INTO upload(id, account_id, ctype, size, body, created_at)
         VALUES(?,?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET ctype=excluded.ctype, size=excluded.size, body=excluded.body, created_at=excluded.created_at`,
      )
      .run(p.id, p.accountId, p.ctype, p.body.length, p.body, Date.now());
  }

  getUpload(id: string, accountId: number): { ctype: string; body: Buffer } | null {
    const row = this.db
      .prepare(`SELECT ctype, body FROM upload WHERE id = ? AND account_id = ?`)
      .get(id, accountId) as { ctype: string; body: Buffer } | undefined;
    return row ?? null;
  }

  // Drop uploads older than `olderThanMs` to keep the SQLite file from growing
  // unboundedly. Called opportunistically from the upload route; not on a
  // timer (we don't want a background loop in this process yet).
  pruneUploads(olderThanMs: number): void {
    const cutoff = Date.now() - olderThanMs;
    this.db.prepare(`DELETE FROM upload WHERE created_at < ?`).run(cutoff);
  }

  // Update the cached path/parent for a mailbox after an IMAP RENAME. The
  // listMailboxes upsert deliberately does not touch (name, parent_id) on
  // conflict — it can't tell a rename from a name reuse — so callers that
  // know they renamed must announce it here.
  updateMailboxPath(accountId: number, mailboxId: number, newName: string, newParentId: number | null): void {
    this.db
      .prepare(`UPDATE mailbox SET name = ?, parent_id = ? WHERE id = ? AND account_id = ?`)
      .run(newName, newParentId, mailboxId, accountId);
  }

  putMailboxSortOrder(accountId: number, mailboxId: number, sortOrder: number): void {
    this.db
      .prepare(
        `INSERT INTO mailbox_sort_order(account_id, mailbox_id, sort_order)
         VALUES(?,?,?)
         ON CONFLICT(account_id, mailbox_id) DO UPDATE SET sort_order = excluded.sort_order`,
      )
      .run(accountId, mailboxId, sortOrder);
  }

  getMailboxSortOrders(accountId: number): Map<number, number> {
    const rows = this.db
      .prepare(`SELECT mailbox_id, sort_order FROM mailbox_sort_order WHERE account_id = ?`)
      .all(accountId) as { mailbox_id: number; sort_order: number }[];
    return new Map(rows.map((r) => [r.mailbox_id, r.sort_order]));
  }

  insertPushSubscription(row: PushSubscriptionRow): void {
    this.db
      .prepare(
        `INSERT INTO push_subscription(
           id, account_id, device_client_id, url, types,
           expires, verification_code, verified, created_at, last_push_at
         ) VALUES(?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        row.id,
        row.accountId,
        row.deviceClientId,
        row.url,
        row.types ? JSON.stringify(row.types) : null,
        row.expires ?? null,
        row.verificationCode,
        row.verified ? 1 : 0,
        row.createdAt,
        row.lastPushAt ?? null,
      );
  }

  getPushSubscription(id: string, accountId: number): PushSubscriptionRow | null {
    const r = this.db
      .prepare(`SELECT * FROM push_subscription WHERE id = ? AND account_id = ?`)
      .get(id, accountId) as PushRowRaw | undefined;
    return r ? rowToPushSub(r) : null;
  }

  listPushSubscriptions(accountId: number): PushSubscriptionRow[] {
    const rows = this.db
      .prepare(`SELECT * FROM push_subscription WHERE account_id = ? ORDER BY created_at`)
      .all(accountId) as PushRowRaw[];
    return rows.map(rowToPushSub);
  }

  // Returns subs that should currently be receiving StateChange POSTs:
  // verified, not expired, with a non-empty types filter. The dispatcher uses
  // this on every fan-out so a freshly destroyed/expired sub stops receiving
  // mid-flight without needing an explicit cache invalidation.
  activePushSubscriptions(accountId: number): PushSubscriptionRow[] {
    const now = Date.now();
    const rows = this.db
      .prepare(
        `SELECT * FROM push_subscription
         WHERE account_id = ? AND verified = 1
         AND (expires IS NULL OR expires > ?)`,
      )
      .all(accountId, now) as PushRowRaw[];
    return rows.map(rowToPushSub);
  }

  // Distinct list of accounts that need an IDLE worker right now. Used by the
  // PushIdleManager on startup and after every PushSubscription/set mutation
  // to recompute who needs a connection held open.
  accountsWithActivePushSubs(): number[] {
    const now = Date.now();
    const rows = this.db
      .prepare(
        `SELECT DISTINCT account_id FROM push_subscription
         WHERE verified = 1 AND (expires IS NULL OR expires > ?)`,
      )
      .all(now) as { account_id: number }[];
    return rows.map((r) => r.account_id);
  }

  updatePushSubscription(
    id: string,
    accountId: number,
    patch: { types?: string[] | null; expires?: number | null; verified?: boolean; verificationCode?: string | null; lastPushAt?: number },
  ): boolean {
    const fields: string[] = [];
    const values: unknown[] = [];
    if ("types" in patch) {
      fields.push("types = ?");
      values.push(patch.types ? JSON.stringify(patch.types) : null);
    }
    if ("expires" in patch) {
      fields.push("expires = ?");
      values.push(patch.expires ?? null);
    }
    if ("verified" in patch) {
      fields.push("verified = ?");
      values.push(patch.verified ? 1 : 0);
    }
    if ("verificationCode" in patch) {
      fields.push("verification_code = ?");
      values.push(patch.verificationCode ?? null);
    }
    if ("lastPushAt" in patch) {
      fields.push("last_push_at = ?");
      values.push(patch.lastPushAt ?? null);
    }
    if (fields.length === 0) return true;
    values.push(id, accountId);
    const res = this.db
      .prepare(`UPDATE push_subscription SET ${fields.join(", ")} WHERE id = ? AND account_id = ?`)
      .run(...values);
    return res.changes > 0;
  }

  destroyPushSubscription(id: string, accountId: number): boolean {
    const res = this.db
      .prepare(`DELETE FROM push_subscription WHERE id = ? AND account_id = ?`)
      .run(id, accountId);
    return res.changes > 0;
  }

  // Subscriptions older than ~90 days that never authenticated their
  // verification code are abandoned client attempts; drop them so the table
  // doesn't grow unboundedly. Active verified subs are untouched.
  pruneStalePushSubscriptions(maxUnverifiedAgeMs: number): void {
    const cutoff = Date.now() - maxUnverifiedAgeMs;
    this.db
      .prepare(`DELETE FROM push_subscription WHERE verified = 0 AND created_at < ?`)
      .run(cutoff);
  }

  putIdentitySettings(accountId: number, s: IdentitySettings): void {
    const replyJson = s.replyTo ? JSON.stringify(s.replyTo) : null;
    this.db
      .prepare(
        `INSERT INTO identity_settings(account_id, display_name, reply_to, text_signature, html_signature, updated_at)
         VALUES(?,?,?,?,?,?)
         ON CONFLICT(account_id) DO UPDATE SET
           display_name = excluded.display_name,
           reply_to = excluded.reply_to,
           text_signature = excluded.text_signature,
           html_signature = excluded.html_signature,
           updated_at = excluded.updated_at`,
      )
      .run(accountId, s.displayName, replyJson, s.textSignature, s.htmlSignature, Date.now());
  }
}

export interface ChangeLogEntry {
  state: number;
  action: "created" | "updated" | "destroyed";
  id: string;
}

export interface PushSubscriptionRow {
  id: string;
  accountId: number;
  deviceClientId: string | null;
  url: string;
  types: string[] | null;
  expires: number | null;
  verificationCode: string | null;
  verified: boolean;
  createdAt: number;
  lastPushAt: number | null;
}

interface PushRowRaw {
  id: string;
  account_id: number;
  device_client_id: string | null;
  url: string;
  types: string | null;
  expires: number | null;
  verification_code: string | null;
  verified: number;
  created_at: number;
  last_push_at: number | null;
}

function rowToPushSub(r: PushRowRaw): PushSubscriptionRow {
  let types: string[] | null = null;
  if (r.types) {
    try {
      const parsed = JSON.parse(r.types);
      if (Array.isArray(parsed)) types = parsed.filter((t) => typeof t === "string");
    } catch {
      types = null;
    }
  }
  return {
    id: r.id,
    accountId: r.account_id,
    deviceClientId: r.device_client_id,
    url: r.url,
    types,
    expires: r.expires,
    verificationCode: r.verification_code,
    verified: r.verified !== 0,
    createdAt: r.created_at,
    lastPushAt: r.last_push_at,
  };
}

export interface IdentitySettings {
  displayName: string | null;
  replyTo: { name?: string | null; email: string }[] | null;
  textSignature: string | null;
  htmlSignature: string | null;
}
