// When the attempts of a check of an account's stored password run, and how a
// request of another session waits for the check's answer.
//
// A sign-in with a password other than the stored one opens a check (see
// server.ts): the stored password is tried at the mail server until the
// server accepts or refuses it. An attempt that gets no answer (the server
// can't be reached, says "try again later", no login slot is free, the
// address is held) is followed by the next one after a growing delay:
// 5 s, 30 s, 1 min, 2 min, 5 min, then every 10 min. Delays run from the start
// of one attempt to the start of the next, so a check makes at most 11
// attempts in its first hour and 6 in each hour after that.

/** Delay before the next attempt, by the number of attempts made so far (1, 2, ...); the last repeats. */
export const CHECK_RETRY_DELAYS_MS = [5_000, 30_000, 60_000, 120_000, 300_000, 600_000];

/** How long a request of another session waits for the check's answer before it is told to come back. */
export const CHECK_WAIT_MS = 15_000;

export function checkRetryDelayMs(attempts: number): number {
  const i = Math.min(Math.max(attempts, 1), CHECK_RETRY_DELAYS_MS.length) - 1;
  return CHECK_RETRY_DELAYS_MS[i]!;
}

/** What one attempt found: an answer (the check is closed) or none (try again later). */
export type CheckAttemptResult = "answered" | "unanswered";

interface OpenCheck {
  attempts: number;
  /** When the next attempt starts (epoch ms), while none is running. */
  nextAt: number;
  running: boolean;
  timer?: NodeJS.Timeout;
  /** Settles when the running attempt, or the next one, ends, or the check closes. */
  ended: Promise<void>;
  settle: () => void;
}

export class StoredPasswordChecks {
  private readonly checks = new Map<number, OpenCheck>();
  private readonly now: () => number;
  private readonly waitMs: number;

  /**
   * `attempt` tries the stored password once and records what it found; it
   * returns "answered" once the check is closed.
   */
  constructor(
    private readonly attempt: (accountId: number) => Promise<CheckAttemptResult>,
    options: { now?: () => number; waitMs?: number } = {},
  ) {
    this.now = options.now ?? (() => Date.now());
    this.waitMs = options.waitMs ?? CHECK_WAIT_MS;
  }

  /**
   * Run the attempts of an open check: at once for a new one (`attempts` 0),
   * or on the schedule for one resumed after a restart (`attempts` made, the
   * last started at `lastAt`). Nothing happens when it runs already.
   */
  open(accountId: number, made: { attempts: number; lastAt: number } = { attempts: 0, lastAt: 0 }): void {
    if (this.checks.has(accountId)) return;
    const now = this.now();
    const nextAt = made.attempts > 0 ? Math.max(now, made.lastAt + checkRetryDelayMs(made.attempts)) : now;
    const check: OpenCheck = { attempts: made.attempts, nextAt, running: false, ended: Promise.resolve(), settle: () => {} };
    this.renew(check);
    this.checks.set(accountId, check);
    this.schedule(accountId, check);
  }

  isOpen(accountId: number): boolean {
    return this.checks.has(accountId);
  }

  /** The check was answered (or ended) some other way: stop its attempts and wake whoever waits. */
  close(accountId: number): void {
    const check = this.checks.get(accountId);
    if (!check) return;
    this.checks.delete(accountId);
    if (check.timer) clearTimeout(check.timer);
    check.settle();
  }

  closeAll(): void {
    for (const id of [...this.checks.keys()]) this.close(id);
  }

  /**
   * For a request of a session the check holds: wait for the check's answer
   * while an attempt is running or starts within the wait. Returns null when
   * the check is closed, else the seconds after which to come back.
   */
  async waitForAnswer(accountId: number): Promise<number | null> {
    let check = this.checks.get(accountId);
    if (!check) return null;
    let timedOut = false;
    let expire!: () => void;
    const deadline = new Promise<void>((resolve) => (expire = resolve));
    const timer = setTimeout(() => {
      timedOut = true;
      expire();
    }, this.waitMs);
    try {
      const until = this.now() + this.waitMs;
      while (check && !timedOut && (check.running || check.nextAt <= until)) {
        await Promise.race([check.ended, deadline]);
        check = this.checks.get(accountId);
      }
    } finally {
      clearTimeout(timer);
    }
    if (!check) return null;
    const untilNext = check.running ? checkRetryDelayMs(1) : check.nextAt - this.now();
    return Math.max(1, Math.ceil(untilNext / 1000));
  }

  private renew(check: OpenCheck): void {
    check.ended = new Promise<void>((resolve) => (check.settle = resolve));
  }

  private schedule(accountId: number, check: OpenCheck): void {
    const delay = Math.max(0, check.nextAt - this.now());
    check.timer = setTimeout(() => void this.run(accountId, check), delay);
    check.timer.unref?.();
  }

  private async run(accountId: number, check: OpenCheck): Promise<void> {
    if (this.checks.get(accountId) !== check) return;
    check.timer = undefined;
    check.running = true;
    const startedAt = this.now();
    check.attempts++;
    let result: CheckAttemptResult;
    try {
      result = await this.attempt(accountId);
    } catch {
      result = "unanswered";
    }
    check.running = false;
    // Closed meanwhile (answered by a sign-in), possibly reopened since.
    if (this.checks.get(accountId) !== check) return;
    if (result === "answered") {
      this.close(accountId);
      return;
    }
    check.nextAt = startedAt + checkRetryDelayMs(check.attempts);
    const settle = check.settle;
    this.renew(check);
    settle();
    this.schedule(accountId, check);
  }
}
