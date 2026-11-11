// Behind a reverse proxy every caller arrives from the proxy's address. With
// TRUST_PROXY set, the login limits count by the address the reverse proxy
// names in X-Forwarded-For instead.

import fs from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { bootProxy, startFakeImap, type FakeImap } from "./fake-imap.js";

let imap: FakeImap;
let app: FastifyInstance;
let dir: string;
beforeAll(async () => {
  imap = await startFakeImap({ "carol@test.local": "right-password" });
  process.env.TRUST_PROXY = "1";
  ({ app, dir } = await bootProxy(imap));
}, 60_000);
afterAll(async () => {
  delete process.env.TRUST_PROXY;
  await app.close();
  await imap.close();
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* left for the OS temp cleanup */
  }
});

const login = (client: string, password: string) =>
  app.inject({
    method: "POST",
    url: "/api/login",
    remoteAddress: "127.0.0.1",
    headers: { "x-forwarded-for": client },
    payload: { username: "carol@test.local", password },
  });

describe("TRUST_PROXY", () => {
  it("counts each forwarded client on its own", async () => {
    for (let i = 0; i < 10; i++) expect((await login("203.0.113.1", `wrong-${i}`)).statusCode).toBe(401);
    expect((await login("203.0.113.1", "wrong")).statusCode).toBe(429);

    const before = imap.failedLogins;
    expect((await login("203.0.113.2", "wrong")).statusCode).toBe(401);
    expect(imap.failedLogins - before).toBe(1);
  });
});
