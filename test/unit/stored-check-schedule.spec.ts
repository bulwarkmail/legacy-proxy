// A check of a stored password that gets no answer tries again on a timer
// with growing delays, at most 11 times in the first hour and once an hour
// after, stops at the first answer, and expires a day after it opened (34
// attempts at most). Requests it holds wait for an attempt that is due and
// are then told when to come back.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CHECK_RETRY_DELAYS_MS, StoredPasswordChecks, type CheckAttemptResult } from "../../src/auth/storedCheck.js";

const HOUR = 60 * 60_000;

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("attempts of a check without an answer", () => {
  it("are at most 11 in the first hour, one an hour after, 34 in all before the check expires at 24 hours", async () => {
    let attempts = 0;
    const expired: number[] = [];
    const opened = Date.now();
    const checks = new StoredPasswordChecks(
      async () => {
        attempts++;
        return "unanswered";
      },
      { expire: (id) => void expired.push(id) },
    );
    checks.open(1, { openedAt: opened });
    const perHour: number[] = [];
    for (let hour = 0; hour < 24; hour++) {
      const before = attempts;
      await vi.advanceTimersByTimeAsync(HOUR - (hour === 23 ? 1 : 0));
      perHour.push(attempts - before);
    }
    expect(perHour[0]).toBe(11);
    expect(perHour.slice(1).every((n) => n === 1)).toBe(true);
    expect(attempts).toBe(34);
    expect(expired).toEqual([]);
    // At 24 hours the check expires instead of making another attempt, and stops.
    await vi.advanceTimersByTimeAsync(1);
    expect(expired).toEqual([1]);
    expect(checks.isOpen(1)).toBe(false);
    await vi.advanceTimersByTimeAsync(7 * 24 * HOUR);
    expect(attempts).toBe(34);
    expect(expired).toEqual([1]);
  });

  it("expire at once, without an attempt, when resumed more than a day after they opened", async () => {
    let attempts = 0;
    const expired: number[] = [];
    const checks = new StoredPasswordChecks(
      async () => {
        attempts++;
        return "unanswered";
      },
      { expire: (id) => void expired.push(id) },
    );
    checks.open(7, { attempts: 20, lastAt: Date.now() - 2 * HOUR, openedAt: Date.now() - 25 * HOUR });
    await vi.advanceTimersByTimeAsync(0);
    expect({ attempts, expired, open: checks.isOpen(7) }).toEqual({ attempts: 0, expired: [7], open: false });
  });

  it("wake a request waiting for the next attempt when the check expires instead", async () => {
    const checks = new StoredPasswordChecks(async () => "unanswered", { expire: () => {} });
    checks.open(1, { attempts: 11, lastAt: Date.now() - 50 * 60_000, openedAt: Date.now() - (24 * HOUR - 5_000) });
    // The next attempt is ten minutes away, the expiry five seconds: the request waits for the expiry.
    const waiting = checks.waitForAnswer(1);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await waiting).toBeNull();
  });

  it("stop at the first answer", async () => {
    let attempts = 0;
    const checks = new StoredPasswordChecks(async () => (++attempts === 3 ? "answered" : "unanswered"));
    checks.open(1);
    await vi.advanceTimersByTimeAsync(HOUR);
    expect(attempts).toBe(3);
    expect(checks.isOpen(1)).toBe(false);
  });

  it("go on from where they were after a restart, without an attempt at once", async () => {
    let attempts = 0;
    const checks = new StoredPasswordChecks(async () => {
      attempts++;
      return "unanswered";
    });
    // Four attempts made, the last one a minute ago: the next is due two minutes after it.
    checks.open(1, { attempts: 4, lastAt: Date.now() - 60_000 });
    await vi.advanceTimersByTimeAsync(CHECK_RETRY_DELAYS_MS[3]! - 60_000 - 1);
    expect(attempts).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(attempts).toBe(1);
    checks.closeAll();
  });
});

describe("a request the check holds", () => {
  it("waits for an attempt that is due, and is told when to come back if it gets no answer", async () => {
    const results: CheckAttemptResult[] = ["unanswered", "unanswered", "answered"];
    const checks = new StoredPasswordChecks(async () => results.shift() ?? "unanswered");
    checks.open(1);
    await vi.advanceTimersByTimeAsync(0);
    // The first attempt got no answer; the second is due in 5 s, within the wait.
    const waiting = checks.waitForAnswer(1);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await waiting).toBe(30);
    // The third is 30 s away, beyond the wait: no waiting.
    expect(await checks.waitForAnswer(1)).toBe(30);
    // 20 s later it is 10 s away: the request waits for it and gets the answer.
    await vi.advanceTimersByTimeAsync(20_000);
    const answered = checks.waitForAnswer(1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await answered).toBeNull();
    expect(await checks.waitForAnswer(1)).toBeNull();
  });

  it("is woken when the check is answered some other way", async () => {
    let finish!: (r: CheckAttemptResult) => void;
    const checks = new StoredPasswordChecks(() => new Promise<CheckAttemptResult>((resolve) => (finish = resolve)));
    checks.open(1);
    await vi.advanceTimersByTimeAsync(0);
    const waiting = checks.waitForAnswer(1);
    checks.close(1);
    expect(await waiting).toBeNull();
    finish("unanswered");
    await vi.advanceTimersByTimeAsync(HOUR);
    expect(checks.isOpen(1)).toBe(false);
  });
});
