// A check whose attempts never get an answer: attempts per hour over its
// day, the expiry at 24 hours, nothing after; and a check resumed after a
// restart keeps both the schedule and the 24 hours.

import { afterEach, describe, expect, it, vi } from "vitest";
import { CHECK_MAX_OPEN_MS, StoredPasswordChecks } from "../../src/auth/storedCheck.js";

afterEach(() => vi.useRealTimers());

describe("a check without an answer, over its day", () => {
  it("makes 11 attempts in the first hour, one an hour after, 34 in all, then expires once", async () => {
    vi.useFakeTimers();
    const t0 = Date.now();
    const attemptsAt: number[] = [];
    const expiredAt: number[] = [];
    const checks = new StoredPasswordChecks(
      async () => {
        attemptsAt.push(Date.now() - t0);
        return "unanswered";
      },
      { expire: () => void expiredAt.push(Date.now() - t0) },
    );
    checks.open(1, { openedAt: t0 });
    await vi.advanceTimersByTimeAsync(7 * 24 * 3600_000);
    const perHour = Array.from({ length: 24 }, (_, h) => attemptsAt.filter((t) => t >= h * 3600_000 && t < (h + 1) * 3600_000).length);
    expect(perHour[0]).toBe(11);
    expect(perHour.slice(1).every((n) => n <= 1)).toBe(true);
    expect(attemptsAt.length).toBe(34);
    expect(expiredAt).toEqual([CHECK_MAX_OPEN_MS]);
    expect(checks.isOpen(1)).toBe(false);
  });

  it("resumed after a restart, keeps the schedule and the 24 hours", async () => {
    vi.useFakeTimers();
    const opened = Date.now() - 20 * 3600_000; // opened 20 hours before the restart
    let attempts = 0;
    const expired: number[] = [];
    const checks = new StoredPasswordChecks(
      async () => {
        attempts++;
        return "unanswered";
      },
      { expire: () => void expired.push(Date.now() - opened) },
    );
    // 30 attempts made before the restart, the last 30 minutes ago.
    checks.open(1, { attempts: 30, lastAt: Date.now() - 30 * 60_000, openedAt: opened });
    await vi.advanceTimersByTimeAsync(10 * 3600_000);
    expect(attempts).toBe(4);
    expect(expired).toEqual([CHECK_MAX_OPEN_MS]);
  });

  it("resumed past its 24 hours, expires at once without an attempt", async () => {
    vi.useFakeTimers();
    let attempts = 0;
    let expired = 0;
    const checks = new StoredPasswordChecks(
      async () => {
        attempts++;
        return "unanswered";
      },
      { expire: () => void expired++ },
    );
    checks.open(1, { attempts: 12, lastAt: Date.now() - 3 * 3600_000, openedAt: Date.now() - 25 * 3600_000 });
    await vi.advanceTimersByTimeAsync(1000);
    expect({ attempts, expired }).toEqual({ attempts: 0, expired: 1 });
  });
});
