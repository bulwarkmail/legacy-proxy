// The failure counters behind the login limits are bounded in size. When they
// are full, a failure from a new address costs a few reads of the counters,
// not a pass over all of them: the work per request stays the same however
// many addresses are tracked. Counted by reading the counters' maps.

import { describe, expect, it } from "vitest";
import { LoginLimiter } from "../../src/auth/loginLimit.js";

const ipv4 = (i: number) => `10.${(i >> 16) & 255}.${(i >> 8) & 255}.${i & 255}`;

/** Entries read from any Map while `run` runs (the limiter keeps its counters in maps). */
function mapReads(run: () => void): number {
  let reads = 0;
  const proto = Map.prototype as unknown as Record<PropertyKey, (this: Map<unknown, unknown>) => Iterator<unknown>>;
  const names = [Symbol.iterator, "keys", "values", "entries"] as const;
  const originals = names.map((n) => proto[n]!);
  names.forEach((n, i) => {
    const original = originals[i]!;
    proto[n] = function (this: Map<unknown, unknown>) {
      const it = original.call(this);
      return {
        next() {
          const r = it.next();
          if (!r.done) reads++;
          return r;
        },
        [Symbol.iterator]() {
          return this;
        },
      } as Iterator<unknown>;
    };
  });
  try {
    run();
  } finally {
    names.forEach((n, i) => {
      proto[n] = originals[i]!;
    });
  }
  return reads;
}

/** A limiter whose failed-lookup counters are full of live entries, one per address. */
function full(keys: number, now: () => number) {
  const limiter = new LoginLimiter({ maxKeys: keys, now });
  for (let i = 0; i < keys; i++) limiter.noteFailedLookup(ipv4(i));
  return limiter;
}

describe("full failure counters", () => {
  it("cost about the same per new address when twice as many addresses are tracked", () => {
    const readsFor = (keys: number) => {
      const limiter = full(keys, () => 1_000_000);
      return mapReads(() => {
        for (let i = 0; i < 200; i++) limiter.noteFailedLookup(ipv4(keys + i));
      });
    };
    const small = readsFor(2_000);
    const large = readsFor(4_000);
    expect(large, `${small} reads with 2,000 addresses tracked, ${large} with 4,000`).toBeLessThanOrEqual(small * 1.5 + 50);
    expect(large / 200, "reads per new address").toBeLessThan(10);
  });

  it("stay at their size and let the least recently failed address go first", () => {
    const limiter = full(100, () => 1_000_000);
    // A recent address that used up its budget stays held while others come and go.
    for (let i = 0; i < 50; i++) limiter.noteFailedLookup("203.0.113.1");
    for (let i = 0; i < 40; i++) limiter.noteFailedLookup(ipv4(1_000 + i));
    expect(limiter.trackedKeys).toBe(100);
    expect(limiter.noteFailedLookup("203.0.113.1")).toMatchObject({ ok: false, status: 429 });
    // The address that failed first is gone: it starts from zero again.
    for (let i = 0; i < 49; i++) expect(limiter.noteFailedLookup(ipv4(0))).toBeNull();
  });

  it("drop addresses whose failures left the window, a few at a time as new ones come", () => {
    let now = 1_000_000;
    const limiter = full(1_000, () => now);
    now += 16 * 60_000;
    const reads = mapReads(() => {
      for (let i = 0; i < 10; i++) limiter.noteFailedLookup(ipv4(5_000 + i));
    });
    expect(limiter.trackedKeys).toBe(10);
    // Each expired entry is read once on its way out.
    expect(reads).toBeLessThan(1_000 + 10 * 10);
  });
});
