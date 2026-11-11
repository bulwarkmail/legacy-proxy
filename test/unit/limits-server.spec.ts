// Per-account limits on the routes: stored uploads and concurrent JMAP
// requests. The proxy is booted with small limits so the test stays cheap.

import fs from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { bootProxy, startFakeImap, type FakeImap } from "./sec-fake-imap.js";

let imap: FakeImap;
let app: FastifyInstance;
let dir: string;
let token = "";
let accountId = "";
beforeAll(async () => {
  imap = await startFakeImap({ "max@test.local": "right-password" });
  process.env.MAX_UPLOAD_STORAGE_PER_ACCOUNT = "1000";
  process.env.MAX_CONCURRENT_REQUESTS = "1";
  ({ app, dir } = await bootProxy(imap));
  const login = await app.inject({ method: "POST", url: "/api/login", payload: { username: "max@test.local", password: "right-password" } });
  ({ token, accountId } = login.json() as { token: string; accountId: string });
}, 60_000);
afterAll(async () => {
  delete process.env.MAX_UPLOAD_STORAGE_PER_ACCOUNT;
  delete process.env.MAX_CONCURRENT_REQUESTS;
  await app?.close();
  await imap?.close();
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* left for the OS temp cleanup */
  }
});

const upload = (bytes: number) =>
  app.inject({
    method: "POST",
    url: `/jmap/upload/${accountId}`,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/octet-stream" },
    payload: Buffer.alloc(bytes, 0x61),
  });

describe("per-account limits", () => {
  it("refuses an upload that fits alone but not with what the account has stored", async () => {
    expect((await upload(600)).statusCode).toBe(200);
    const res = await upload(600);
    expect(res.statusCode).toBe(413);
    expect(res.json()).toMatchObject({ type: "urn:ietf:params:jmap:error:limit", limit: "maxUploadStoragePerAccount" });
    expect((await upload(400)).statusCode).toBe(200);
  });

  it("refuses a JMAP request over maxConcurrentRequests before any method runs", async () => {
    const call = () =>
      app.inject({
        method: "POST",
        url: "/jmap",
        headers: { authorization: `Bearer ${token}` },
        payload: { using: ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail"], methodCalls: [["Mailbox/get", { accountId }, "0"]] },
      });
    const results = await Promise.all([call(), call(), call()]);
    const refused = results.filter((r) => r.statusCode === 400);
    expect(results.some((r) => r.statusCode === 200)).toBe(true);
    expect(refused.length).toBeGreaterThan(0);
    for (const r of refused) expect(r.json()).toMatchObject({ type: "urn:ietf:params:jmap:error:limit", limit: "maxConcurrentRequests" });
    // Once the others are answered, the account may send again.
    expect((await call()).statusCode).toBe(200);
  });
});
