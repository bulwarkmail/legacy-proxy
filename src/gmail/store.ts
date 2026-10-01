import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import Database from "better-sqlite3";
import {
  openCredentials,
  seal,
  sealCredentials,
  unseal,
  type Credentials,
} from "../auth/credentials.js";
import type { EmailPushConfig } from "./emailpush.js";

export interface GmailProfile {
  emailAddress: string;
  messagesTotal: number;
  threadsTotal: number;
  historyId: string;
}
export interface GmailLabel {
  id: string;
  name: string;
  type: string;
  /** Only `labels.get` reports it, and only for labels the user has coloured. */
  color?: { textColor?: string; backgroundColor?: string };
  messagesTotal?: number;
  messagesUnread?: number;
  threadsTotal?: number;
  threadsUnread?: number;
}
export interface GmailSnapshot {
  profile: GmailProfile;
  labels: GmailLabel[];
}

/** Gmail backend state (grants, bridge passwords, cache, drafts, queues), kept apart from the legacy IMAP account rows. */
export class GmailStore {
  private readonly db: Database.Database;
  constructor(
    dataDir: string,
    private readonly vaultKey: Buffer,
    /** Logical bytes of cached Gmail data kept per account. */
    private readonly cacheLimit = 256 * 1024 * 1024,
  ) {
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    const file = path.join(dataDir, "gmail.sqlite3");
    // Set permissions before SQLite opens WAL/SHM sidecars.
    fs.closeSync(fs.openSync(file, "a", 0o600));
    fs.chmodSync(file, 0o600);
    this.db = new Database(file);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS gmail_cursor (email TEXT PRIMARY KEY, history TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS gmail_mailbox_snapshot (email TEXT NOT NULL,state TEXT NOT NULL,value TEXT NOT NULL,PRIMARY KEY(email,state));
      CREATE TABLE IF NOT EXISTS gmail_upload (email TEXT NOT NULL,id TEXT NOT NULL,body BLOB NOT NULL,type TEXT NOT NULL,expires INTEGER NOT NULL,PRIMARY KEY(email,id));
      CREATE TABLE IF NOT EXISTS gmail_draft (email TEXT NOT NULL,original TEXT NOT NULL,current TEXT NOT NULL,draft TEXT NOT NULL,PRIMARY KEY(email,original));
      CREATE INDEX IF NOT EXISTS gmail_draft_current ON gmail_draft(email,current);
      CREATE TABLE IF NOT EXISTS gmail_submission (email TEXT NOT NULL,original TEXT NOT NULL,id TEXT NOT NULL,fingerprint TEXT NOT NULL,result TEXT,PRIMARY KEY(email,original));
      CREATE TABLE IF NOT EXISTS gmail_revision (email TEXT PRIMARY KEY, revision INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS gmail_schedule (
        id TEXT PRIMARY KEY, email TEXT NOT NULL, original TEXT NOT NULL, identity TEXT NOT NULL, thread TEXT NOT NULL,
        envelope TEXT NOT NULL, raw_hash TEXT NOT NULL, send_at INTEGER NOT NULL, status TEXT NOT NULL, reason TEXT,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS gmail_schedule_due ON gmail_schedule(status,send_at);
      CREATE TABLE IF NOT EXISTS gmail_watch (email TEXT PRIMARY KEY, expiration INTEGER NOT NULL, history TEXT NOT NULL, renewed_at INTEGER NOT NULL, failures INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS gmail_push (email TEXT PRIMARY KEY, history TEXT NOT NULL, received_at INTEGER NOT NULL, count INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS gmail_push_sub (
        id TEXT PRIMARY KEY, email TEXT NOT NULL, device TEXT, url TEXT NOT NULL, types TEXT,
        expires INTEGER NOT NULL, code TEXT, verified INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL, failures INTEGER NOT NULL DEFAULT 0, email_push TEXT
      );
      CREATE INDEX IF NOT EXISTS gmail_push_sub_email ON gmail_push_sub(email);
      CREATE TABLE IF NOT EXISTS gmail_password (email TEXT PRIMARY KEY, hash TEXT NOT NULL UNIQUE);
      CREATE TABLE IF NOT EXISTS gmail_token (
        hash TEXT PRIMARY KEY, email TEXT NOT NULL, client TEXT NOT NULL, kind TEXT NOT NULL,
        parent TEXT, expires INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS gmail_token_email ON gmail_token(email);
      CREATE INDEX IF NOT EXISTS gmail_token_parent ON gmail_token(parent);
      CREATE TABLE IF NOT EXISTS gmail_cache (
        email TEXT NOT NULL, key TEXT NOT NULL, value BLOB NOT NULL,
        expires INTEGER NOT NULL, touched INTEGER NOT NULL, size INTEGER NOT NULL,
        PRIMARY KEY(email, key)
      );
      CREATE INDEX IF NOT EXISTS gmail_cache_expires ON gmail_cache(expires);
      CREATE INDEX IF NOT EXISTS gmail_cache_touched ON gmail_cache(email, touched);
      CREATE TABLE IF NOT EXISTS gmail_connection (
        email TEXT PRIMARY KEY,
        vault BLOB NOT NULL,
        snapshot TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
    // Cached mail used to be stored as plain JSON. Those rows cannot be read
    // back now that entries are sealed, and a cache is by definition
    // reconstructible: drop them rather than carry a decoder for them.
    // A subscription made before emailPush existed simply has none: add the
    // column and leave every row as it was.
    const subColumns = this.db
      .prepare("PRAGMA table_info(gmail_push_sub)")
      .all() as { name: string }[];
    if (!subColumns.some((c) => c.name === "email_push"))
      this.db.exec("ALTER TABLE gmail_push_sub ADD COLUMN email_push TEXT");
    const columns = this.db
      .prepare("PRAGMA table_info(gmail_cache)")
      .all() as { name: string; type: string }[];
    if (columns.some((c) => c.name === "value" && c.type !== "BLOB")) {
      this.db.exec(`
        DROP TABLE gmail_cache;
        CREATE TABLE gmail_cache (
          email TEXT NOT NULL, key TEXT NOT NULL, value BLOB NOT NULL,
          expires INTEGER NOT NULL, touched INTEGER NOT NULL, size INTEGER NOT NULL,
          PRIMARY KEY(email, key)
        );
        CREATE INDEX gmail_cache_expires ON gmail_cache(expires);
        CREATE INDEX gmail_cache_touched ON gmail_cache(email, touched);
      `);
    }
  }
  async save(
    email: string,
    credentials: Credentials,
    snapshot: GmailSnapshot,
  ): Promise<void> {
    const vault = await sealCredentials(this.vaultKey, credentials);
    this.db
      .prepare(
        `INSERT INTO gmail_connection (email, vault, snapshot, updated_at)
      VALUES (?, ?, ?, ?) ON CONFLICT(email) DO UPDATE SET
      vault=excluded.vault, snapshot=excluded.snapshot, updated_at=excluded.updated_at`,
      )
      .run(email, vault, JSON.stringify(snapshot), Date.now());
  }
  async load(
    email: string,
  ): Promise<{ credentials: Credentials; snapshot: GmailSnapshot } | null> {
    const row = this.db
      .prepare("SELECT vault, snapshot FROM gmail_connection WHERE email=?")
      .get(email) as { vault: Buffer; snapshot: string } | undefined;
    if (!row) return null;
    return {
      credentials: await openCredentials(this.vaultKey, row.vault),
      snapshot: JSON.parse(row.snapshot),
    };
  }
  connectedEmails(): string[] {
    return (
      this.db
        .prepare("SELECT email FROM gmail_connection ORDER BY email")
        .all() as { email: string }[]
    ).map((r) => r.email);
  }
  hasConnection(email: string): boolean {
    return !!this.db
      .prepare("SELECT 1 FROM gmail_connection WHERE email=?")
      .get(email);
  }
  issuePassword(email: string): string {
    if (!this.hasConnection(email)) throw new Error("Account is not connected");
    const password = "gmap_" + crypto.randomBytes(32).toString("base64url");
    this.db
      .prepare(
        "INSERT INTO gmail_password(email,hash) VALUES (?,?) ON CONFLICT(email) DO UPDATE SET hash=excluded.hash",
      )
      .run(email, crypto.createHash("sha256").update(password).digest("hex"));
    return password;
  }
  hasPassword(email: string): boolean {
    return !!this.db
      .prepare("SELECT 1 FROM gmail_password WHERE email=?")
      .get(email);
  }
  authenticate(password: string, username?: string): string | null {
    if (!/^gmap_[A-Za-z0-9_-]{43}$/.test(password)) return null;
    const hash = crypto.createHash("sha256").update(password).digest("hex");
    const row = this.db
      .prepare("SELECT email FROM gmail_password WHERE hash=?")
      .get(hash) as { email: string } | undefined;
    return row && (!username || row.email === username.toLowerCase())
      ? row.email
      : null;
  }
  /**
   * Signs a client in for an account: a refresh token that lives as long as it keeps being used, and a
   * short-lived access token under it. Only hashes are stored, so a copy of the database signs nobody in.
   */
  issueTokens(email: string, client: string, now = Date.now()): IssuedTokens {
    if (!this.hasConnection(email)) throw new Error("Account is not connected");
    const refresh = TOKEN_PREFIX.refresh + crypto.randomBytes(32).toString("base64url");
    this.db
      .prepare("INSERT INTO gmail_token(hash,email,client,kind,parent,expires) VALUES (?,?,?,'refresh',NULL,?)")
      .run(tokenHash(refresh), email, client, now + REFRESH_TOKEN_TTL);
    return { ...this.accessUnder(tokenHash(refresh), email, client, now), refreshToken: refresh };
  }
  /** A new access token for a refresh token of this client; the refresh token's lifetime starts over. */
  refreshTokens(refreshToken: string, client: string, now = Date.now()): IssuedTokens | null {
    if (!TOKEN_RE.refresh.test(refreshToken)) return null;
    const hash = tokenHash(refreshToken);
    const row = this.db
      .prepare("SELECT email,client,expires FROM gmail_token WHERE hash=? AND kind='refresh'")
      .get(hash) as { email: string; client: string; expires: number } | undefined;
    if (!row || row.client !== client || row.expires <= now || !this.hasConnection(row.email)) return null;
    this.db.prepare("UPDATE gmail_token SET expires=? WHERE hash=?").run(now + REFRESH_TOKEN_TTL, hash);
    return { ...this.accessUnder(hash, row.email, client, now), refreshToken };
  }
  private accessUnder(parent: string, email: string, client: string, now: number) {
    const access = TOKEN_PREFIX.access + crypto.randomBytes(32).toString("base64url");
    this.db.transaction(() => {
      this.db.prepare("DELETE FROM gmail_token WHERE expires<=?").run(now);
      this.db
        .prepare("INSERT INTO gmail_token(hash,email,client,kind,parent,expires) VALUES (?,?,?,'access',?,?)")
        .run(tokenHash(access), email, client, parent, now + ACCESS_TOKEN_TTL);
    })();
    return { email, accessToken: access, expiresIn: ACCESS_TOKEN_TTL / 1000 };
  }
  /** The account an access token signs in, while it is valid. */
  authenticateToken(accessToken: string, now = Date.now()): string | null {
    if (!TOKEN_RE.access.test(accessToken)) return null;
    const row = this.db
      .prepare("SELECT email,expires FROM gmail_token WHERE hash=? AND kind='access'")
      .get(tokenHash(accessToken)) as { email: string; expires: number } | undefined;
    return row && row.expires > now ? row.email : null;
  }
  /** Revokes a token issued to this client; revoking a refresh token also ends the access tokens under it. */
  revokeToken(token: string, client: string): void {
    const hash = tokenHash(token);
    this.db.transaction(() => {
      const row = this.db.prepare("SELECT client FROM gmail_token WHERE hash=?").get(hash) as
        | { client: string }
        | undefined;
      if (!row || row.client !== client) return;
      this.db.prepare("DELETE FROM gmail_token WHERE hash=? OR parent=?").run(hash, hash);
    })();
  }
  async updateCredentials(
    email: string,
    credentials: Credentials,
    expectedRefreshToken?: string,
    snapshot?: GmailSnapshot,
  ): Promise<void> {
    const row = this.db
      .prepare("SELECT vault FROM gmail_connection WHERE email=?")
      .get(email) as { vault: Buffer } | undefined;
    if (!row) return;
    const old = await openCredentials(this.vaultKey, row.vault);
    if (
      old.refreshToken !== expectedRefreshToken ||
      (snapshot === undefined &&
        old.accessToken === credentials.accessToken &&
        old.expiresAt === credentials.expiresAt)
    )
      return;
    const vault = await sealCredentials(this.vaultKey, {
      ...credentials,
      scopes: old.scopes,
    });
    this.db
      .prepare(
        "UPDATE gmail_connection SET vault=?,snapshot=COALESCE(?,snapshot) WHERE email=? AND vault=?",
      )
      .run(vault, snapshot ? JSON.stringify(snapshot) : null, email, row.vault);
  }
  revision(email: string): number {
    return (
      (
        this.db
          .prepare("SELECT revision FROM gmail_revision WHERE email=?")
          .get(email) as { revision: number } | undefined
      )?.revision ?? 0
    );
  }
  invalidate(email: string): void {
    this.db.transaction(() => {
      this.db
        .prepare(
          "INSERT INTO gmail_revision(email,revision) VALUES(?,1) ON CONFLICT(email) DO UPDATE SET revision=revision+1",
        )
        .run(email);
      this.db.prepare("DELETE FROM gmail_cache WHERE email=?").run(email);
    })();
  }
  cursor(email: string): string | null {
    return (
      (
        this.db
          .prepare("SELECT history FROM gmail_cursor WHERE email=?")
          .get(email) as { history: string } | undefined
      )?.history ?? null
    );
  }
  checkpoint(
    email: string,
    history: string,
    messages: string[],
    threads: string[],
    reset = false,
  ): void {
    this.db.transaction(() => {
      const previous = this.cursor(email);
      if (previous && BigInt(previous) >= BigInt(history)) return;
      if (reset) this.invalidate(email);
      else if (messages.length || threads.length) {
        this.db
          .prepare(
            "INSERT INTO gmail_revision(email,revision) VALUES(?,1) ON CONFLICT(email) DO UPDATE SET revision=revision+1",
          )
          .run(email);
        this.db
          .prepare(
            "DELETE FROM gmail_cache WHERE email=? AND (key LIKE 'page:%' OR key LIKE 'query:%' OR key LIKE 'labels:%')",
          )
          .run(email);
        const del = this.db.prepare(
          "DELETE FROM gmail_cache WHERE email=? AND key=?",
        );
        for (const id of messages) {
          del.run(email, "message:v2:" + id);
          del.run(email, "meta:v2:" + id);
        }
        for (const id of threads) del.run(email, "thread:v2:t_" + id);
      }
      this.db
        .prepare(
          "INSERT INTO gmail_cursor VALUES(?,?) ON CONFLICT(email) DO UPDATE SET history=excluded.history",
        )
        .run(email, history);
    })();
  }
  mailboxSnapshot(
    email: string,
    state: string,
    value?: Record<string, string>,
  ): Record<string, string> | null {
    if (value) {
      this.db
        .prepare("INSERT OR IGNORE INTO gmail_mailbox_snapshot VALUES(?,?,?)")
        .run(email, state, JSON.stringify(value));
      this.db
        .prepare(
          "DELETE FROM gmail_mailbox_snapshot WHERE email=? AND rowid NOT IN (SELECT rowid FROM gmail_mailbox_snapshot WHERE email=? ORDER BY rowid DESC LIMIT 32)",
        )
        .run(email, email);
    }
    const row = this.db
      .prepare(
        "SELECT value FROM gmail_mailbox_snapshot WHERE email=? AND state=?",
      )
      .get(email, state) as { value: string } | undefined;
    return row ? JSON.parse(row.value) : null;
  }
  private lastSweep = 0;
  cached<T>(email: string, key: string): T | null {
    const now = Date.now();
    const row = this.db
      .prepare(
        "SELECT value,touched FROM gmail_cache WHERE email=? AND key=? AND expires>?",
      )
      .get(email, key, now) as { value: Buffer; touched: number } | undefined;
    if (!row) return null;
    let value: T;
    try {
      value = JSON.parse(unseal(this.vaultKey, row.value).toString("utf8")) as T;
    } catch {
      // A row this key cannot open is unreadable for good: drop it and let the
      // caller fetch the data again.
      this.db
        .prepare("DELETE FROM gmail_cache WHERE email=? AND key=?")
        .run(email, key);
      return null;
    }
    // Recency only orders eviction: refresh it at most once a minute instead of writing on every read.
    if (now - row.touched > 60_000)
      this.db
        .prepare("UPDATE gmail_cache SET touched=? WHERE email=? AND key=?")
        .run(now, email, key);
    return value;
  }
  /**
   * Caches one entry, encrypted under the vault key.
   *
   * What passes through here is mail - subjects, senders, bodies - kept on
   * disk for as long as its entry lives, which is long enough to be worth
   * treating like the credentials next to it. AES-GCM on a few hundred bytes
   * costs microseconds against the network round trip it saves.
   */
  cache(email: string, key: string, data: unknown, ttl: number): void {
    const value = seal(this.vaultKey, Buffer.from(JSON.stringify(data), "utf8"));
    const size = value.length;
    if (size > 16 * 1024 * 1024) return;
    const now = Date.now();
    this.db.transaction(() => {
      // Sweep expired rows at most once a minute rather than on every write.
      if (now - this.lastSweep > 60_000) {
        this.lastSweep = now;
        this.db.prepare("DELETE FROM gmail_cache WHERE expires<=?").run(now);
      }
      this.db
        .prepare(
          `INSERT INTO gmail_cache(email,key,value,expires,touched,size) VALUES(?,?,?,?,?,?)
        ON CONFLICT(email,key) DO UPDATE SET value=excluded.value,expires=excluded.expires,touched=excluded.touched,size=excluded.size`,
        )
        .run(email, key, value, now + ttl, now, size);
      let total = (
        this.db
          .prepare(
            "SELECT COALESCE(SUM(size),0) AS n FROM gmail_cache WHERE email=?",
          )
          .get(email) as {
          n: number;
        }
      ).n;
      // Only an account over budget pays for finding eviction candidates, oldest first, in small batches.
      while (total > this.cacheLimit) {
        const oldest = this.db
          .prepare(
            "SELECT key,size FROM gmail_cache WHERE email=? ORDER BY touched LIMIT 64",
          )
          .all(email) as { key: string; size: number }[];
        if (!oldest.length) break;
        for (const row of oldest) {
          if (total <= this.cacheLimit) break;
          this.db
            .prepare("DELETE FROM gmail_cache WHERE email=? AND key=?")
            .run(email, row.key);
          total -= row.size;
        }
      }
    })();
  }
  upload(email: string, body: Buffer, type: string): string {
    const id = "gu_" + crypto.randomBytes(24).toString("base64url");
    this.db.transaction(() => {
      this.db
        .prepare("DELETE FROM gmail_upload WHERE expires<=?")
        .run(Date.now());
      const total = (
        this.db
          .prepare(
            "SELECT COALESCE(SUM(length(body)),0) AS n FROM gmail_upload WHERE email=?",
          )
          .get(email) as { n: number }
      ).n;
      if (body.length > 25_000_000 || total + body.length > 100_000_000)
        throw new Error("Upload quota exceeded");
      this.db
        .prepare("INSERT INTO gmail_upload VALUES(?,?,?,?,?)")
        .run(email, id, body, type, Date.now() + 24 * 60 * 60_000);
    })();
    return id;
  }
  uploaded(email: string, id: string): { body: Buffer; type: string } | null {
    return (
      (this.db
        .prepare(
          "SELECT body,type FROM gmail_upload WHERE email=? AND id=? AND expires>?",
        )
        .get(email, id, Date.now()) as
        { body: Buffer; type: string } | undefined) ?? null
    );
  }
  rememberDraft(
    email: string,
    original: string,
    draft: string,
    current = original,
  ): void {
    this.db
      .prepare(
        "INSERT INTO gmail_draft VALUES(?,?,?,?) ON CONFLICT(email,original) DO UPDATE SET current=excluded.current,draft=excluded.draft",
      )
      .run(email, original, current, draft);
  }
  draft(
    email: string,
    original: string,
  ): { current: string; draft: string } | null {
    return (
      (this.db
        .prepare(
          "SELECT current,draft FROM gmail_draft WHERE email=? AND original=?",
        )
        .get(email, original) as
        { current: string; draft: string } | undefined) ?? null
    );
  }
  originalId(email: string, current: string): string {
    return (
      (
        this.db
          .prepare(
            "SELECT original FROM gmail_draft WHERE email=? AND current=?",
          )
          .get(email, current) as { original: string } | undefined
      )?.original ?? current
    );
  }
  upstreamId(email: string, original: string): string {
    return this.draft(email, original)?.current ?? original;
  }
  /** Drops the id mapping of a discarded draft; sent drafts keep theirs so their JMAP id stays stable. */
  forgetDraft(email: string, original: string): void {
    this.db
      .prepare(
        "DELETE FROM gmail_draft WHERE email=? AND original=? AND current=original",
      )
      .run(email, original);
  }
  /** Deletes everything stored for an account: grant, bridge password, sign-in tokens, cache, drafts, send ledger and queues. */
  disconnect(email: string): void {
    const tables = [
      "gmail_connection",
      "gmail_password",
      "gmail_token",
      "gmail_cache",
      "gmail_cursor",
      "gmail_revision",
      "gmail_mailbox_snapshot",
      "gmail_upload",
      "gmail_draft",
      "gmail_submission",
      "gmail_schedule",
      "gmail_watch",
      "gmail_push",
    ];
    this.db.transaction(() => {
      for (const table of tables)
        this.db.prepare(`DELETE FROM ${table} WHERE email=?`).run(email);
    })();
  }
  beginSubmission(
    email: string,
    original: string,
    fingerprint: string,
  ): boolean {
    return (
      this.db
        .prepare(
          "INSERT OR IGNORE INTO gmail_submission(email,original,id,fingerprint) VALUES(?,?,?,?)",
        )
        .run(
          email,
          original,
          "gs_" + crypto.randomBytes(16).toString("hex"),
          fingerprint,
        ).changes === 1
    );
  }
  submission(
    email: string,
    original: string,
  ): { id: string; fingerprint: string; result: string | null } | null {
    return (
      (this.db
        .prepare(
          "SELECT id,fingerprint,result FROM gmail_submission WHERE email=? AND original=?",
        )
        .get(email, original) as
        | { id: string; fingerprint: string; result: string | null }
        | undefined) ?? null
    );
  }
  /** Drops an intent whose send provably never happened, so the draft can be sent again. */
  abandonSubmission(email: string, original: string): void {
    this.db
      .prepare(
        "DELETE FROM gmail_submission WHERE email=? AND original=? AND result IS NULL",
      )
      .run(email, original);
  }
  finishSubmission(
    email: string,
    original: string,
    result: unknown,
    current: string,
  ): void {
    this.db.transaction(() => {
      this.db
        .prepare(
          "UPDATE gmail_submission SET result=? WHERE email=? AND original=?",
        )
        .run(JSON.stringify(result), email, original);
      this.db
        .prepare(
          "UPDATE gmail_draft SET current=? WHERE email=? AND original=?",
        )
        .run(current, email, original);
    })();
  }
  submissionResults(email: string): Record<string, unknown>[] {
    return (
      this.db
        .prepare(
          "SELECT result,fingerprint FROM gmail_submission WHERE email=? AND result IS NOT NULL ORDER BY rowid DESC LIMIT 100",
        )
        .all(email) as { result: string; fingerprint: string }[]
    ).map((r) => ({ ...JSON.parse(r.result), fingerprint: r.fingerprint }));
  }
  // ── Delayed send queue ────────────────────────────────────────────
  scheduleCreate(
    row: Omit<
      ScheduleRow,
      "id" | "status" | "reason" | "createdAt" | "updatedAt"
    >,
  ): ScheduleRow {
    const now = Date.now();
    const full: ScheduleRow = {
      ...row,
      id: "gq_" + crypto.randomBytes(16).toString("hex"),
      status: "pending",
      reason: null,
      createdAt: now,
      updatedAt: now,
    };
    this.db
      .prepare(
        "INSERT INTO gmail_schedule(id,email,original,identity,thread,envelope,raw_hash,send_at,status,reason,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
      )
      .run(
        full.id,
        full.email,
        full.original,
        full.identity,
        full.thread,
        JSON.stringify(full.envelope),
        full.rawHash,
        full.sendAt,
        full.status,
        null,
        now,
        now,
      );
    return full;
  }
  schedule(email: string, id: string): ScheduleRow | null {
    const row = this.db
      .prepare("SELECT * FROM gmail_schedule WHERE email=? AND id=?")
      .get(email, id) as RawSchedule | undefined;
    return row ? fromRaw(row) : null;
  }
  schedules(email: string): ScheduleRow[] {
    return (
      this.db
        .prepare(
          "SELECT * FROM gmail_schedule WHERE email=? ORDER BY send_at DESC, rowid DESC LIMIT 500",
        )
        .all(email) as RawSchedule[]
    ).map(fromRaw);
  }
  /** Atomic: only a pending entry can be canceled. Returns the resulting state for error mapping. */
  scheduleCancel(
    email: string,
    id: string,
  ): "done" | "missing" | ScheduleStatus {
    const changes = this.db
      .prepare(
        "UPDATE gmail_schedule SET status='canceled',reason='canceled by client',updated_at=? WHERE email=? AND id=? AND status='pending'",
      )
      .run(Date.now(), email, id).changes;
    if (changes === 1) return "done";
    return this.schedule(email, id)?.status ?? "missing";
  }
  scheduleDueEmails(now: number): string[] {
    return (
      this.db
        .prepare(
          "SELECT DISTINCT email FROM gmail_schedule WHERE status='pending' AND send_at<=?",
        )
        .all(now) as { email: string }[]
    ).map((r) => r.email);
  }
  scheduleDue(email: string, now: number): ScheduleRow[] {
    return (
      this.db
        .prepare(
          "SELECT * FROM gmail_schedule WHERE email=? AND status='pending' AND send_at<=? ORDER BY send_at",
        )
        .all(email, now) as RawSchedule[]
    ).map(fromRaw);
  }
  /** Atomic lease: exactly one worker moves an entry from pending to sending. */
  scheduleLease(id: string): boolean {
    return (
      this.db
        .prepare(
          "UPDATE gmail_schedule SET status='sending',updated_at=? WHERE id=? AND status='pending'",
        )
        .run(Date.now(), id).changes === 1
    );
  }
  scheduleRelease(id: string): void {
    this.db
      .prepare(
        "UPDATE gmail_schedule SET status='pending',updated_at=? WHERE id=? AND status='sending'",
      )
      .run(Date.now(), id);
  }
  scheduleFinish(
    id: string,
    status: Exclude<ScheduleStatus, "pending" | "sending">,
    reason: string | null,
  ): void {
    this.db
      .prepare(
        "UPDATE gmail_schedule SET status=?,reason=?,updated_at=? WHERE id=?",
      )
      .run(status, reason, Date.now(), id);
  }
  /** A process that died mid-send leaves entries in `sending`; only the send ledger knows whether drafts.send was reached. */
  scheduleRecover(): number {
    const rows = this.db
      .prepare("SELECT * FROM gmail_schedule WHERE status='sending'")
      .all() as RawSchedule[];
    for (const row of rows) {
      const ledger = this.submission(row.email, row.original);
      // No intent recorded by this entry: the send never started, so the worker re-checks it (late tolerance applies).
      if (!ledger || ledger.fingerprint !== row.id)
        this.scheduleRelease(row.id);
      else
        this.scheduleFinish(
          row.id,
          ledger.result ? "sent" : "uncertain",
          ledger.result ? null : "process interrupted during send; check Sent",
        );
    }
    return rows.length;
  }
  scheduleStats(): Record<ScheduleStatus, number> {
    const stats: Record<ScheduleStatus, number> = {
      pending: 0,
      sending: 0,
      sent: 0,
      canceled: 0,
      suspended: 0,
      uncertain: 0,
    };
    for (const r of this.db
      .prepare(
        "SELECT status,COUNT(*) AS n FROM gmail_schedule GROUP BY status",
      )
      .all() as { status: ScheduleStatus; n: number }[])
      stats[r.status] = r.n;
    return stats;
  }
  // ── Push (Cloud Pub/Sub) ──────────────────────────────────────────
  watchSave(email: string, expiration: number, history: string): void {
    this.db
      .prepare(
        "INSERT INTO gmail_watch(email,expiration,history,renewed_at,failures) VALUES(?,?,?,?,0) ON CONFLICT(email) DO UPDATE SET expiration=excluded.expiration,history=excluded.history,renewed_at=excluded.renewed_at,failures=0",
      )
      .run(email, expiration, history, Date.now());
  }
  watchFailed(email: string): void {
    this.db
      .prepare(
        "INSERT INTO gmail_watch(email,expiration,history,renewed_at,failures) VALUES(?,0,'',0,1) ON CONFLICT(email) DO UPDATE SET failures=failures+1",
      )
      .run(email);
  }
  watch(
    email: string,
  ): {
    expiration: number;
    history: string;
    renewedAt: number;
    failures: number;
  } | null {
    const r = this.db
      .prepare(
        "SELECT expiration,history,renewed_at AS renewedAt,failures FROM gmail_watch WHERE email=?",
      )
      .get(email) as
      | {
          expiration: number;
          history: string;
          renewedAt: number;
          failures: number;
        }
      | undefined;
    return r ?? null;
  }
  /** Persisted before the notification is acknowledged, so a crash never loses the hint. Returns true when the history id is newer than the last one seen. */
  pushRecord(email: string, history: string): boolean {
    const prev = this.db
      .prepare("SELECT history FROM gmail_push WHERE email=?")
      .get(email) as { history: string } | undefined;
    const newer = !prev || BigInt(history) > BigInt(prev.history);
    this.db
      .prepare(
        "INSERT INTO gmail_push(email,history,received_at,count) VALUES(?,?,?,1) ON CONFLICT(email) DO UPDATE SET history=CASE WHEN ? THEN excluded.history ELSE history END,received_at=excluded.received_at,count=count+1",
      )
      .run(email, history, Date.now(), newer ? 1 : 0);
    return newer;
  }
  // ── Push subscriptions (RFC 8620 §7.2) ────────────────────────────
  /** Expired subscriptions are dropped on read: no client ever sees them and no worker keeps them alive. */
  subscriptions(email: string, now = Date.now()): PushSub[] {
    this.db.prepare("DELETE FROM gmail_push_sub WHERE expires<=?").run(now);
    return (
      this.db
        .prepare(
          "SELECT * FROM gmail_push_sub WHERE email=? ORDER BY created_at",
        )
        .all(email) as RawSub[]
    ).map(fromSub);
  }
  subscription(id: string): PushSub | null {
    const r = this.db
      .prepare("SELECT * FROM gmail_push_sub WHERE id=?")
      .get(id) as RawSub | undefined;
    return r ? fromSub(r) : null;
  }
  subscribe(row: Omit<PushSub, "verified" | "failures">): PushSub {
    this.db
      .prepare(
        "INSERT INTO gmail_push_sub(id,email,device,url,types,expires,code,verified,created_at,failures,email_push) VALUES(?,?,?,?,?,?,?,0,?,0,?)",
      )
      .run(
        row.id,
        row.email,
        row.device,
        row.url,
        row.types ? JSON.stringify(row.types) : null,
        row.expires,
        row.code,
        row.createdAt,
        row.emailPush ? JSON.stringify(row.emailPush) : null,
      );
    return { ...row, verified: false, failures: 0 };
  }
  /** The code is compared by the database in full; a wrong one leaves the subscription unverified. */
  verifySubscription(id: string, code: string): boolean {
    return (
      this.db
        .prepare(
          "UPDATE gmail_push_sub SET verified=1,code=NULL WHERE id=? AND code=? AND verified=0",
        )
        .run(id, code).changes === 1
    );
  }
  updateSubscription(
    id: string,
    patch: {
      expires?: number;
      types?: string[] | null;
      emailPush?: Record<string, EmailPushConfig> | null;
    },
  ): void {
    if (patch.expires !== undefined)
      this.db
        .prepare("UPDATE gmail_push_sub SET expires=? WHERE id=?")
        .run(patch.expires, id);
    if (patch.types !== undefined)
      this.db
        .prepare("UPDATE gmail_push_sub SET types=? WHERE id=?")
        .run(patch.types ? JSON.stringify(patch.types) : null, id);
    if (patch.emailPush !== undefined)
      this.db
        .prepare("UPDATE gmail_push_sub SET email_push=? WHERE id=?")
        .run(patch.emailPush ? JSON.stringify(patch.emailPush) : null, id);
  }
  unsubscribe(id: string, email: string): boolean {
    return (
      this.db
        .prepare("DELETE FROM gmail_push_sub WHERE id=? AND email=?")
        .run(id, email).changes === 1
    );
  }
  /** Returns the failure count after the bump, so the caller can drop a dead endpoint. */
  subscriptionFailed(id: string): number {
    this.db
      .prepare("UPDATE gmail_push_sub SET failures=failures+1 WHERE id=?")
      .run(id);
    return (
      (
        this.db
          .prepare("SELECT failures FROM gmail_push_sub WHERE id=?")
          .get(id) as { failures: number } | undefined
      )?.failures ?? 0
    );
  }
  subscriptionDelivered(id: string): void {
    this.db.prepare("UPDATE gmail_push_sub SET failures=0 WHERE id=?").run(id);
  }
  subscriptionStats(): { subscriptions: number; verified: number } {
    const r = this.db
      .prepare(
        "SELECT COUNT(*) AS n,COALESCE(SUM(verified),0) AS v FROM gmail_push_sub WHERE expires>?",
      )
      .get(Date.now()) as { n: number; v: number };
    return { subscriptions: r.n, verified: r.v };
  }
  pushStats(): {
    watches: number;
    watchFailures: number;
    expiringSoon: number;
    notifications: number;
    lastNotificationAt: number | null;
  } {
    const now = Date.now();
    const w = this.db
      .prepare(
        "SELECT COUNT(*) AS n,COALESCE(SUM(failures),0) AS f,COALESCE(SUM(CASE WHEN expiration<? THEN 1 ELSE 0 END),0) AS soon FROM gmail_watch WHERE expiration>0",
      )
      .get(now + 2 * 86400_000) as { n: number; f: number; soon: number };
    const p = this.db
      .prepare(
        "SELECT COALESCE(SUM(count),0) AS n,MAX(received_at) AS last FROM gmail_push",
      )
      .get() as { n: number; last: number | null };
    return {
      watches: w.n,
      watchFailures: w.f,
      expiringSoon: w.soon,
      notifications: p.n,
      lastNotificationAt: p.last,
    };
  }
  close(): void {
    this.db.close();
  }
}
/** Access tokens are short-lived; a refresh token lasts while it keeps being used. */
const ACCESS_TOKEN_TTL = 3600_000;
const REFRESH_TOKEN_TTL = 180 * 86400_000;
const TOKEN_PREFIX = { access: "gmat_", refresh: "gmrt_" } as const;
const TOKEN_RE = { access: /^gmat_[A-Za-z0-9_-]{43}$/, refresh: /^gmrt_[A-Za-z0-9_-]{43}$/ };
const tokenHash = (token: string) => crypto.createHash("sha256").update(token).digest("hex");
export interface IssuedTokens {
  email: string;
  accessToken: string;
  /** Seconds. */
  expiresIn: number;
  refreshToken: string;
}

export type ScheduleStatus =
  "pending" | "sending" | "sent" | "canceled" | "suspended" | "uncertain";
export interface PushSub {
  id: string;
  email: string;
  device: string | null;
  url: string;
  types: string[] | null;
  expires: number;
  code: string | null;
  verified: boolean;
  createdAt: number;
  failures: number;
  /** draft-ietf-jmap-emailpush: which deliveries to push, and what to say about them. */
  emailPush: Record<string, EmailPushConfig> | null;
}
interface RawSub {
  id: string;
  email: string;
  device: string | null;
  url: string;
  types: string | null;
  expires: number;
  code: string | null;
  verified: number;
  created_at: number;
  failures: number;
  email_push: string | null;
}
const fromSub = (r: RawSub): PushSub => ({
  id: r.id,
  email: r.email,
  device: r.device,
  url: r.url,
  types: r.types ? JSON.parse(r.types) : null,
  expires: r.expires,
  code: r.code,
  verified: !!r.verified,
  createdAt: r.created_at,
  failures: r.failures,
  emailPush: r.email_push ? JSON.parse(r.email_push) : null,
});

export interface ScheduleRow {
  id: string;
  email: string;
  original: string;
  identity: string;
  thread: string;
  envelope: { mailFrom: { email: string }; rcptTo: { email: string }[] };
  rawHash: string;
  sendAt: number;
  status: ScheduleStatus;
  reason: string | null;
  createdAt: number;
  updatedAt: number;
}
interface RawSchedule {
  id: string;
  email: string;
  original: string;
  identity: string;
  thread: string;
  envelope: string;
  raw_hash: string;
  send_at: number;
  status: ScheduleStatus;
  reason: string | null;
  created_at: number;
  updated_at: number;
}
const fromRaw = (r: RawSchedule): ScheduleRow => ({
  id: r.id,
  email: r.email,
  original: r.original,
  identity: r.identity,
  thread: r.thread,
  envelope: JSON.parse(r.envelope),
  rawHash: r.raw_hash,
  sendAt: r.send_at,
  status: r.status,
  reason: r.reason,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});
