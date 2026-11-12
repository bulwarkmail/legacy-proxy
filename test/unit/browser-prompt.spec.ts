// The browser's own password prompt: a 401 offers Bearer only to requests a
// browser made. A top-level navigation (a link, or window.open, to the
// proxy's /jmap/session) carries no Origin header but does carry
// Sec-Fetch-Mode: navigate; a page's fetch carries Origin. A client that is
// not a browser sends neither and is still offered Basic.

import fs from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { bootProxy, startFakeImap, type FakeImap } from "./fake-imap.js";

let imap: FakeImap;
let app: FastifyInstance;
let dir: string;
beforeAll(async () => {
  imap = await startFakeImap({ "uma@test.local": "pw" });
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

describe("the browser's own password prompt", () => {
  it("is not asked for on a top-level navigation from another site", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/jmap/session",
      headers: { "sec-fetch-mode": "navigate", "sec-fetch-dest": "document", "sec-fetch-site": "cross-site" },
    });
    expect(res.statusCode).toBe(401);
    expect(String(res.headers["www-authenticate"])).not.toMatch(/basic/i);
  });

  it("is not asked for by a page with an opaque origin", async () => {
    const res = await app.inject({ method: "GET", url: "/jmap/session", headers: { origin: "null" } });
    expect(String(res.headers["www-authenticate"])).not.toMatch(/basic/i);
  });

  it("is not asked for by the 401 of /api/logout from a page", async () => {
    const res = await app.inject({ method: "POST", url: "/api/logout", headers: { origin: "https://other.example" } });
    expect(res.statusCode).toBe(401);
    expect(String(res.headers["www-authenticate"])).not.toMatch(/basic/i);
  });

  it("still offers Basic to a client that is not a browser", async () => {
    const res = await app.inject({ method: "GET", url: "/jmap/session" });
    expect(String(res.headers["www-authenticate"])).toMatch(/basic/i);
  });
});

describe("the event stream", () => {
  it("carries no Allow-Credentials on the stream itself or its preflight, whatever the origin", async () => {
    const login = await app.inject({ method: "POST", url: "/api/login", payload: { username: "uma@test.local", password: "pw" } });
    const token = login.json().token as string;
    const pre = await app.inject({
      method: "OPTIONS",
      url: "/jmap/eventsource?types=*",
      headers: { origin: "https://other.example", "access-control-request-method": "GET", "access-control-request-headers": "authorization" },
    });
    expect(pre.headers["access-control-allow-credentials"]).toBeUndefined();
    const res = await app.inject({
      method: "GET",
      url: "/jmap/eventsource?types=*&closeafter=state&ping=15",
      headers: { authorization: `Bearer ${token}`, origin: "https://other.example" },
      payloadAsStream: true,
    });
    expect(res.headers["access-control-allow-credentials"]).toBeUndefined();
    (res as unknown as { stream: () => NodeJS.ReadableStream }).stream?.().on?.("error", () => {});
  });
});
