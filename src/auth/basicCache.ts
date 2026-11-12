// Validated HTTP Basic logins, by a keyed tag of the decoded user name and
// password (never by the header's text, which can spell the same credentials
// many ways). An entry answers requests for `ttlMs`; after that it lapses and
// the next request logs in at the mail server again. A lapsed entry is kept
// for `keepLapsedMs` as a sign that these credentials were validated before
// (a signed-in client re-validating), then forgotten. The cache holds at most
// `maxEntries`: past that, forgotten entries go first, then the ones validated
// longest ago.

export interface CachedBasicLogin {
  accountId: number;
  /** The account's credential generation when the login was validated. */
  gen: number;
  /** Credential tag of the login (see auth/session.ts `credentialTag`). */
  tag: string;
  /** Until when the entry answers requests (epoch ms). */
  expires: number;
}

export const BASIC_TTL_MS = 5 * 60_000;
export const BASIC_KEEP_LAPSED_MS = 24 * 60 * 60_000;
export const BASIC_MAX_ENTRIES = 10_000;

export class BasicLoginCache {
  // Insertion order is the order of the last validation: set() re-inserts.
  private readonly entries = new Map<string, CachedBasicLogin>();
  private readonly ttlMs: number;
  private readonly keepLapsedMs: number;
  private readonly maxEntries: number;
  private readonly now: () => number;
  private lastPrune = 0;

  constructor(options: { ttlMs?: number; keepLapsedMs?: number; maxEntries?: number; now?: () => number } = {}) {
    this.ttlMs = options.ttlMs ?? BASIC_TTL_MS;
    this.keepLapsedMs = options.keepLapsedMs ?? BASIC_KEEP_LAPSED_MS;
    this.maxEntries = options.maxEntries ?? BASIC_MAX_ENTRIES;
    this.now = options.now ?? (() => Date.now());
  }

  /** The entry while it answers requests. */
  valid(key: string): CachedBasicLogin | undefined {
    const entry = this.entries.get(key);
    return entry && entry.expires > this.now() ? entry : undefined;
  }

  /** An entry that lapsed and is not forgotten yet: credentials validated before. */
  lapsed(key: string): CachedBasicLogin | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    const now = this.now();
    if (entry.expires > now) return undefined;
    if (entry.expires + this.keepLapsedMs <= now) {
      this.entries.delete(key);
      return undefined;
    }
    return entry;
  }

  set(key: string, entry: Omit<CachedBasicLogin, "expires">): void {
    const now = this.now();
    this.entries.delete(key);
    this.entries.set(key, { ...entry, expires: now + this.ttlMs });
    if (this.entries.size > this.maxEntries || now - this.lastPrune > this.ttlMs) this.prune(now);
  }

  delete(key: string): void {
    this.entries.delete(key);
  }

  get size(): number {
    return this.entries.size;
  }

  private prune(now: number): void {
    this.lastPrune = now;
    for (const [key, entry] of this.entries) {
      if (entry.expires + this.keepLapsedMs <= now) this.entries.delete(key);
    }
    for (const key of this.entries.keys()) {
      if (this.entries.size <= this.maxEntries) break;
      this.entries.delete(key);
    }
  }
}
