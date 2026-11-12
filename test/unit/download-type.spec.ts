// The {type} segment of a download URL: the router decodes it once; a value
// that is not `type/subtype` falls back to the type the blob was stored with.

import fs from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { bootProxy, startFakeImap, type FakeImap } from "./fake-imap.js";

let imap: FakeImap;
let app: FastifyInstance;
let dir: string;
let token = "";
let accountId = "";
let blobId = "";
beforeAll(async () => {
  imap = await startFakeImap({ "nina@test.local": "right-password" });
  ({ app, dir } = await bootProxy(imap));
  const login = await app.inject({ method: "POST", url: "/api/login", payload: { username: "nina@test.local", password: "right-password" } });
  ({ token, accountId } = login.json() as { token: string; accountId: string });
  const upload = await app.inject({
    method: "POST",
    url: `/jmap/upload/${accountId}`,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/x-stored" },
    payload: Buffer.from("hello"),
  });
  ({ blobId } = upload.json() as { blobId: string });
}, 60_000);
afterAll(async () => {
  await app?.close();
  await imap?.close();
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* left for the OS temp cleanup */
  }
});

const download = (type: string) =>
  app.inject({
    method: "GET",
    url: `/jmap/download/${accountId}/${blobId}/${type}/hello.txt`,
    headers: { authorization: `Bearer ${token}` },
  });

describe("the type a download is served as", () => {
  it("falls back to the stored type for a segment that decodes to something else", async () => {
    for (const type of ["%25ZZ", "%2525", "not-a-type", "text%2Fhtml%3B%20x"]) {
      const res = await download(type);
      expect(res.statusCode, type).toBe(200);
      expect(res.headers["content-type"], type).toBe("application/x-stored");
    }
  });

  it("uses a type/subtype the URL names", async () => {
    const res = await download("text%2Fplain");
    expect(res.statusCode).toBe(200);
    expect(String(res.headers["content-type"])).toMatch(/^text\/plain/);
  });
});
