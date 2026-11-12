// Signed-in Basic clients re-validate their login every five minutes, in
// login slots of their own. One user's own valid header, sent in many
// spellings (base64 with spaces decodes to the same credentials) from many
// addresses at once, is one re-validation, so it can't keep another user's
// re-validation from getting a slot. (Logins at the scripted server take 6 s
// during the burst so the slots stay busy while the other user asks.)

import fs from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { bootProxy } from "./fake-imap.js";
import { startScriptedImap, type ScriptedImap } from "./scripted-imap.js";

let slowFor = 0;
let imap: ScriptedImap;
let app: FastifyInstance;
let dir: string;
beforeAll(async () => {
  imap = await startScriptedImap(async (user, pass) => {
    if (user === "mal@test.local" && slowFor) await new Promise((r) => setTimeout(r, slowFor));
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

const b64 = (user: string) => Buffer.from(`${user}:pw`).toString("base64");
/** The same credentials, spelled differently: a space after the n-th base64 character. */
const spelling = (user: string, n: number) => {
  const v = b64(user);
  return n === 0 ? `Basic ${v}` : `Basic ${v.slice(0, n)} ${v.slice(n)}`;
};
const session = (authorization: string, remoteAddress: string) =>
  app.inject({ method: "GET", url: "/jmap/session", headers: { authorization }, remoteAddress });

describe("re-validation slots", () => {
  it("are not used up by one user's own valid header in many spellings", async () => {
    const start = Date.now();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(start);
    // Another user's webmail, validated and cached.
    expect((await session(spelling("bob@test.local", 0), "192.0.2.20")).statusCode).toBe(200);
    // The other user validates 24 spellings of their own header.
    const n = b64("mal@test.local").length;
    const spellings = Array.from({ length: 24 }, (_, i) => spelling("mal@test.local", 1 + (i % (n - 1))) + " ".repeat(Math.floor(i / (n - 1))));
    for (const h of spellings) expect((await session(h, "198.51.100.1")).statusCode).toBe(200);
    // Five minutes later every entry has lapsed; the burst comes from 24 addresses.
    vi.setSystemTime(start + 6 * 60_000);
    slowFor = 6_000;
    const burst = spellings.map((h, i) => session(h, `198.51.100.${10 + i}`));
    await new Promise((r) => setTimeout(r, 300));
    const bob = await session(spelling("bob@test.local", 0), "192.0.2.20");
    slowFor = 0;
    await Promise.all(burst);
    vi.useRealTimers();
    expect(bob.statusCode).toBe(200);
  }, 60_000);
});
