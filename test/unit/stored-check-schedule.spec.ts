// A check of a stored password that gets no answer tries again on a timer
// with growing delays, a bounded number of times per hour, and stops at the
// first answer. Requests it holds wait for an attempt that is due and are
// then told when to come back.

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
  it("are at most 11 in the first hour and 6 in each hour after", async () => {
    let attempts = 0;
    const checks = new StoredPasswordChecks(async () => {
      attempts++;
      return "unanswered";
    });
    checks.open(1);
    await vi.advanceTimersByTimeAsync(HOUR - 1);
    expect(attempts).toBe(11);
    await vi.advanceTimersByTimeAsync(HOUR);
    expect(attempts).toBe(17);
    await vi.advanceTimersByTimeAsync(HOUR);
    expect(attempts).toBe(23);
    checks.closeAll();
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
