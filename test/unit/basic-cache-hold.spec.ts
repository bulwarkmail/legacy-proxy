// The login hold on an address and user name applies before anything answers
// a Basic header: a header validated earlier from another address, and a
// login for the same header that is still running, are answered 429 from the
// held address too. The user's own client on another address is a different
// pair and keeps working.

import fs from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { bootProxy, startFakeImap, type FakeImap } from "./fake-imap.js";

let imap: FakeImap;
let app: FastifyInstance;
let dir: string;
beforeAll(async () => {
  imap = await startFakeImap({ "xia@test.local": "right-password", "yan@test.local": "right-password" });
  ({ app, dir } = await bootProxy(imap));
}, 60_000);
afterAll(async () => {
  await app.close();
  await imap.close();
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* left for the OS temp cleanup */
  }
});

const session = (user: string, pass: string, remoteAddress: string) =>
  app.inject({
    method: "GET",
    url: "/jmap/session",
    headers: { authorization: "Basic " + Buffer.from(`${user}:${pass}`).toString("base64") },
    remoteAddress,
  });

describe("a held address and a Basic header validated elsewhere", () => {
  it("answers the right password from the held address with 429, like every other attempt", async () => {
    // The user's client, at home.
    expect((await session("xia@test.local", "right-password", "192.0.2.10")).statusCode).toBe(200);
    // Another address: ten wrong passwords, then held.
    for (let i = 0; i < 10; i++) expect((await session("xia@test.local", `wrong-${i}`, "198.51.100.66")).statusCode).toBe(401);
    const loginsAtHold = imap.logins;
    const answers: number[] = [];
    for (let i = 0; i < 200; i++) answers.push((await session("xia@test.local", `wrong-more-${i}`, "198.51.100.66")).statusCode);
    expect(answers.every((s) => s === 429)).toBe(true);
    expect(imap.logins).toBe(loginsAtHold);
    expect((await session("xia@test.local", "right-password", "198.51.100.66")).statusCode).toBe(429);
    // The user's own client is a different pair.
    expect((await session("xia@test.local", "right-password", "192.0.2.10")).statusCode).toBe(200);
  });

  it("does not let a held address join a login for the same header that is still running", async () => {
    for (let i = 0; i < 10; i++) expect((await session("yan@test.local", `wrong-${i}`, "198.51.100.77")).statusCode).toBe(401);
    // The user's client starts a login; the held address sends the same header while it runs.
    const [mine, held] = await Promise.all([
      session("yan@test.local", "right-password", "192.0.2.20"),
      session("yan@test.local", "right-password", "198.51.100.77"),
    ]);
    expect(mine.statusCode).toBe(200);
    expect(held.statusCode).toBe(429);
  });
});
