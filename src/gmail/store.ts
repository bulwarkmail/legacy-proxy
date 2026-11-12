import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import Database from "better-sqlite3";
import {
  openCredentials,
  planSealedValues,
  seal,
  sealCredentials,
  sealPlace,
  unseal,
  type Credentials,
} from "../auth/credentials.js";
import { ownerOnly } from "../state/store.js";
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
    this.hashKey = Buffer.from(crypto.hkdfSync("sha256", vaultKey, Buffer.alloc(0), "legacy-proxy secret hash", 32));
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    const file = path.join(dataDir, "gmail.sqlite3");
    // Set permissions before SQLite opens WAL/SHM sidecars.
    fs.closeSync(fs.openSync(file, "a", 0o600));
    ownerOnly([file]);
    this.db = new Database(file);
    try {
      this.setUp(file);
    } catch (e) {
      this.db.close();
      throw e;
    }
  }
  /**
   * Tables, the columns earlier versions' databases lack, and the start step of
   * the sealed values: a VAULT_KEY that doesn't open them throws
   * VaultKeyMismatch before any row is changed.
   */
  private setUp(file: string): void {
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
      CREATE TABLE IF NOT EXISTS gmail_password (email TEXT PRIMARY KEY, hash TEXT NOT NULL UNIQUE, issued_at INTEGER NOT NULL DEFAULT 0, mac TEXT);
      CREATE TABLE IF NOT EXISTS gmail_token (
        hash TEXT PRIMARY KEY, email TEXT NOT NULL, client TEXT NOT NULL, kind TEXT NOT NULL,
        parent TEXT, expires INTEGER NOT NULL, family TEXT, family_since INTEGER, used_at INTEGER, mac TEXT
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
      CREATE TABLE IF NOT EXISTS vault_check (id INTEGER PRIMARY KEY CHECK (id = 1), value BLOB NOT NULL);
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
    // A password issued before issued_at existed counts as issued at 0.
    const passwordColumns = this.db
      .prepare("PRAGMA table_info(gmail_password)")
      .all() as { name: string }[];
    if (!passwordColumns.some((c) => c.name === "issued_at"))
      this.db.exec("ALTER TABLE gmail_password ADD COLUMN issued_at INTEGER NOT NULL DEFAULT 0");
    // Every token belongs to a sign-in (its family: the hash of the sign-in's
    // first refresh token) made at family_since. A refresh token issued before
    // sign-ins were recorded is a sign-in of its own, dated now, with the
    // access tokens under it.
    const tokenColumns = this.db
      .prepare("PRAGMA table_info(gmail_token)")
      .all() as { name: string }[];
    for (const [column, type] of [["family", "TEXT"], ["family_since", "INTEGER"], ["used_at", "INTEGER"], ["mac", "TEXT"]] as const)
      if (!tokenColumns.some((c) => c.name === column))
        this.db.exec(`ALTER TABLE gmail_token ADD COLUMN ${column} ${type}`);
    if (!passwordColumns.some((c) => c.name === "mac")) this.db.exec("ALTER TABLE gmail_password ADD COLUMN mac TEXT");
    // Before any row is changed.
    this.prepareSealedValues(file);
    this.db.exec("CREATE INDEX IF NOT EXISTS gmail_token_family ON gmail_token(family)");
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
  /**
   * The start step of the sealed values, in one transaction (see
   * planSealedValues). On the first start of this version the Google grants
   * of earlier versions are sealed again for their row, cache entries in the
   * earlier format are dropped (they are fetched again), uploads stored
   * before uploads were sealed are sealed for their row, and the plain
   * SHA-256 hashes of bridge passwords and sign-in tokens are keyed and bound
   * to their row (see {@link secretHash}), so existing passwords and sign-ins
   * keep working.
   */
  private prepareSealedValues(file: string): void {
    this.db.transaction(() => {
      const check =
        (this.db.prepare("SELECT value FROM vault_check WHERE id=1").get() as { value: Buffer } | undefined)?.value ?? null;
      const rows = this.db.prepare("SELECT email, vault FROM gmail_connection").all() as { email: string; vault: Buffer }[];
      const plan = planSealedValues(
        this.vaultKey,
        file,
        check,
        rows.map((r) => ({ place: sealPlace.gmailConnection(r.email), value: r.vault })),
      );
      for (const { index, value } of plan.reseal) {
        const row = rows[index]!;
        this.db.prepare("UPDATE gmail_connection SET vault=? WHERE email=? AND vault=?").run(value, row.email, row.vault);
      }
      if (plan.firstStart) {
        this.db.exec("DELETE FROM gmail_cache WHERE NOT (length(value) >= 29 AND substr(value,1,1) = x'02')");
        const uploads = this.db.prepare("SELECT email, id, body FROM gmail_upload").all() as { email: string; id: string; body: Buffer }[];
        for (const u of uploads) {
          const place = sealPlace.gmailUpload(u.email, u.id);
          try {
            unseal(this.vaultKey, place, u.body);
          } catch {
            this.db
              .prepare("UPDATE gmail_upload SET body=? WHERE email=? AND id=?")
              .run(seal(this.vaultKey, place, u.body), u.email, u.id);
          }
        }
        // Every token belongs to a sign-in (its family: the hash of the
        // sign-in's first refresh token) made at family_since. A refresh token
        // issued before sign-ins were recorded is a sign-in of its own, dated
        // now, with the access tokens under it.
        this.db
          .prepare(
            "UPDATE gmail_token SET family=CASE WHEN kind='refresh' THEN hash ELSE COALESCE(parent,hash) END, family_since=? WHERE family IS NULL",
          )
          .run(Date.now());
        // The stored hashes are SHA-256 of each secret: key them in place.
        const passwords = this.db.prepare("SELECT email, hash FROM gmail_password").all() as { email: string; hash: string }[];
        for (const p of passwords) {
          const hash = this.keyed(p.hash);
          this.db.prepare("UPDATE gmail_password SET hash=?, mac=? WHERE email=?").run(hash, this.passwordMac(p.email, hash), p.email);
        }
        const tokens = this.db.prepare("SELECT * FROM gmail_token").all() as TokenRow[];
        for (const t of tokens) {
          const row: TokenRow = {
            ...t,
            hash: this.keyed(t.hash),
            parent: t.parent === null ? null : this.keyed(t.parent),
            family: t.family === null ? null : this.keyed(t.family),
          };
          this.db
            .prepare("UPDATE gmail_token SET hash=?, parent=?, family=?, mac=? WHERE hash=?")
            .run(row.hash, row.parent, row.family, this.tokenMac(row), t.hash);
        }
      }
      if (plan.check) this.db.prepare("INSERT INTO vault_check(id, value) VALUES(1, ?)").run(plan.check);
    })();
  }
  /** Key for the stored hashes of bridge passwords and sign-in tokens, derived from the vault key. */
  private readonly hashKey: Buffer;
  /** HMAC of a SHA-256 hex digest under {@link hashKey}: what the store keeps and looks up. */
  private keyed(sha256: string): string {
    return crypto.createHmac("sha256", this.hashKey).update(sha256).digest("hex");
  }
  /**
   * What is stored for a bridge password or token: the keyed hash of its
   * SHA-256. Without the vault key nobody can write a row a secret of their
   * choosing opens, and the row's MAC ties it to its account, so moving one's
   * own row to another account doesn't work either.
   */
  private secretHash(secret: string): string {
    return this.keyed(crypto.createHash("sha256").update(secret).digest("hex"));
  }
  private rowMac(fields: unknown[]): string {
    return crypto.createHmac("sha256", this.hashKey).update(JSON.stringify(["row", ...fields])).digest("hex");
  }
  private passwordMac(email: string, hash: string): string {
    return this.rowMac(["gmail_password", email, hash]);
  }
  private tokenMac(t: Omit<TokenRow, "used_at" | "mac">): string {
    return this.rowMac(["gmail_token", t.hash, t.email, t.client, t.kind, t.parent, t.expires, t.family, t.family_since]);
  }
  private macMatches(stored: string | null, expected: string): boolean {
    if (!stored || stored.length !== expected.length) return false;
    return crypto.timingSafeEqual(Buffer.from(stored), Buffer.from(expected));
  }
  async save(
    email: string,
    credentials: Credentials,
    snapshot: GmailSnapshot,
  ): Promise<void> {
    const vault = await sealCredentials(this.vaultKey, sealPlace.gmailConnection(email), credentials);
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
      credentials: await openCredentials(this.vaultKey, sealPlace.gmailConnection(email), row.vault),
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
  /**
   * Issues a new bridge password for the account and signs every device out:
   * in the same transaction the previous password stops working and the
   * account's sign-in tokens and push subscriptions are deleted. Sign-out
   * listeners are told afterwards, so open event streams of the account end.
   */
  issuePassword(email: string, now = Date.now()): string {
    if (!this.hasConnection(email)) throw new Error("Account is not connected");
    const password = "gmap_" + crypto.randomBytes(32).toString("base64url");
    // Never the same issue time twice, so a stream opened under the previous
    // password always counts as older.
    const issuedAt = Math.max(now, this.passwordIssuedAt(email) + 1);
    const hash = this.secretHash(password);
    this.db.transaction(() => {
      this.db
        .prepare(
          "INSERT INTO gmail_password(email,hash,issued_at,mac) VALUES (?,?,?,?) ON CONFLICT(email) DO UPDATE SET hash=excluded.hash,issued_at=excluded.issued_at,mac=excluded.mac",
        )
        .run(email, hash, issuedAt, this.passwordMac(email, hash));
      this.db.prepare("DELETE FROM gmail_token WHERE email=?").run(email);
      this.db.prepare("DELETE FROM gmail_push_sub WHERE email=?").run(email);
    })();
    for (const listener of this.signOutListeners) listener(email);
    return password;
  }
  /**
   * When the account's current bridge password was issued (epoch ms): 0 for a
   * password issued before this was recorded, or when it has none. Anything
   * opened before it belongs to devices that were signed out.
   */
  passwordIssuedAt(email: string): number {
    return (
      (
        this.db
          .prepare("SELECT issued_at FROM gmail_password WHERE email=?")
          .get(email) as { issued_at: number } | undefined
      )?.issued_at ?? 0
    );
  }
  private readonly signOutListeners = new Set<(email: string) => void>();
  /** Told after a new bridge password signed every device of an account out. Returns a function that stops telling it. */
  onSignOut(listener: (email: string) => void): () => void {
    this.signOutListeners.add(listener);
    return () => {
      this.signOutListeners.delete(listener);
    };
  }
  hasPassword(email: string): boolean {
    return !!this.db
      .prepare("SELECT 1 FROM gmail_password WHERE email=?")
      .get(email);
  }
  authenticate(password: string, username?: string): string | null {
    if (!/^gmap_[A-Za-z0-9_-]{43}$/.test(password)) return null;
    const hash = this.secretHash(password);
    const row = this.db
      .prepare("SELECT email,mac FROM gmail_password WHERE hash=?")
      .get(hash) as { email: string; mac: string | null } | undefined;
    return row && this.macMatches(row.mac, this.passwordMac(row.email, hash)) && (!username || row.email === username.toLowerCase())
      ? row.email
      : null;
  }
  /**
   * A token row by the token, if its row is the one the store wrote: a row
   * whose MAC doesn't match its fields (moved to another account, its sign-in
   * date or expiry changed, or written without the vault key) counts as none.
   */
  private tokenRow(token: string, kind: "access" | "refresh"): TokenRow | undefined {
    const row = this.db.prepare("SELECT * FROM gmail_token WHERE hash=? AND kind=?").get(this.secretHash(token), kind) as
      | TokenRow
      | undefined;
    return row && this.macMatches(row.mac, this.tokenMac(row)) ? row : undefined;
  }
  /**
   * Signs a client in for an account: a refresh token and a short-lived access token under it, the first
   * tokens of a new sign-in. Only keyed hashes are stored, so a copy of the database signs nobody in.
   */
  issueTokens(email: string, client: string, now = Date.now()): IssuedTokens {
    if (!this.hasConnection(email)) throw new Error("Account is not connected");
    return this.db.transaction(() => this.tokensFor({ email, client, family: null, since: now, parent: null }, now))();
  }
  /**
   * Exchanges a refresh token of this client for a new refresh token and a new access token of the same
   * sign-in. The token that was used stays good for {@link REFRESH_REUSE_GRACE} after its first use, so two
   * tabs that refresh at the same moment both get an answer, but it is exchanged at most
   * {@link MAX_SUCCESSORS} times: a further exchange inside that time is refused and leaves the sign-in as
   * it is, so a client that retries too often loses only that answer. Presented after that time, it was
   * copied: it is refused and every token of its sign-in stops working. A sign-in ends
   * {@link SIGN_IN_TTL} after it was made, however often it was refreshed.
   */
  refreshTokens(refreshToken: string, client: string, now = Date.now()): IssuedTokens | null {
    if (!TOKEN_RE.refresh.test(refreshToken)) return null;
    return this.db.transaction((): IssuedTokens | null => {
      const row = this.tokenRow(refreshToken, "refresh");
      if (!row || row.client !== client || row.expires <= now) return null;
      const hash = row.hash;
      const family = row.family ?? hash;
      if (row.used_at !== null && now - row.used_at > REFRESH_REUSE_GRACE) {
        this.db.prepare("DELETE FROM gmail_token WHERE family=?").run(family);
        return null;
      }
      const since = row.family_since ?? now;
      if (now >= since + SIGN_IN_TTL || !this.hasConnection(row.email)) return null;
      // A refresh token's successors record it as their parent.
      const successors = (
        this.db.prepare("SELECT COUNT(*) AS n FROM gmail_token WHERE kind='refresh' AND parent=?").get(hash) as { n: number }
      ).n;
      if (successors >= MAX_SUCCESSORS) return null;
      if (row.used_at === null) this.db.prepare("UPDATE gmail_token SET used_at=? WHERE hash=?").run(now, hash);
      return this.tokensFor({ email: row.email, client, family, since, parent: hash }, now);
    })();
  }
  /**
   * A new refresh token and an access token under it, in sign-in `family` (a new one when null) made at
   * `since`; `parent` is the refresh token it replaces, if any. Callers hold a transaction.
   */
  private tokensFor(
    s: { email: string; client: string; family: string | null; since: number; parent: string | null },
    now: number,
  ): IssuedTokens {
    const end = s.since + SIGN_IN_TTL;
    const refresh = TOKEN_PREFIX.refresh + crypto.randomBytes(32).toString("base64url");
    const access = TOKEN_PREFIX.access + crypto.randomBytes(32).toString("base64url");
    const refreshHash = this.secretHash(refresh);
    const family = s.family ?? refreshHash;
    const insert = (t: Omit<TokenRow, "used_at" | "mac">) =>
      this.db
        .prepare("INSERT INTO gmail_token(hash,email,client,kind,parent,expires,family,family_since,mac) VALUES (?,?,?,?,?,?,?,?,?)")
        .run(t.hash, t.email, t.client, t.kind, t.parent, t.expires, t.family, t.family_since, this.tokenMac(t));
    this.db.prepare("DELETE FROM gmail_token WHERE expires<=?").run(now);
    const common = { email: s.email, client: s.client, family, family_since: s.since };
    insert({ ...common, hash: refreshHash, kind: "refresh", parent: s.parent, expires: Math.min(now + REFRESH_TOKEN_TTL, end) });
    insert({ ...common, hash: this.secretHash(access), kind: "access", parent: refreshHash, expires: Math.min(now + ACCESS_TOKEN_TTL, end) });
    return { email: s.email, accessToken: access, expiresIn: ACCESS_TOKEN_TTL / 1000, refreshToken: refresh };
  }
  /** The account an access token signs in, while it is valid. */
  authenticateToken(accessToken: string, now = Date.now()): string | null {
    if (!TOKEN_RE.access.test(accessToken)) return null;
    const row = this.tokenRow(accessToken, "access");
    return row && row.expires > now ? row.email : null;
  }
  /** Revokes a token issued to this client; revoking a refresh token ends its whole sign-in. */
  revokeToken(token: string, client: string): void {
    this.db.transaction(() => {
      const row = this.tokenRow(token, "refresh") ?? this.tokenRow(token, "access");
      if (!row || row.client !== client) return;
      const hash = row.hash;
      if (row.kind === "refresh")
        this.db.prepare("DELETE FROM gmail_token WHERE hash=? OR parent=? OR family=?").run(hash, hash, row.family ?? hash);
      else this.db.prepare("DELETE FROM gmail_token WHERE hash=?").run(hash);
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
    const place = sealPlace.gmailConnection(email);
    const old = await openCredentials(this.vaultKey, place, row.vault);
    if (
      old.refreshToken !== expectedRefreshToken ||
      (snapshot === undefined &&
        old.accessToken === credentials.accessToken &&
        old.expiresAt === credentials.expiresAt)
    )
      return;
    const vault = await sealCredentials(this.vaultKey, place, {
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
  /**
   * Forgets what one write can have changed and keeps the rest of the account's
   * cache: the listings and counters, the profile (so the next read asks Gmail
   * for the history that write produced, and {@link checkpoint} catches any
   * message the write moved besides the ones named here), and the named
   * messages and threads.
   *
   * {@link invalidate} empties the whole account instead. Run after every
   * mark-as-read, that sent the next folder opened back to Gmail for each of
   * its messages, and a busy mailbox into Google's rate limit.
   */
  forget(email: string, messages: string[], threads: string[]): void {
    this.db.transaction(() => {
      this.drop(email, messages, threads);
      this.db
        .prepare("DELETE FROM gmail_cache WHERE email=? AND key='profile'")
        .run(email);
    })();
  }
  /** Moves the revision on and drops the listings plus the given messages and threads. Callers hold a transaction. */
  private drop(email: string, messages: string[], threads: string[]): void {
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
    for (const id of threads) {
      del.run(email, "thread:v2:t_" + id);
      del.run(email, "thread:v3:t_" + id);
    }
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
      else if (messages.length || threads.length)
        this.drop(email, messages, threads);
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
      value = JSON.parse(unseal(this.vaultKey, sealPlace.gmailCache(email, key), row.value).toString("utf8")) as T;
    } catch {
      // A row that doesn't open here (a value sealed for another row, or in
      // the earlier format) is unreadable for good: drop it and let the caller
      // fetch the data again. The start step has checked the key.
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
   * Caches one entry, sealed for its account and key under the vault key.
   *
   * What passes through here is mail - subjects, senders, bodies - kept on
   * disk for as long as its entry lives, which is long enough to be worth
   * treating like the credentials next to it. AES-GCM on a few hundred bytes
   * costs microseconds against the network round trip it saves.
   */
  cache(email: string, key: string, data: unknown, ttl: number): void {
    const value = seal(this.vaultKey, sealPlace.gmailCache(email, key), Buffer.from(JSON.stringify(data), "utf8"));
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
      // Uploads are mail being written: sealed like the cache.
      this.db
        .prepare("INSERT INTO gmail_upload(email,id,body,type,expires) VALUES(?,?,?,?,?)")
        .run(email, id, seal(this.vaultKey, sealPlace.gmailUpload(email, id), body), type, Date.now() + 24 * 60 * 60_000);
    })();
    return id;
  }
  uploaded(email: string, id: string): { body: Buffer; type: string } | null {
    const row = this.db
      .prepare(
        "SELECT body,type FROM gmail_upload WHERE email=? AND id=? AND expires>?",
      )
      .get(email, id, Date.now()) as
      { body: Buffer; type: string } | undefined;
    if (!row) return null;
    try {
      return { body: unseal(this.vaultKey, sealPlace.gmailUpload(email, id), row.body), type: row.type };
    } catch {
      // A body that doesn't open here is no upload of this account: it is
      // answered like an unknown one.
      return null;
    }
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
  /** Deletes everything stored for an account: grant, bridge password, sign-in tokens, cache, drafts, send ledger, queues and push subscriptions. */
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
      "gmail_push_sub",
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
/** Access tokens are short-lived; a refresh token is exchanged for a new one on every use. */
const ACCESS_TOKEN_TTL = 3600_000;
/** How long a refresh token stays good when it is not used. */
const REFRESH_TOKEN_TTL = 180 * 86400_000;
/** How long a refresh token still answers after its first use, for a second tab that was a moment late. */
export const REFRESH_REUSE_GRACE = 60_000;
/** How many new refresh tokens one refresh token can be exchanged for in that time. */
export const MAX_SUCCESSORS = 3;
/** A sign-in ends this long after it was made, however often it was refreshed. */
export const SIGN_IN_TTL = 365 * 86400_000;
const TOKEN_PREFIX = { access: "gmat_", refresh: "gmrt_" } as const;
const TOKEN_RE = { access: /^gmat_[A-Za-z0-9_-]{43}$/, refresh: /^gmrt_[A-Za-z0-9_-]{43}$/ };
/** A row of gmail_token. */
interface TokenRow {
  hash: string;
  email: string;
  client: string;
  kind: string;
  parent: string | null;
  expires: number;
  family: string | null;
  family_since: number | null;
  used_at: number | null;
  mac: string | null;
}
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
