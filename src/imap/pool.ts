import type { ImapFlow } from "imapflow";
import type { Credentials } from "../auth/credentials.js";
import type { AppConfig } from "../util/config.js";
import { resolveProvider } from "../auth/providers.js";
import { openCredentials } from "../auth/credentials.js";
import { isCredentialRefusal, openImap } from "./client.js";
import type { Store, AccountRow } from "../state/store.js";
import { log } from "../util/log.js";

interface PoolEntry {
  client: ImapFlow;
  lastUsed: number;
  // True while a caller holds this connection. imapflow serialises commands
  // per socket, so handing one connection to two concurrent callers would
  // queue them behind each other — exactly what the pool exists to avoid.
  busy: boolean;
  // Logged in with credentials that are no longer the account's: closed as
  // soon as its borrower gives it back.
  retired?: boolean;
}

// Skip the sanity-NOOP if the connection was used within this window.
// Every JMAP method funnels through acquire, so a per-call NOOP adds one IMAP
// round-trip to every request - visible as multi-second latency on slow links.
// Most servers don't drop idle TCP for tens of seconds, so we only NOOP after
// a meaningful idle gap.
const NOOP_FRESHNESS_MS = 30_000;

// Two connection roles per account:
//   - "interactive": JMAP method calls (the latency-sensitive path).
//   - "bulk": blob downloads and thread-index scans — operations that can
//     hold the socket for seconds. Splitting them keeps a 20 MB attachment
//     download or a first-time account scan from freezing every other
//     request for the account.
export type PoolRole = "interactive" | "bulk";

// How many sockets each role may open per account. A browser issues several
// JMAP requests at once (folder list, message list, open message); with a
// single interactive socket they all queued behind one another inside
// imapflow. Kept small so one user cannot exhaust a server's per-account
// connection limit — IMAP servers commonly cap that in the 4-10 range, and
// the push IDLE worker holds one more outside this pool.
const MAX_PER_ROLE: Record<PoolRole, number> = {
  interactive: 3,
  bulk: 2,
};

/** A borrowed connection. `release` must be called exactly once. */
export interface Lease {
  client: ImapFlow;
  release: () => void;
}

export class ImapPool {
  private entries = new Map<string, PoolEntry[]>();
  // Callers parked waiting for a connection to come free, per pool key.
  private waiters = new Map<string, Array<() => void>>();
  // Connections being opened, per pool key.
  private opening = new Map<string, number>();
  // Accounts whose stored credentials opened a connection in this process,
  // and the chain of dials for those that have not (see takeFree).
  private verified = new Set<number>();
  private dialLocks = new Map<number, Promise<void>>();

  constructor(
    private cfg: AppConfig,
    private store: Store,
  ) {}

  /**
   * Borrow a connection for the duration of `fn`. The connection returns to
   * the pool whether `fn` resolves or throws.
   */
  async withConnection<T>(
    account: AccountRow,
    role: PoolRole,
    fn: (client: ImapFlow) => Promise<T>,
  ): Promise<T> {
    const lease = await this.acquire(account, role);
    try {
      return await fn(lease.client);
    } finally {
      lease.release();
    }
  }

  /**
   * Borrow a connection with an explicit release. Prefer `withConnection`;
   * this exists for callers whose use outlives a single async scope, such as
   * the blob download route streaming a response body.
   */
  async acquire(account: AccountRow, role: PoolRole = "interactive"): Promise<Lease> {
    const key = `${account.id}:${role}`;
    for (;;) {
      const entry = await this.takeFree(account, key, role);
      if (entry) return this.leaseFor(key, entry);
      // At the cap with everything busy: park until someone releases, then
      // re-run the whole selection (the freed entry may have died meanwhile).
      await this.waitForRelease(key);
    }
  }

  /**
   * Claim a usable idle connection, or open one if the role is under its cap.
   * Returns null when every slot is taken.
   */
  private async takeFree(
    account: AccountRow,
    key: string,
    role: PoolRole,
  ): Promise<PoolEntry | null> {
    const list = [...(this.entries.get(key) ?? [])];
    for (const entry of list) {
      if (entry.busy) continue;
      if (!entry.client.usable) {
        this.drop(key, entry);
        continue;
      }
      entry.busy = true;
      const idleMs = Date.now() - entry.lastUsed;
      entry.lastUsed = Date.now();
      if (idleMs < NOOP_FRESHNESS_MS) return entry;
      try {
        await entry.client.noop();
        return entry;
      } catch {
        // Dead despite looking usable; drop it and keep looking.
        entry.busy = false;
        this.drop(key, entry);
      }
    }

    // Connections still being opened count against the cap too.
    const opening = this.opening.get(key) ?? 0;
    if ((this.entries.get(key)?.length ?? 0) + opening >= MAX_PER_ROLE[role]) return null;
    this.opening.set(key, opening + 1);
    let unlock: (() => void) | null = null;
    let opened = false;
    try {
      // Until the stored credentials have worked in this process, and again
      // after the server refused them, the account's dials go one at a time:
      // each one sees the refusals of the one before, so requests that arrive
      // together cannot send more logins than the refused mark allows.
      if (!this.verified.has(account.id)) unlock = await this.lockDials(account.id);

      // Dial with the credentials the row holds now, not the ones the request
      // started with, and not at all once the mail server refused them: the
      // next successful login clears that mark.
      const current = this.store.getAccountById(account.id);
      if (!current || current.cred_refused) throw new Error("stored credentials refused by the mail server");
      const provider = resolveProvider(this.cfg, current.kind);
      const creds: Credentials = await openCredentials(this.cfg.vaultKey, current.vault);
      let client: ImapFlow;
      try {
        client = await openImap({ provider, creds });
      } catch (e) {
        if (isCredentialRefusal(e)) {
          this.verified.delete(account.id);
          this.store.noteCredentialRefusal(current.id, current.cred_gen);
        }
        throw e;
      }
      if (current.cred_refusals > 0) this.store.noteCredentialSuccess(current.id);
      this.verified.add(account.id);
      const entry: PoolEntry = { client, lastUsed: Date.now(), busy: true };
      this.attach(account, key, entry);
      opened = true;
      return entry;
    } finally {
      unlock?.();
      const left = (this.opening.get(key) ?? 1) - 1;
      if (left > 0) this.opening.set(key, left);
      else this.opening.delete(key);
      // A slot reserved for a dial that failed is free again.
      if (!opened) this.wake(key);
    }
  }

  /** Wait for the account's previous dial to finish; returns the release for this one. */
  private async lockDials(accountId: number): Promise<() => void> {
    const previous = this.dialLocks.get(accountId) ?? Promise.resolve();
    let release!: () => void;
    const mine = new Promise<void>((resolve) => (release = resolve));
    const tail = previous.then(() => mine);
    this.dialLocks.set(accountId, tail);
    await previous;
    return () => {
      release();
      if (this.dialLocks.get(accountId) === tail) this.dialLocks.delete(accountId);
    };
  }

  private leaseFor(key: string, entry: PoolEntry): Lease {
    let released = false;
    return {
      client: entry.client,
      release: () => {
        if (released) return;
        released = true;
        entry.busy = false;
        entry.lastUsed = Date.now();
        // A caller that killed the socket (or found it dead) must not leave a
        // corpse in the pool for the next borrower to trip over.
        if (!entry.client.usable) this.drop(key, entry);
        else if (entry.retired) {
          this.drop(key, entry);
          entry.client.logout().catch(() => {});
        }
        this.wake(key);
      },
    };
  }

  private waitForRelease(key: string): Promise<void> {
    return new Promise<void>((resolve) => {
      const queue = this.waiters.get(key) ?? [];
      queue.push(resolve);
      this.waiters.set(key, queue);
    });
  }

  private wake(key: string): void {
    const queue = this.waiters.get(key);
    if (!queue || queue.length === 0) return;
    const next = queue.shift()!;
    if (queue.length === 0) this.waiters.delete(key);
    next();
  }

  // Hand a live, already-authenticated connection to the pool. The auth paths
  // open a probe connection to validate credentials; adopting it saves the
  // immediately-following JMAP request from paying a second TCP+TLS+LOGIN
  // handshake. If the interactive role is already at its cap the probe is
  // logged out.
  adopt(account: AccountRow, client: ImapFlow): void {
    const key = `${account.id}:interactive`;
    if ((this.entries.get(key)?.length ?? 0) >= MAX_PER_ROLE.interactive) {
      client.logout().catch(() => {});
      return;
    }
    this.attach(account, key, { client, lastUsed: Date.now(), busy: false });
    this.wake(key);
  }

  /**
   * Close every connection of the account: idle ones now, borrowed ones when
   * they are given back. Called when the account's credentials change, so no
   * connection logged in with the old ones keeps serving requests.
   */
  retire(accountId: number): void {
    // The new credentials have not opened a connection yet.
    this.verified.delete(accountId);
    for (const role of Object.keys(MAX_PER_ROLE) as PoolRole[]) {
      const key = `${accountId}:${role}`;
      for (const entry of [...(this.entries.get(key) ?? [])]) {
        if (entry.busy) {
          entry.retired = true;
          continue;
        }
        this.drop(key, entry);
        entry.client.logout().catch(() => {});
      }
      this.wake(key);
    }
  }

  private attach(account: AccountRow, key: string, entry: PoolEntry): void {
    entry.client.on("close", () => {
      log.warn({ account: account.slug, key }, "imap connection closed");
      this.drop(key, entry);
      // A slot just opened up, so let a parked caller dial a replacement.
      this.wake(key);
    });
    entry.client.on("error", (err: Error) => {
      log.warn({ account: account.slug, key, err: err.message }, "imap connection error");
      this.drop(key, entry);
      this.wake(key);
    });
    const list = this.entries.get(key) ?? [];
    list.push(entry);
    this.entries.set(key, list);
  }

  private drop(key: string, entry: PoolEntry): void {
    const list = this.entries.get(key);
    if (!list) return;
    const i = list.indexOf(entry);
    if (i >= 0) list.splice(i, 1);
    if (list.length === 0) this.entries.delete(key);
  }

  async closeAll(): Promise<void> {
    for (const list of this.entries.values()) {
      for (const e of list) {
        try {
          await e.client.logout();
        } catch {
          // best effort
        }
      }
    }
    this.entries.clear();
    // Nobody is coming back for these; unblock anyone still parked.
    for (const queue of this.waiters.values()) for (const resolve of queue) resolve();
    this.waiters.clear();
  }
}
