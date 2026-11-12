import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { planSealedValues, sealPlace } from "../auth/credentials.js";
import type { Database as DB, Statement } from "better-sqlite3";

export interface AccountRow {
  id: number;
  slug: string;
  kind: string;
  host: string;
  username: string;
  vault: Buffer;
  created_at: number;
  /**
   * Credential generation. It moves when a login stores a different password
   * for the account, and when the mail server refuses the stored one; session
   * tokens carry the generation they were issued under and stop working once
   * it has moved on.
   */
  cred_gen: number;
  /**
   * 1 once the mail server refused the stored credentials: nothing logs in
   * with them again until a login succeeds. Survives restarts.
   */
  cred_refused: number;
  /** Refusals of the stored credentials in a row, while not yet marked refused. */
  cred_refusals: number;
  /** When the first of those refusals came (epoch ms), 0 when there are none. */
  cred_first_refusal: number;
  /**
   * The credential tag of the sign-in that moved the generation last, when a
   * sign-in did: sessions made with those credentials stay valid under the new
   * generation. Null otherwise.
   */
  cred_rotated_by: string | null;
  /**
   * A check of the stored credentials that has no answer yet (see
   * `openCredentialCheck`): the credentials it checks, the ones held before a
   * sign-in with other credentials. Null when no check is open. The fields of
   * the check are optional so rows made up outside the database need none.
   */
  cred_check_vault?: Buffer | null;
  /** The credential tag of the sign-in that opened the check; its credentials are in `vault` meanwhile. */
  cred_check_tag?: string | null;
  /** When the check opened (epoch ms); identifies it. */
  cred_check_since?: number;
  /** Attempts the check made at the mail server so far. */
  cred_check_attempts?: number;
  /** When its last attempt started (epoch ms), 0 before the first. */
  cred_check_last?: number;
}

/** Refusals of the stored credentials in a row before they are marked refused. */
export const STORED_CREDENTIAL_ATTEMPTS = 3;
/**
 * The least time those refusals must span. A server that refuses logins for a
 * moment (a restart, a store hiccup it reports as a refusal) does not mark
 * anyone; a password that was really changed ends the sessions within this
 * time, or at once when the owner signs in with the new one.
 */
export const STORED_CREDENTIAL_SPREAD_MS = 5 * 60_000;

/**
 * When the stored credentials may be tried again after a refusal (epoch ms;
 * 0 when they have none pending). The attempts are spaced evenly over
 * STORED_CREDENTIAL_SPREAD_MS, so the last one that may set the mark comes no
 * earlier than that after the first.
 *
 * `requestedAt`: when a user's request that needs a connection started. After
 * a single refusal, such a request made after it may try once right away (the
 * refusal may have been a moment's hiccup); the attempt after that still waits
 * for the end of the spread, so there are never more than three in it.
 * Requests that were already waiting when the refusal came, and the IDLE
 * worker, keep the spacing.
 */
export function nextStoredAttemptAt(
  row: Pick<AccountRow, "cred_refusals" | "cred_first_refusal">,
  requestedAt?: number,
): number {
  if (!row.cred_refusals) return 0;
  if (row.cred_refusals === 1 && requestedAt !== undefined && requestedAt > row.cred_first_refusal) {
    return row.cred_first_refusal;
  }
  const spacing = STORED_CREDENTIAL_SPREAD_MS / (STORED_CREDENTIAL_ATTEMPTS - 1);
  return row.cred_first_refusal + row.cred_refusals * spacing;
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
-- NORMAL is the recommended pairing with WAL: fsync on checkpoint instead of
-- on every transaction. The change log and mailbox upserts write on every
-- mutation, so FULL's per-txn fsync is measurable on slow disks.
PRAGMA synchronous = NORMAL;
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

-- Replaced by email_cache below; was never written to.
DROP TABLE IF EXISTS email;

-- Immutable per-message metadata, keyed by (mailbox, uid) and stamped with the
-- uidvalidity it was fetched under. IMAP guarantees message content never
-- changes for a given (uidvalidity, uid), so rows never go stale — they are
-- only purged when the uidvalidity rolls or the message is expunged.
--
-- Two writers fill it at different depths:
--   - the thread scan inserts minimal rows (thread_id, internaldate) for every
--     message in the account;
--   - Email/get upserts the full projection source (envelope, bodystructure,
--     raw header block, preview) for messages it actually served.
-- Flags are deliberately NOT cached: they're the one mutable attribute.
CREATE TABLE IF NOT EXISTS email_cache (
  account_id    INTEGER NOT NULL,
  mailbox_id    INTEGER NOT NULL REFERENCES mailbox(id) ON DELETE CASCADE,
  uidvalidity   INTEGER NOT NULL,
  uid           INTEGER NOT NULL,
  thread_id     TEXT,
  internaldate  INTEGER NOT NULL DEFAULT 0,
  size          INTEGER,
  envelope      TEXT,
  bodystructure TEXT,
  headers_raw   BLOB,
  headers_full  INTEGER NOT NULL DEFAULT 0,
  preview       TEXT,
  created_at    INTEGER NOT NULL,
  PRIMARY KEY (account_id, mailbox_id, uid)
);
CREATE INDEX IF NOT EXISTS email_cache_thread_idx ON email_cache(account_id, thread_id);

-- Bookkeeping for the incremental thread scan: the (uidvalidity, uidnext,
-- messages) triple observed on the last SELECT of each folder. When all three
-- still match, no message was added or expunged since, so the cached rows are
-- complete and current without any FETCH.
CREATE TABLE IF NOT EXISTS mailbox_scan (
  account_id  INTEGER NOT NULL,
  mailbox_id  INTEGER NOT NULL REFERENCES mailbox(id) ON DELETE CASCADE,
  uidvalidity INTEGER NOT NULL,
  uidnext     INTEGER NOT NULL,
  messages    INTEGER NOT NULL,
  scanned_at  INTEGER NOT NULL,
  PRIMARY KEY (account_id, mailbox_id)
);

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

-- Session tokens their holder ended with /api/logout, by SHA-256 of the token,
-- kept until the token would have expired anyway.
CREATE TABLE IF NOT EXISTS ended_session (
  token_hash TEXT    PRIMARY KEY,
  expires    INTEGER NOT NULL
);

-- A value sealed under the vault key, so a start with another key is refused
-- before anything is changed (auth/credentials.ts planSealedValues).
CREATE TABLE IF NOT EXISTS vault_check (
  id    INTEGER PRIMARY KEY CHECK (id = 1),
  value BLOB    NOT NULL
);
`;

// Columns added to tables that existing databases already have.
const ADDED_COLUMNS: { table: string; column: string; definition: string }[] = [
  { table: "account", column: "cred_gen", definition: "INTEGER NOT NULL DEFAULT 0" },
  { table: "account", column: "cred_refused", definition: "INTEGER NOT NULL DEFAULT 0" },
  { table: "account", column: "cred_refusals", definition: "INTEGER NOT NULL DEFAULT 0" },
  { table: "account", column: "cred_rotated_by", definition: "TEXT" },
  { table: "account", column: "cred_first_refusal", definition: "INTEGER NOT NULL DEFAULT 0" },
  { table: "push_subscription", column: "cred_gen", definition: "INTEGER NOT NULL DEFAULT 0" },
  { table: "account", column: "cred_check_vault", definition: "BLOB" },
  { table: "account", column: "cred_check_tag", definition: "TEXT" },
  { table: "account", column: "cred_check_since", definition: "INTEGER NOT NULL DEFAULT 0" },
  { table: "account", column: "cred_check_attempts", definition: "INTEGER NOT NULL DEFAULT 0" },
  { table: "account", column: "cred_check_last", definition: "INTEGER NOT NULL DEFAULT 0" },
];

// Clears an open check of the stored credentials, inside an UPDATE's SET list.
const NO_CHECK =
  "cred_check_vault = NULL, cred_check_tag = NULL, cred_check_since = 0, cred_check_attempts = 0, cred_check_last = 0";

export class Store {
  readonly db: DB;

  // better-sqlite3 compiles SQL on every `prepare()`, and the request path
  // prepares the same handful of mailbox lookups over and over -- once per
  // Email/get group, once per folder in a refresh loop. Memoise by SQL text so
  // each statement is compiled once for the life of the process.
  //
  // Safe because no call site uses `.iterate()`: a statement may not be
  // re-entered while an iterator over it is open, but `.get()`, `.all()` and
  // `.run()` can be reused freely.
  private stmts = new Map<string, Statement>();

  /**
   * Opens `proxy.db` in `dataDir`. With `vaultKey` (the server passes it) the
   * sealed credentials are checked against the key first: a key that doesn't
   * open them throws {@link VaultKeyMismatch} before any row is changed, and
   * the first start of this version seals the values of earlier versions for
   * their row (see planSealedValues).
   */
  constructor(dataDir: string, vaultKey?: Buffer) {
    // The database holds the sealed mail credentials and, in clear, cached
    // message metadata, previews, attachments and uploads: only the proxy's
    // own user may read it. Permissions are set before SQLite opens the file,
    // so the WAL and SHM files it creates next to it get the same; files from
    // before this get them on the next start.
    const file = path.join(dataDir, "proxy.db");
    fs.closeSync(fs.openSync(file, "a", 0o600));
    for (const f of [file, `${file}-wal`, `${file}-shm`]) if (fs.existsSync(f)) fs.chmodSync(f, 0o600);
    this.db = new Database(file);
    try {
      this.db.exec(SCHEMA);
      for (const { table, column, definition } of ADDED_COLUMNS) {
        const columns = this.db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
        if (!columns.some((c) => c.name === column)) {
          this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
        }
      }
      if (vaultKey) this.prepareSealedValues(vaultKey, file);
    } catch (e) {
      this.db.close();
      throw e;
    }
  }

  /** The start step of the sealed credentials, in one transaction (see planSealedValues). */
  private prepareSealedValues(key: Buffer, file: string): void {
    this.db.transaction(() => {
      const check = (this.db.prepare(`SELECT value FROM vault_check WHERE id = 1`).get() as { value: Buffer } | undefined)
        ?.value ?? null;
      const rows = this.db.prepare(`SELECT id, slug, vault, cred_check_vault FROM account`).all() as {
        id: number;
        slug: string;
        vault: Buffer;
        cred_check_vault: Buffer | null;
      }[];
      // A row's stored credentials and the ones a check holds share the row's place.
      const values = rows.flatMap((r) => [
        { id: r.id, column: "vault", value: r.vault, place: sealPlace.account(r.slug) },
        ...(r.cred_check_vault
          ? [{ id: r.id, column: "cred_check_vault", value: r.cred_check_vault, place: sealPlace.account(r.slug) }]
          : []),
      ]);
      const plan = planSealedValues(key, file, check, values);
      for (const { index, value } of plan.reseal) {
        const v = values[index]!;
        this.db.prepare(`UPDATE account SET ${v.column} = ? WHERE id = ? AND ${v.column} = ?`).run(value, v.id, v.value);
      }
      if (plan.check) this.db.prepare(`INSERT INTO vault_check(id, value) VALUES(1, ?)`).run(plan.check);
    })();
  }

  /** Prepared statement for `sql`, compiled once and cached. */
  prep(sql: string): Statement {
    let stmt = this.stmts.get(sql);
    if (!stmt) {
      stmt = this.db.prepare(sql);
      this.stmts.set(sql, stmt);
    }
    return stmt;
  }

  close(): void {
    this.db.close();
  }

  /**
   * Store the credentials a successful login proved, which clears a refused
   * mark. `rotate` says they replaced what the row held: the credential
   * generation then moves, which ends every session issued under the previous
   * one except those made with the new credentials (tag `rotatedBy`), and the
   * push subscriptions made under it except those made since `keepSince`.
   */
  upsertAccount(p: {
    slug: string;
    kind: string;
    host: string;
    username: string;
    vault: Buffer;
    rotate?: boolean;
    rotatedBy?: string | null;
    keepSince?: number;
  }): AccountRow {
    const now = Date.now();
    const before = this.getAccount(p.slug);
    const stmt = this.prep(
      `INSERT INTO account(slug, kind, host, username, vault, created_at)
       VALUES(?,?,?,?,?,?)
       ON CONFLICT(slug) DO UPDATE SET kind=excluded.kind, host=excluded.host,
         username=excluded.username, vault=excluded.vault,
         cred_gen = cred_gen + ?, cred_refused = 0, cred_refusals = 0, cred_first_refusal = 0,
         cred_rotated_by = CASE WHEN ? THEN ? ELSE cred_rotated_by END`,
    );
    const rotate = p.rotate ? 1 : 0;
    stmt.run(p.slug, p.kind, p.host, p.username, p.vault, now, rotate, rotate, p.rotatedBy ?? null);
    // Replaced credentials have nothing left to check.
    if (rotate) this.prep(`UPDATE account SET ${NO_CHECK} WHERE slug = ?`).run(p.slug);
    const row = this.prep(`SELECT * FROM account WHERE slug = ?`).get(p.slug) as AccountRow;
    if (before && before.cred_gen !== row.cred_gen) this.endOldSubscriptions(row.id, row.cred_gen, p.keepSince);
    if (before && (before.cred_gen !== row.cred_gen || before.cred_refused)) this.credentialListener?.(row.id);
    return row;
  }

  /**
   * The mail server refused the stored credentials of generation `gen`. After
   * {@link STORED_CREDENTIAL_ATTEMPTS} refusals in a row that span at least
   * {@link STORED_CREDENTIAL_SPREAD_MS} they are marked refused and the
   * generation moves. Returns true when the account is marked. A refusal of
   * credentials the row no longer holds is not counted.
   */
  noteCredentialRefusal(accountId: number, gen: number, now = Date.now()): boolean {
    this.prep(
      `UPDATE account SET cred_refusals = cred_refusals + 1,
         cred_first_refusal = CASE WHEN cred_refusals = 0 THEN ? ELSE cred_first_refusal END
       WHERE id = ? AND cred_gen = ? AND cred_refused = 0`,
    ).run(now, accountId, gen);
    const row = this.getAccountById(accountId);
    if (!row) return true;
    if (row.cred_refused) return true;
    if (row.cred_refusals < STORED_CREDENTIAL_ATTEMPTS) return false;
    if (now - row.cred_first_refusal < STORED_CREDENTIAL_SPREAD_MS) return false;
    this.prep(
      `UPDATE account SET cred_refused = 1, cred_refusals = 0, cred_first_refusal = 0,
         cred_gen = cred_gen + 1, cred_rotated_by = NULL, ${NO_CHECK}
       WHERE id = ?`,
    ).run(accountId);
    this.endOldSubscriptions(accountId, row.cred_gen + 1);
    this.credentialListener?.(accountId);
    return true;
  }

  /** The stored credentials just worked: refusals so far were not in a row. */
  noteCredentialSuccess(accountId: number): void {
    this.prep(`UPDATE account SET cred_refusals = 0, cred_first_refusal = 0 WHERE id = ? AND cred_refusals > 0`).run(
      accountId,
    );
  }

  /**
   * A sign-in succeeded with credentials (`vault`, tag `tag`) other than the
   * stored ones: open a check of the stored ones. Until it has an answer the
   * row holds the new credentials, so everything the proxy opens for the
   * account meanwhile logs in with credentials the server just accepted, and
   * keeps the stored ones in `cred_check_vault`. The generation does not move.
   * Returns the row, or undefined when a check is open already.
   */
  openCredentialCheck(accountId: number, p: { vault: Buffer; tag: string; since: number }): AccountRow | undefined {
    // SQLite evaluates every SET expression on the row as it was, so the
    // stored vault moves to cred_check_vault as the new one takes its place.
    const changed = this.prep(
      `UPDATE account SET cred_check_vault = vault, vault = ?, cred_check_tag = ?, cred_check_since = ?,
         cred_check_attempts = 0, cred_check_last = 0
       WHERE id = ? AND cred_check_tag IS NULL AND cred_refused = 0`,
    ).run(p.vault, p.tag, p.since, accountId).changes;
    return changed ? this.getAccountById(accountId) : undefined;
  }

  /** Count an attempt of the check opened at `since` (epoch ms) that starts `at`. */
  noteCheckAttempt(accountId: number, since: number, at = Date.now()): void {
    this.prep(
      `UPDATE account SET cred_check_attempts = cred_check_attempts + 1, cred_check_last = ?
       WHERE id = ? AND cred_check_tag IS NOT NULL AND cred_check_since = ?`,
    ).run(at, accountId, since);
  }

  /**
   * The answer to the check opened at `since`. "accepted": the server still
   * takes the stored credentials, so both are valid; they go back in place
   * and nothing moves. "refused": the new credentials replaced them; the
   * generation moves, sessions made with the new credentials (the check's tag)
   * stay valid, and so do the push subscriptions made since the check opened,
   * because only those sessions were served meanwhile. Returns the row, or
   * undefined when that check is no longer open.
   */
  answerCredentialCheck(accountId: number, since: number, answer: "accepted" | "refused"): AccountRow | undefined {
    const sql =
      answer === "accepted"
        ? `UPDATE account SET vault = cred_check_vault, cred_refusals = 0, cred_first_refusal = 0, ${NO_CHECK}
           WHERE id = ? AND cred_check_tag IS NOT NULL AND cred_check_vault IS NOT NULL AND cred_check_since = ?`
        : `UPDATE account SET cred_gen = cred_gen + 1, cred_rotated_by = cred_check_tag,
             cred_refused = 0, cred_refusals = 0, cred_first_refusal = 0, ${NO_CHECK}
           WHERE id = ? AND cred_check_tag IS NOT NULL AND cred_check_since = ?`;
    if (!this.prep(sql).run(accountId, since).changes) return undefined;
    const row = this.getAccountById(accountId);
    if (row && answer === "refused") {
      this.endOldSubscriptions(row.id, row.cred_gen, since);
      this.credentialListener?.(row.id);
    }
    return row;
  }

  /** Accounts with a check of their stored credentials still open, to resume after a restart. */
  accountsWithOpenCheck(): AccountRow[] {
    return this.prep(`SELECT * FROM account WHERE cred_check_tag IS NOT NULL`).all() as AccountRow[];
  }

  // Told when an account's credential generation moved or its refused mark
  // was cleared, so the server can close what was opened under the old
  // credentials (pooled connections, cached Basic logins) and start the IDLE
  // worker over.
  setCredentialListener(fn: ((accountId: number) => void) | undefined): void {
    this.credentialListener = fn;
  }
  private credentialListener?: (accountId: number) => void;

  /** Remember that a session token was ended, until it would have expired. */
  endSession(tokenHash: string, expiresMs: number): void {
    this.prep(`DELETE FROM ended_session WHERE expires <= ?`).run(Date.now());
    this.prep(`INSERT OR REPLACE INTO ended_session(token_hash, expires) VALUES(?,?)`).run(tokenHash, expiresMs);
  }

  isSessionEnded(tokenHash: string): boolean {
    return this.prep(`SELECT 1 FROM ended_session WHERE token_hash = ?`).get(tokenHash) !== undefined;
  }

  getAccount(slug: string): AccountRow | undefined {
    return this.prep(`SELECT * FROM account WHERE slug = ?`).get(slug) as AccountRow | undefined;
  }

  getAccountById(id: number): AccountRow | undefined {
    return this.prep(`SELECT * FROM account WHERE id = ?`).get(id) as AccountRow | undefined;
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
    const newState = this.nextState(accountId, kind);
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

  // A state move with no entries behind it (an IDLE arrival, a folder count
  // that moved). The log can no longer account for the period, so drop it:
  // `*/changes` then answers `cannotCalculateChanges` instead of an empty diff
  // that hides the change.
  bumpState(accountId: number, kind: string): number {
    this.changeLog.delete(`${accountId}|${kind}`);
    return this.nextState(accountId, kind);
  }

  private nextState(accountId: number, kind: string): number {
    const row = this.prep(`SELECT state FROM state_log WHERE account_id = ? AND kind = ?`)
      .get(accountId, kind) as { state: number } | undefined;
    const next = (row?.state ?? 0) + 1;
    this.prep(
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
    const row = this.prep(`SELECT state FROM state_log WHERE account_id = ? AND kind = ?`)
      .get(accountId, kind) as { state: number } | undefined;
    return row?.state ?? 0;
  }

  getIdentitySettings(accountId: number): IdentitySettings {
    const row = this.prep(
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

  // -- blob cache ---------------------------------------------------------
  //
  // Email-backed blob bodies keyed by their blobId. A blobId encodes
  // (mailbox, uidvalidity, uid, partId), and IMAP guarantees the bytes behind
  // that tuple never change, so a hit is always current -- `expires` bounds
  // disk use, not correctness. Re-opening a message with inline images is the
  // case this exists for: the same few parts are fetched over and over.

  getCachedBlob(id: string, accountId: number): { ctype: string | null; body: Buffer } | null {
    const row = this.prep(`SELECT ctype, body FROM blob_cache WHERE id = ? AND account_id = ? AND expires > ?`)
      .get(id, accountId, Date.now()) as { ctype: string | null; body: Buffer } | undefined;
    return row ?? null;
  }

  putCachedBlob(p: {
    id: string;
    accountId: number;
    ctype: string | null;
    body: Buffer;
    ttlMs: number;
  }): void {
    this.prep(
        `INSERT INTO blob_cache(id, account_id, ctype, size, body, expires)
         VALUES(?,?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET ctype=excluded.ctype, size=excluded.size,
                                       body=excluded.body, expires=excluded.expires`,
      )
      .run(p.id, p.accountId, p.ctype, p.body.length, p.body, Date.now() + p.ttlMs);
  }

  /** Drop expired blobs, and the oldest rows once the cache exceeds `maxBytes`. */
  pruneBlobCache(maxBytes: number): void {
    this.prep(`DELETE FROM blob_cache WHERE expires <= ?`).run(Date.now());
    const total = (
      this.prep(`SELECT COALESCE(SUM(size), 0) AS n FROM blob_cache`).get() as { n: number }
    ).n;
    if (total <= maxBytes) return;
    // Evict soonest-to-expire first; for a fixed TTL that is insertion order.
    this.prep(
        `DELETE FROM blob_cache WHERE id IN (
           SELECT id FROM blob_cache ORDER BY expires ASC
           LIMIT MAX(1, (SELECT COUNT(*) FROM blob_cache) / 4)
         )`,
      )
      .run();
  }

  putUpload(p: { id: string; accountId: number; ctype: string; body: Buffer }): void {
    this.prep(
        `INSERT INTO upload(id, account_id, ctype, size, body, created_at)
         VALUES(?,?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET ctype=excluded.ctype, size=excluded.size, body=excluded.body, created_at=excluded.created_at`,
      )
      .run(p.id, p.accountId, p.ctype, p.body.length, p.body, Date.now());
  }

  /** Bytes of uploads the account has stored now. */
  uploadBytes(accountId: number): number {
    return (
      this.prep(`SELECT COALESCE(SUM(size), 0) AS n FROM upload WHERE account_id = ?`).get(accountId) as { n: number }
    ).n;
  }

  getUpload(id: string, accountId: number): { ctype: string; body: Buffer } | null {
    const row = this.prep(`SELECT ctype, body FROM upload WHERE id = ? AND account_id = ?`)
      .get(id, accountId) as { ctype: string; body: Buffer } | undefined;
    return row ?? null;
  }

  // Drop uploads older than `olderThanMs` to keep the SQLite file from growing
  // unboundedly. Called opportunistically from the upload route; not on a
  // timer (we don't want a background loop in this process yet).
  pruneUploads(olderThanMs: number): void {
    const cutoff = Date.now() - olderThanMs;
    this.prep(`DELETE FROM upload WHERE created_at < ?`).run(cutoff);
  }

  // Update the cached path/parent for a mailbox after an IMAP RENAME. The
  // listMailboxes upsert deliberately does not touch (name, parent_id) on
  // conflict — it can't tell a rename from a name reuse — so callers that
  // know they renamed must announce it here.
  updateMailboxPath(accountId: number, mailboxId: number, newName: string, newParentId: number | null): void {
    this.prep(`UPDATE mailbox SET name = ?, parent_id = ? WHERE id = ? AND account_id = ?`)
      .run(newName, newParentId, mailboxId, accountId);
  }

  putMailboxSortOrder(accountId: number, mailboxId: number, sortOrder: number): void {
    this.prep(
        `INSERT INTO mailbox_sort_order(account_id, mailbox_id, sort_order)
         VALUES(?,?,?)
         ON CONFLICT(account_id, mailbox_id) DO UPDATE SET sort_order = excluded.sort_order`,
      )
      .run(accountId, mailboxId, sortOrder);
  }

  getMailboxSortOrders(accountId: number): Map<number, number> {
    const rows = this.prep(`SELECT mailbox_id, sort_order FROM mailbox_sort_order WHERE account_id = ?`)
      .all(accountId) as { mailbox_id: number; sort_order: number }[];
    return new Map(rows.map((r) => [r.mailbox_id, r.sort_order]));
  }

  // A subscription belongs to the account's credential generation when it is
  // made, and ends when that generation moves (see endOldSubscriptions).
  insertPushSubscription(row: PushSubscriptionRow): void {
    this.prep(
        `INSERT INTO push_subscription(
           id, account_id, device_client_id, url, types,
           expires, verification_code, verified, created_at, last_push_at, cred_gen
         ) VALUES(?,?,?,?,?,?,?,?,?,?, COALESCE((SELECT cred_gen FROM account WHERE id = ?), 0))`,
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
        row.accountId,
      );
  }

  /**
   * The account's credential generation moved to `gen`: its push
   * subscriptions made under an older one end. Those made since `keepSince`
   * (epoch ms) belong to the sign-in that moved it and move along.
   */
  private endOldSubscriptions(accountId: number, gen: number, keepSince?: number): void {
    if (keepSince !== undefined) {
      this.prep(
        `UPDATE push_subscription SET cred_gen = ? WHERE account_id = ? AND cred_gen = ? AND created_at >= ?`,
      ).run(gen, accountId, gen - 1, keepSince);
    }
    this.prep(`DELETE FROM push_subscription WHERE account_id = ? AND cred_gen < ?`).run(accountId, gen);
  }

  getPushSubscription(id: string, accountId: number): PushSubscriptionRow | null {
    const r = this.prep(`SELECT * FROM push_subscription WHERE id = ? AND account_id = ?`)
      .get(id, accountId) as PushRowRaw | undefined;
    return r ? rowToPushSub(r) : null;
  }

  listPushSubscriptions(accountId: number): PushSubscriptionRow[] {
    const rows = this.prep(`SELECT * FROM push_subscription WHERE account_id = ? ORDER BY created_at`)
      .all(accountId) as PushRowRaw[];
    return rows.map(rowToPushSub);
  }

  // Returns subs that should currently be receiving StateChange POSTs:
  // verified, not expired, with a non-empty types filter. The dispatcher uses
  // this on every fan-out so a freshly destroyed/expired sub stops receiving
  // mid-flight without needing an explicit cache invalidation. While a check
  // of the stored credentials is open, subscriptions made before it get
  // nothing: they belong to sessions the check holds. They deliver again when
  // it ends "accepted" and are deleted when it ends "refused".
  activePushSubscriptions(accountId: number): PushSubscriptionRow[] {
    const now = Date.now();
    const rows = this.prep(
        `SELECT p.* FROM push_subscription p
         JOIN account a ON a.id = p.account_id
         WHERE p.account_id = ? AND p.verified = 1
         AND (p.expires IS NULL OR p.expires > ?)
         AND (a.cred_check_tag IS NULL OR p.created_at >= a.cred_check_since)`,
      )
      .all(accountId, now) as PushRowRaw[];
    return rows.map(rowToPushSub);
  }

  // Distinct list of accounts that need an IDLE worker right now. Used by the
  // PushIdleManager on startup and after every PushSubscription/set mutation
  // to recompute who needs a connection held open. An account whose stored
  // credentials the mail server refused gets none until a login succeeds.
  accountsWithActivePushSubs(): number[] {
    const now = Date.now();
    const rows = this.prep(
        `SELECT DISTINCT p.account_id FROM push_subscription p
         JOIN account a ON a.id = p.account_id
         WHERE p.verified = 1 AND (p.expires IS NULL OR p.expires > ?) AND a.cred_refused = 0`,
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
    const res = this.prep(`UPDATE push_subscription SET ${fields.join(", ")} WHERE id = ? AND account_id = ?`)
      .run(...values);
    return res.changes > 0;
  }

  destroyPushSubscription(id: string, accountId: number): boolean {
    const res = this.prep(`DELETE FROM push_subscription WHERE id = ? AND account_id = ?`)
      .run(id, accountId);
    return res.changes > 0;
  }

  // Subscriptions older than ~90 days that never authenticated their
  // verification code are abandoned client attempts; drop them so the table
  // doesn't grow unboundedly. Active verified subs are untouched.
  pruneStalePushSubscriptions(maxUnverifiedAgeMs: number): void {
    const cutoff = Date.now() - maxUnverifiedAgeMs;
    this.prep(`DELETE FROM push_subscription WHERE verified = 0 AND created_at < ?`)
      .run(cutoff);
  }

  // --- email_cache -----------------------------------------------------

  // SQLite caps bound parameters (999 in older builds); chunk IN lists.
  private static readonly IN_CHUNK = 500;

  getEmailCacheRows(
    accountId: number,
    mailboxId: number,
    uidvalidity: number,
    uids: number[],
  ): Map<number, EmailCacheRow> {
    const out = new Map<number, EmailCacheRow>();
    for (let i = 0; i < uids.length; i += Store.IN_CHUNK) {
      const chunk = uids.slice(i, i + Store.IN_CHUNK);
      const rows = this.prep(
          `SELECT * FROM email_cache
           WHERE account_id = ? AND mailbox_id = ? AND uidvalidity = ?
           AND uid IN (${chunk.map(() => "?").join(",")})`,
        )
        .all(accountId, mailboxId, uidvalidity, ...chunk) as EmailCacheRow[];
      for (const r of rows) out.set(r.uid, r);
    }
    return out;
  }

  // Upsert semantics: a minimal row (thread scan) must never null out a full
  // row (Email/get) and vice versa, so every nullable column keeps whichever
  // side has data — incoming value wins when non-null.
  upsertEmailCacheRows(rows: EmailCacheUpsert[]): void {
    if (rows.length === 0) return;
    const stmt = this.prep(
      `INSERT INTO email_cache(
         account_id, mailbox_id, uidvalidity, uid, thread_id, internaldate,
         size, envelope, bodystructure, headers_raw, headers_full, preview, created_at
       ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(account_id, mailbox_id, uid) DO UPDATE SET
         uidvalidity   = excluded.uidvalidity,
         thread_id     = COALESCE(excluded.thread_id, thread_id),
         internaldate  = MAX(excluded.internaldate, internaldate),
         size          = COALESCE(excluded.size, size),
         envelope      = COALESCE(excluded.envelope, envelope),
         bodystructure = COALESCE(excluded.bodystructure, bodystructure),
         headers_raw   = CASE WHEN excluded.headers_full >= headers_full AND excluded.headers_raw IS NOT NULL
                              THEN excluded.headers_raw ELSE headers_raw END,
         headers_full  = MAX(excluded.headers_full, headers_full),
         preview       = COALESCE(excluded.preview, preview)`,
    );
    const now = Date.now();
    const txn = this.db.transaction((items: EmailCacheUpsert[]) => {
      for (const r of items) {
        stmt.run(
          r.accountId, r.mailboxId, r.uidvalidity, r.uid,
          r.threadId ?? null, r.internaldate ?? 0, r.size ?? null,
          r.envelope ?? null, r.bodystructure ?? null, r.headersRaw ?? null,
          r.headersFull ? 1 : 0, r.preview ?? null, now,
        );
      }
    });
    txn(rows);
  }

  setEmailCachePreview(accountId: number, mailboxId: number, uid: number, preview: string): void {
    this.prep(`UPDATE email_cache SET preview = ? WHERE account_id = ? AND mailbox_id = ? AND uid = ?`)
      .run(preview, accountId, mailboxId, uid);
  }

  // uidvalidity rolled: every cached row for the folder is garbage.
  purgeEmailCacheMailbox(accountId: number, mailboxId: number): void {
    this.prep(`DELETE FROM email_cache WHERE account_id = ? AND mailbox_id = ?`)
      .run(accountId, mailboxId);
    this.prep(`DELETE FROM mailbox_scan WHERE account_id = ? AND mailbox_id = ?`)
      .run(accountId, mailboxId);
  }

  getEmailCacheUids(accountId: number, mailboxId: number): number[] {
    const rows = this.prep(`SELECT uid FROM email_cache WHERE account_id = ? AND mailbox_id = ?`)
      .all(accountId, mailboxId) as { uid: number }[];
    return rows.map((r) => r.uid);
  }

  deleteEmailCacheUids(accountId: number, mailboxId: number, uids: number[]): void {
    if (uids.length === 0) return;
    const txn = this.db.transaction((all: number[]) => {
      for (let i = 0; i < all.length; i += Store.IN_CHUNK) {
        const chunk = all.slice(i, i + Store.IN_CHUNK);
        this.prep(
            `DELETE FROM email_cache WHERE account_id = ? AND mailbox_id = ?
             AND uid IN (${chunk.map(() => "?").join(",")})`,
          )
          .run(accountId, mailboxId, ...chunk);
      }
    });
    txn(uids);
  }

  // Everything the thread index needs, account-wide, ordered by receivedAt
  // ascending (the RFC 8621 §3 thread member order).
  getThreadIndexRows(accountId: number): ThreadIndexRow[] {
    return this.prep(
        `SELECT mailbox_id, uidvalidity, uid, thread_id, internaldate
         FROM email_cache WHERE account_id = ? AND thread_id IS NOT NULL
         ORDER BY internaldate ASC, uid ASC`,
      )
      .all(accountId) as ThreadIndexRow[];
  }

  getMailboxScan(accountId: number, mailboxId: number): MailboxScanRow | undefined {
    return this.prep(`SELECT * FROM mailbox_scan WHERE account_id = ? AND mailbox_id = ?`)
      .get(accountId, mailboxId) as MailboxScanRow | undefined;
  }

  putMailboxScan(row: MailboxScanRow): void {
    this.prep(
        `INSERT INTO mailbox_scan(account_id, mailbox_id, uidvalidity, uidnext, messages, scanned_at)
         VALUES(?,?,?,?,?,?)
         ON CONFLICT(account_id, mailbox_id) DO UPDATE SET
           uidvalidity = excluded.uidvalidity, uidnext = excluded.uidnext,
           messages = excluded.messages, scanned_at = excluded.scanned_at`,
      )
      .run(row.account_id, row.mailbox_id, row.uidvalidity, row.uidnext, row.messages, row.scanned_at);
  }

  putIdentitySettings(accountId: number, s: IdentitySettings): void {
    const replyJson = s.replyTo ? JSON.stringify(s.replyTo) : null;
    this.prep(
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

export interface EmailCacheRow {
  account_id: number;
  mailbox_id: number;
  uidvalidity: number;
  uid: number;
  thread_id: string | null;
  internaldate: number;
  size: number | null;
  envelope: string | null;
  bodystructure: string | null;
  headers_raw: Buffer | null;
  headers_full: number;
  preview: string | null;
  created_at: number;
}

export interface EmailCacheUpsert {
  accountId: number;
  mailboxId: number;
  uidvalidity: number;
  uid: number;
  threadId?: string | null;
  internaldate?: number;
  size?: number | null;
  envelope?: string | null;
  bodystructure?: string | null;
  headersRaw?: Buffer | null;
  headersFull?: boolean;
  preview?: string | null;
}

export interface ThreadIndexRow {
  mailbox_id: number;
  uidvalidity: number;
  uid: number;
  thread_id: string;
  internaldate: number;
}

export interface MailboxScanRow {
  account_id: number;
  mailbox_id: number;
  uidvalidity: number;
  uidnext: number;
  messages: number;
  scanned_at: number;
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
