// Limits on logins that callers without a session make the proxy perform at
// the mail server.
//
// - Failed logins are counted per (client address, user name) and per client
//   address over a sliding window. Once a budget is used up, further logins
//   for that pair (or from that address) are answered before anything is sent
//   to the mail server, the right password included, until the oldest failure
//   leaves the window. A successful login clears its pair's count.
// - Attempts that are still running count against the budget too, so parallel
//   requests are counted when they start, not when they end.
// - At most `maxInFlight` such logins run at once; more wait briefly for a
//   slot and are then refused.
//
// Everything lives in memory, is bounded in size and is pruned by time. IPv6
// clients are counted per /64, the smallest block one subscriber usually gets.

import net from "node:net";

export interface LoginLimitOptions {
  windowMs?: number;
  maxPerUser?: number;
  maxPerAddress?: number;
  maxInFlight?: number;
  maxWaitMs?: number;
  maxWaiting?: number;
  maxKeys?: number;
  now?: () => number;
}

/** How a login attempt ended; only "refused" (wrong credentials) counts as a failure. */
export type LoginOutcome = "accepted" | "refused" | "error";

export type LoginGate =
  | { ok: true; finish(outcome: LoginOutcome): void }
  | { ok: false; status: 429 | 503; retryAfterSec: number };

const DEFAULTS = {
  windowMs: 15 * 60_000,
  maxPerUser: 10,
  maxPerAddress: 50,
  maxInFlight: 20,
  maxWaitMs: 5_000,
  maxWaiting: 200,
  maxKeys: 50_000,
};

/** Failure timestamps per key, oldest first, at most `max` per key. */
class FailureLog {
  private entries = new Map<string, number[]>();
  private lastPrune = 0;

  constructor(
    private readonly max: number,
    private readonly windowMs: number,
    private readonly maxKeys: number,
  ) {}

  private live(key: string, now: number): number[] {
    const list = this.entries.get(key);
    if (!list) return [];
    while (list.length && list[0]! <= now - this.windowMs) list.shift();
    if (!list.length) this.entries.delete(key);
    return list;
  }

  count(key: string, now: number): number {
    return this.live(key, now).length;
  }

  /** Seconds until the oldest failure leaves the window. */
  retryAfterSec(key: string, now: number): number {
    const list = this.live(key, now);
    if (!list.length) return 1;
    return Math.max(1, Math.ceil((list[0]! + this.windowMs - now) / 1000));
  }

  add(key: string, now: number): void {
    const list = this.live(key, now);
    list.push(now);
    while (list.length > this.max) list.shift();
    // Re-insert so the map's order is least recently failed first.
    this.entries.delete(key);
    if (this.entries.size >= this.maxKeys) this.prune(now, true);
    this.entries.set(key, list);
    if (now - this.lastPrune > this.windowMs / 4) this.prune(now, false);
  }

  clear(key: string): void {
    this.entries.delete(key);
  }

  get size(): number {
    return this.entries.size;
  }

  private prune(now: number, force: boolean): void {
    this.lastPrune = now;
    for (const [key, list] of this.entries) {
      if (!list.length || list[list.length - 1]! <= now - this.windowMs) this.entries.delete(key);
    }
    if (!force) return;
    // Still full of live entries: drop the least recently failed.
    for (const key of this.entries.keys()) {
      if (this.entries.size < this.maxKeys) break;
      this.entries.delete(key);
    }
  }
}

export class LoginLimiter {
  private readonly opts: typeof DEFAULTS;
  private readonly now: () => number;
  private readonly byUser: FailureLog;
  private readonly byAddress: FailureLog;
  private readonly pending = new Map<string, number>();
  private inFlight = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(options: LoginLimitOptions = {}) {
    const { now, ...rest } = options;
    this.opts = { ...DEFAULTS, ...stripUndefined(rest) };
    this.now = now ?? Date.now;
    this.byUser = new FailureLog(this.opts.maxPerUser, this.opts.windowMs, this.opts.maxKeys);
    this.byAddress = new FailureLog(this.opts.maxPerAddress, this.opts.windowMs, this.opts.maxKeys);
  }

  /**
   * Ask to make one login at the mail server for `username` on behalf of the
   * client at `address`. When `ok`, the caller must call `finish` exactly once
   * with the outcome.
   */
  async begin(address: string, username: string): Promise<LoginGate> {
    const addr = addressKey(address);
    const user = userKey(addr, username);
    const held = this.hold(addr, user);
    if (held) return held;

    if (!(await this.acquire())) {
      return { ok: false, status: 503, retryAfterSec: Math.max(1, Math.ceil(this.opts.maxWaitMs / 1000)) };
    }
    // The counts may have moved while this request waited for a slot.
    const heldNow = this.hold(addr, user);
    if (heldNow) {
      this.release();
      return heldNow;
    }

    this.bump(addr, 1);
    this.bump(user, 1);
    let finished = false;
    return {
      ok: true,
      finish: (outcome) => {
        if (finished) return;
        finished = true;
        this.bump(addr, -1);
        this.bump(user, -1);
        this.release();
        const now = this.now();
        if (outcome === "refused") {
          this.byAddress.add(addr, now);
          this.byUser.add(user, now);
        } else if (outcome === "accepted") {
          this.byUser.clear(user);
        }
      },
    };
  }

  /**
   * The hold on this address and user name right now, or null. Checked before
   * anything answers a credential, a login already validated or one still
   * running included, so a held pair learns nothing from the answer.
   */
  check(address: string, username: string): LoginGate | null {
    const addr = addressKey(address);
    return this.hold(addr, userKey(addr, username));
  }

  /**
   * Count a failed lookup of a secret the proxy checks itself (no login at the
   * mail server) against the address's budget. It takes no slot and is never
   * held: a valid secret is not looked up through here at all.
   */
  noteFailedLookup(address: string): void {
    this.byAddress.add(addressKey(address), this.now());
  }

  /** Number of tracked keys, for tests and diagnostics. */
  get trackedKeys(): number {
    return this.byUser.size + this.byAddress.size;
  }

  private hold(addr: string, user: string): LoginGate | null {
    const now = this.now();
    const userFailures = this.byUser.count(user, now);
    const addrFailures = this.byAddress.count(addr, now);
    let retryAfterSec = 0;
    if (userFailures >= this.opts.maxPerUser) retryAfterSec = this.byUser.retryAfterSec(user, now);
    if (addrFailures >= this.opts.maxPerAddress) {
      retryAfterSec = Math.max(retryAfterSec, this.byAddress.retryAfterSec(addr, now));
    }
    if (retryAfterSec > 0) return { ok: false, status: 429, retryAfterSec };
    // Not over the budget yet, but the attempts already running would take it there.
    if (
      userFailures + (this.pending.get(user) ?? 0) >= this.opts.maxPerUser ||
      addrFailures + (this.pending.get(addr) ?? 0) >= this.opts.maxPerAddress
    ) {
      return { ok: false, status: 429, retryAfterSec: 1 };
    }
    return null;
  }

  private bump(key: string, by: number): void {
    const n = (this.pending.get(key) ?? 0) + by;
    if (n > 0) this.pending.set(key, n);
    else this.pending.delete(key);
  }

  private acquire(): Promise<boolean> {
    if (this.inFlight < this.opts.maxInFlight) {
      this.inFlight++;
      return Promise.resolve(true);
    }
    if (this.waiting.length >= this.opts.maxWaiting) return Promise.resolve(false);
    return new Promise<boolean>((resolve) => {
      const wake = () => {
        clearTimeout(timer);
        resolve(true);
      };
      const timer = setTimeout(() => {
        const i = this.waiting.indexOf(wake);
        if (i >= 0) this.waiting.splice(i, 1);
        resolve(false);
      }, this.opts.maxWaitMs);
      timer.unref?.();
      this.waiting.push(wake);
    });
  }

  /** Hand the slot to the next waiter, or give it back. */
  private release(): void {
    const next = this.waiting.shift();
    if (next) next();
    else this.inFlight--;
  }
}

/** User names count without regard to case or surrounding space. */
function userKey(addr: string, username: string): string {
  return `${addr}\n${username.trim().toLowerCase()}`;
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}

/** The address a counter is kept for: IPv4 as it is, IPv6 by its /64. */
export function addressKey(ip: string): string {
  const raw = ip.trim().toLowerCase().replace(/%.*$/, "");
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(raw);
  if (mapped) return mapped[1]!;
  if (!net.isIPv6(raw)) return raw;
  const groups = expandIPv6(raw);
  return `${groups.slice(0, 4).join(":")}::/64`;
}

function expandIPv6(ip: string): string[] {
  let s = ip;
  // A trailing dotted quad stands for the last two groups.
  const v4 = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(s);
  if (v4) {
    const [a, b, c, d] = v4.slice(1).map(Number) as [number, number, number, number];
    s = s.slice(0, v4.index) + `${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head, tail] = s.includes("::") ? (s.split("::") as [string, string]) : [s, null];
  const h = head ? head.split(":") : [];
  const t = tail ? tail.split(":") : [];
  const fill = tail === null ? [] : new Array(8 - h.length - t.length).fill("0");
  return [...h, ...fill, ...t].map((g) => (parseInt(g, 16) || 0).toString(16));
}
