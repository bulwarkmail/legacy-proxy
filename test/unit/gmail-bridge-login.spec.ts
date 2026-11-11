// With the Gmail backend configured, a bridge secret offered as a mail
// password (on /api/login, or over Basic on the JMAP routes) is answered 401
// and never sent to the IMAP server. Boots the real server with a Gmail client
// file of fake values; nothing here talks to Google.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { startFakeImap, type FakeImap } from "./sec-fake-imap.js";

let imap: FakeImap;
let app: FastifyInstance;
let dir: string;
beforeAll(async () => {
  imap = await startFakeImap({ "pat@test.local": "right-password" });
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "lproxy-gmail-login-"));
  fs.writeFileSync(
    path.join(dir, "providers.json"),
    JSON.stringify({
      generic: {
        imap: { host: "127.0.0.1", port: imap.port, secure: false },
        smtp: { host: "127.0.0.1", port: 1, secure: false },
        sieve: null,
        carddav: null,
        auth: { mech: ["PLAIN"] },
      },
    }),
  );
  fs.writeFileSync(path.join(dir, "google.json"), JSON.stringify({ web: { client_id: "fake-id", client_secret: "fake-secret" } }));
  Object.assign(process.env, {
    PORT: "0",
    LISTEN_HOST: "127.0.0.1",
    PUBLIC_URL: "http://127.0.0.1",
    DATA_DIR: dir,
    PROVIDERS_FILE: path.join(dir, "providers.json"),
    DEFAULT_PROVIDER: "generic",
    VAULT_KEY: crypto.randomBytes(32).toString("base64"),
    SESSION_HMAC_KEY: crypto.randomBytes(32).toString("base64"),
    LOG_LEVEL: "silent",
    GMAIL_OAUTH_CLIENT_FILE: path.join(dir, "google.json"),
    GMAIL_ALLOWED_EMAILS: "owner@gmail.test",
  });
  ({ app } = (await import("../../src/server.js")) as unknown as { app: FastifyInstance });
  await app.ready();
}, 60_000);
afterAll(async () => {
  delete process.env.GMAIL_OAUTH_CLIENT_FILE;
  delete process.env.GMAIL_ALLOWED_EMAILS;
  await app?.close();
  await imap?.close();
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* left for the OS temp cleanup */
  }
});

const basic = (user: string, pass: string) => "Basic " + Buffer.from(`${user}:${pass}`).toString("base64");

describe("bridge secrets offered as mail passwords", () => {
  it("answers /api/login with 401 without an IMAP login", async () => {
    const before = imap.logins;
    for (const payload of [
      { username: "pat@test.local", password: "gmap_" + "a".repeat(43) },
      { username: "pat@test.local", password: "gmat_" + "b".repeat(43) },
      { username: "pat@test.local", accessToken: "gmrt_" + "c".repeat(43) },
    ]) {
      const res = await app.inject({ method: "POST", url: "/api/login", payload });
      expect(res.statusCode).toBe(401);
    }
    expect(imap.logins).toBe(before);
  });

  it("answers Basic on the JMAP routes with 401 without an IMAP login", async () => {
    const before = imap.logins;
    for (const url of ["/jmap/session", "/%6Amap/session"]) {
      const res = await app.inject({ method: "GET", url, headers: { authorization: basic("pat@test.local", "gmat_" + "d".repeat(43)) } });
      expect(res.statusCode, url).toBe(401);
    }
    expect(imap.logins).toBe(before);
  });

  it("still sends any other password to the IMAP server", async () => {
    const before = imap.logins;
    const res = await app.inject({
      method: "POST",
      url: "/api/login",
      payload: { username: "pat@test.local", password: "right-password" },
    });
    expect(res.statusCode).toBe(200);
    expect(imap.logins - before).toBe(1);
  });
});
