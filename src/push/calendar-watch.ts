// CalDAV has no push. While a client keeps an event stream open, check its
// calendars every few minutes and send a StateChange for CalendarEvent when
// they moved, so an event added on another device shows up without a reload.
// One PROPFIND per account and check: the calendar list with its sync tokens
// and ctags, no event data. A calendar with neither costs one more PROPFIND
// for its members' etags.

import type { AccountRow } from "../state/store.js";
import { log } from "../util/log.js";
import { mapWithConcurrency } from "../util/concurrency.js";

export interface CalendarWatchDeps {
  intervalMs: number;
  /** Accounts with an open event stream. */
  accounts: () => number[];
  accountById: (id: number) => AccountRow | undefined;
  /** The account's current CalendarEvent state, or null when it has no calendars or it can't be told. */
  stateOf: (account: AccountRow) => Promise<string | null>;
  /** The state the account's client last got from a CalendarEvent method, if any. */
  served?: (accountId: number) => string | undefined;
  publish: (account: AccountRow, state: string) => void;
}

export class CalendarWatcher {
  private readonly last = new Map<number, string>();
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(private readonly deps: CalendarWatchDeps) {}

  start(): void {
    if (this.deps.intervalMs <= 0 || this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.deps.intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * One round of checks. The first check of an account compares against the
   * state its client last got, so a change made between the client's load
   * and this check is pushed too; without one it only records the state.
   */
  async tick(): Promise<void> {
    // A slow DAV server must not stack rounds on top of each other.
    if (this.running) return;
    this.running = true;
    try {
      const open = new Set(this.deps.accounts());
      // A stream that reopens later starts from what its client got last.
      for (const id of [...this.last.keys()]) if (!open.has(id)) this.last.delete(id);
      // A few accounts at a time, so one slow DAV server doesn't hold up the round.
      await mapWithConcurrency([...open], 4, async (id) => {
        const account = this.deps.accountById(id);
        if (!account) return;
        let state: string | null;
        try {
          state = await this.deps.stateOf(account);
        } catch (e) {
          log.warn({ accountId: id, err: (e as Error).message }, "calendar watch: check failed");
          return;
        }
        if (state === null) return;
        const before = this.last.get(id) ?? this.deps.served?.(id);
        this.last.set(id, state);
        if (before !== undefined && before !== state) this.deps.publish(account, state);
      });
    } finally {
      this.running = false;
    }
  }
}
