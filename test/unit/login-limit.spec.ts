import { describe, expect, it } from "vitest";
import { LoginLimiter, addressKey, type LoginGate } from "../../src/auth/loginLimit.js";

function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

async function fail(limiter: LoginLimiter, address: string, user: string, times: number) {
  for (let i = 0; i < times; i++) {
    const gate = await limiter.begin(address, user);
    if (!gate.ok) throw new Error(`held after ${i}`);
    gate.finish("refused");
  }
}

const held = (gate: LoginGate) => (gate.ok ? "open" : gate.status);

describe("LoginLimiter", () => {
  it("holds a pair after ten failures until the oldest leaves the window", async () => {
    const c = clock();
    const limiter = new LoginLimiter({ now: c.now });
    await fail(limiter, "198.51.100.1", "carol", 10);
    const gate = await limiter.begin("198.51.100.1", "carol");
    expect(gate).toEqual({ ok: false, status: 429, retryAfterSec: 900 });
    c.advance(15 * 60_000 + 1);
    expect(held(await limiter.begin("198.51.100.1", "carol"))).toBe("open");
  });

  it("counts user names without regard to case or surrounding space", async () => {
    const limiter = new LoginLimiter();
    await fail(limiter, "198.51.100.1", "Carol@Example.org", 10);
    expect(held(await limiter.begin("198.51.100.1", " carol@example.org"))).toBe(429);
  });

  it("does not count errors that are not refusals", async () => {
    const limiter = new LoginLimiter();
    for (let i = 0; i < 30; i++) {
      const gate = await limiter.begin("198.51.100.1", "carol");
      if (!gate.ok) throw new Error("held");
      gate.finish("error");
    }
    expect(held(await limiter.begin("198.51.100.1", "carol"))).toBe("open");
  });

  it("clears the pair on success, not the address", async () => {
    const limiter = new LoginLimiter({ maxPerAddress: 12 });
    await fail(limiter, "198.51.100.1", "carol", 9);
    const ok = await limiter.begin("198.51.100.1", "carol");
    if (!ok.ok) throw new Error("held");
    ok.finish("accepted");
    await fail(limiter, "198.51.100.1", "carol", 3);
    // 12 failures from the address: the address is held whatever the user.
    expect(held(await limiter.begin("198.51.100.1", "dave"))).toBe(429);
  });

  it("counts attempts still running against the budget", async () => {
    const limiter = new LoginLimiter({ maxPerUser: 3 });
    const running = await Promise.all([1, 2, 3].map(() => limiter.begin("198.51.100.1", "carol")));
    expect(running.map(held)).toEqual(["open", "open", "open"]);
    expect(await limiter.begin("198.51.100.1", "carol")).toEqual({ ok: false, status: 429, retryAfterSec: 1 });
    for (const g of running) if (g.ok) g.finish("accepted");
    expect(held(await limiter.begin("198.51.100.1", "carol"))).toBe("open");
  });

  it("lets a bounded number of logins run at once and refuses the rest after a short wait", async () => {
    const limiter = new LoginLimiter({ maxInFlight: 2, maxWaitMs: 20 });
    const a = await limiter.begin("198.51.100.1", "a");
    const b = await limiter.begin("198.51.100.2", "b");
    expect(await limiter.begin("198.51.100.3", "c")).toMatchObject({ ok: false, status: 503 });
    // A slot that comes free goes to the next caller waiting for one.
    const waiting = limiter.begin("198.51.100.4", "d");
    if (a.ok) a.finish("accepted");
    expect(held(await waiting)).toBe("open");
    if (b.ok) b.finish("accepted");
  });

  it("stays bounded in size", async () => {
    const limiter = new LoginLimiter({ maxKeys: 100, maxPerAddress: 1_000_000 });
    for (let i = 0; i < 1000; i++) await fail(limiter, `198.51.${i >> 8}.${i & 255}`, `user${i}`, 1);
    expect(limiter.trackedKeys).toBeLessThanOrEqual(200);
  });
});

describe("addressKey", () => {
  it("counts an IPv6 client by its /64 and an IPv4-mapped one as IPv4", () => {
    expect(addressKey("2001:db8:1:2:aaaa::1")).toBe(addressKey("2001:db8:1:2:bbbb:cccc:dddd:eeee"));
    expect(addressKey("2001:db8:1:2::1")).not.toBe(addressKey("2001:db8:1:3::1"));
    expect(addressKey("::ffff:192.0.2.7")).toBe("192.0.2.7");
    expect(addressKey("192.0.2.7")).toBe("192.0.2.7");
  });
});
