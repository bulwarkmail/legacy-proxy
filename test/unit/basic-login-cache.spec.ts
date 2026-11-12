// The cache of validated Basic logins is keyed by the decoded credentials, so
// spellings of one header share one entry and one login; it forgets lapsed
// entries after a day and never holds more than its size cap; and one account
// re-validates at most three logins at once.

import fs from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { bootProxy } from "./fake-imap.js";
import { startScriptedImap, type ScriptedImap } from "./scripted-imap.js";
import { BasicLoginCache } from "../../src/auth/basicCache.js";

describe("BasicLoginCache", () => {
  const entry = (accountId: number) => ({ accountId, gen: 0, tag: `t${accountId}` });

  it("never holds more entries than its cap, dropping the ones validated longest ago", () => {
    let now = 1_000_000;
    const cache = new BasicLoginCache({ maxEntries: 100, now: () => now });
    for (let i = 0; i < 1_000; i++) {
      cache.set(`k${i}`, entry(i));
      now += 10;
      expect(cache.size).toBeLessThanOrEqual(100);
    }
    expect(cache.size).toBe(100);
    expect(cache.valid("k999")).toBeDefined();
    expect(cache.valid("k0")).toBeUndefined();
    expect(cache.lapsed("k0")).toBeUndefined();
  });

  it("answers for five minutes, then marks the credentials as validated before for a day, then forgets them", () => {
    let now = 1_000_000;
    const cache = new BasicLoginCache({ now: () => now });
    cache.set("k", entry(1));
    now += 5 * 60_000 - 1;
    expect(cache.valid("k")).toBeDefined();
    now += 1;
    expect(cache.valid("k")).toBeUndefined();
    expect(cache.lapsed("k")).toBeDefined();
    now += 24 * 60 * 60_000;
    expect(cache.lapsed("k")).toBeUndefined();
    expect(cache.size).toBe(0);
  });

  it("removes forgotten entries when others are added, without being asked about them", () => {
    let now = 1_000_000;
    const cache = new BasicLoginCache({ now: () => now });
    for (let i = 0; i < 500; i++) cache.set(`old${i}`, entry(i));
    now += 25 * 60 * 60_000;
    cache.set("new", entry(1));
    expect(cache.size).toBe(1);
  });
});

describe("Basic logins at the proxy", () => {
  let slowFor = 0;
  let inFlight = 0;
  let mostInFlight = 0;
  let imap: ScriptedImap;
  let app: FastifyInstance;
  let dir: string;
  beforeAll(async () => {
    imap = await startScriptedImap(async (user, pass) => {
      if (user === "ivy@test.local") {
        inFlight++;
        mostInFlight = Math.max(mostInFlight, inFlight);
        if (slowFor) await new Promise((r) => setTimeout(r, slowFor));
        inFlight--;
        return ["p1", "p2", "p3", "p4"].includes(pass) ? "ok" : "no";
      }
      return pass === "pw" ? "ok" : "no";
    });
    ({ app, dir } = await bootProxy(imap as never));
  }, 60_000);
  afterAll(async () => {
    vi.useRealTimers();
    await app.close();
    await imap.close();
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* left for the OS temp cleanup */
    }
  });

  const session = (authorization: string, remoteAddress = "192.0.2.30") =>
    app.inject({ method: "GET", url: "/jmap/session", headers: { authorization }, remoteAddress });
  const loginsOf = (user: string) => imap.attempts.filter((a) => a.user === user).length;

  it("logs in once for every spelling of one header", async () => {
    const v = Buffer.from("una@test.local:pw").toString("base64");
    const spellings = [`Basic ${v}`, `Basic ${v.slice(0, 3)} ${v.slice(3)}`, `Basic  ${v}`, `Basic ${v.slice(0, 7)}  ${v.slice(7)} `];
    for (const h of spellings) expect((await session(h)).statusCode).toBe(200);
    expect(loginsOf("una@test.local")).toBe(1);
  });

  it("re-validates at most three logins of one account at once", async () => {
    const start = Date.now();
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(start);
      const headers = ["p1", "p2", "p3", "p4"].map((p) => "Basic " + Buffer.from(`ivy@test.local:${p}`).toString("base64"));
      // Four devices with four app passwords; the proxy checks the stored one next to each new one.
      for (const h of headers) expect((await session(h)).statusCode).toBe(200);
      for (let i = 0; i < 200 && loginsOf("ivy@test.local") < 7; i++) await new Promise((r) => setTimeout(r, 20));
      expect(loginsOf("ivy@test.local")).toBe(7);
      // Their entries lapse; all four re-validate at once while logins are slow.
      vi.setSystemTime(start + 6 * 60_000);
      slowFor = 1_000;
      mostInFlight = 0;
      const statuses = (await Promise.all(headers.map((h, i) => session(h, `192.0.2.${40 + i}`)))).map((r) => r.statusCode);
      slowFor = 0;
      expect(mostInFlight).toBe(3);
      expect(statuses.filter((s) => s === 200)).toHaveLength(3);
      expect(statuses.filter((s) => s === 503)).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  }, 30_000);
});
