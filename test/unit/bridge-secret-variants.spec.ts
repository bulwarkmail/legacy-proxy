// A bridge secret is never offered to the IMAP server, also with white space
// in front (as a pasted one may have) or in another field or route. Boots the
// real server with a Gmail client file of fake values, like
// gmail-bridge-login.spec.ts; nothing talks to Google.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { startFakeImap, type FakeImap } from "./fake-imap.js";

let imap: FakeImap;
let app: FastifyInstance;
let dir: string;
beforeAll(async () => {
  imap = await startFakeImap({ "pat@test.local": "right-password" });
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "legacy-proxy-bridge-"));
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

const secret = (prefix: string) => prefix + crypto.randomBytes(32).toString("base64url");
const basic = (user: string, pass: string) => "Basic " + Buffer.from(`${user}:${pass}`).toString("base64");
const reachedImap = (s: string) => imap.lines.some((l) => l.includes(s) || Buffer.from(l, "base64").toString("latin1").includes(s));

describe("bridge secrets with something around them", () => {
  it("does not send a bridge password with a leading space to the IMAP server", async () => {
    const s = secret("gmap_");
    await app.inject({ method: "POST", url: "/api/login", payload: { username: "pat@test.local", password: ` ${s}` } });
    expect(reachedImap(s)).toBe(false);
  });

  it("does not send a bridge secret with leading white space over Basic either", async () => {
    for (const pad of ["\t", "  ", "\n"]) {
      const s = secret("gmat_");
      const res = await app.inject({
        method: "GET",
        url: "/jmap/session",
        headers: { authorization: basic("pat@test.local", `${pad}${s}`) },
      });
      expect(res.statusCode, JSON.stringify(pad)).toBe(401);
      expect(reachedImap(s), JSON.stringify(pad)).toBe(false);
    }
  });

  it("does not send a sign-in token as a Basic password over the event stream route", async () => {
    const s = secret("gmat_");
    const res = await app.inject({
      method: "GET",
      url: "/jmap/eventsource?types=*",
      headers: { authorization: basic("pat@test.local", s) },
    });
    expect(res.statusCode).toBe(401);
    expect(reachedImap(s)).toBe(false);
  });

  it("does not send a refresh token offered as an XOAUTH2 access token", async () => {
    const s = secret("gmrt_");
    const res = await app.inject({
      method: "POST",
      url: "/api/login",
      payload: { username: "pat@test.local", accessToken: s, mech: "XOAUTH2" },
    });
    expect(res.statusCode).toBe(401);
    expect(reachedImap(s)).toBe(false);
  });
});
