// A check that opened 25 hours before the proxy starts (a restart) is
// answered "refused" at start, without a login: the old session gets 401, the
// new one is served, the subscription made before the check is gone, and the
// new password is in the row. Scripted IMAP on 127.0.0.1.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { startScriptedImap, type ScriptedImap } from "./scripted-imap.js";
import { Store } from "../../src/state/store.js";
import { sealCredentials, openCredentials } from "../../src/auth/credentials.js";
import { credentialTag, makeSession, signSession } from "../../src/auth/session.js";

const USER = "rae@test.local";
const vaultKey = crypto.randomBytes(32);
const hmacKey = crypto.randomBytes(32);
let imap: ScriptedImap;
let app: FastifyInstance;
let dir: string;
let oldToken = "";
let newToken = "";
let accountId = 0;

beforeAll(async () => {
  imap = await startScriptedImap((user, pass) => (user === USER && pass === "new-password" ? "ok" : user === USER && pass === "old-password" ? "unavailable" : "no"));
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "legacy-proxy-test-"));
  fs.writeFileSync(
    path.join(dir, "providers.json"),
    JSON.stringify({ generic: { imap: { host: "127.0.0.1", port: imap.port, secure: false }, smtp: { host: "127.0.0.1", port: 1, secure: false }, sieve: null, carddav: null, auth: { mech: ["PLAIN"] } } }),
  );
  // The state the proxy left behind: a check opened 25 hours ago, still without an answer.
  const store = new Store(dir);
  const oldCreds = { mech: "PLAIN" as const, username: USER, password: "old-password" };
  const newCreds = { mech: "PLAIN" as const, username: USER, password: "new-password" };
  const row = store.upsertAccount({ slug: `generic:${USER}`, kind: "generic", host: "127.0.0.1", username: USER, vault: await sealCredentials(vaultKey, oldCreds) });
  accountId = row.id;
  const since = Date.now() - 25 * 3600_000;
  store.insertPushSubscription({
    id: "made-before",
    accountId: row.id,
    deviceClientId: null,
    url: "https://relay.example/x",
    types: null,
    expires: Date.now() + 7 * 86400_000,
    verificationCode: null,
    verified: true,
    createdAt: since - 60_000,
    lastPushAt: null,
  });
  store.openCredentialCheck(row.id, { vault: await sealCredentials(vaultKey, newCreds), tag: credentialTag(vaultKey, newCreds), since });
  for (let i = 0; i < 12; i++) store.noteCheckAttempt(row.id, since, since + i * 60_000);
  store.close();
  oldToken = signSession(hmacKey, makeSession({ accountSlug: `generic:${USER}`, username: USER, gen: row.cred_gen, cf: credentialTag(vaultKey, oldCreds) }));
  newToken = signSession(hmacKey, makeSession({ accountSlug: `generic:${USER}`, username: USER, gen: row.cred_gen, cf: credentialTag(vaultKey, newCreds) }));

  Object.assign(process.env, {
    PORT: "0",
    LISTEN_HOST: "127.0.0.1",
    PUBLIC_URL: "http://127.0.0.1",
    DATA_DIR: dir,
    PROVIDERS_FILE: path.join(dir, "providers.json"),
    DEFAULT_PROVIDER: "generic",
    VAULT_KEY: vaultKey.toString("base64"),
    SESSION_HMAC_KEY: hmacKey.toString("base64"),
    LOG_LEVEL: "silent",
  });
  delete process.env.GMAIL_OAUTH_CLIENT_FILE;
  ({ app } = (await import("../../src/server.js")) as unknown as { app: FastifyInstance });
  await app.ready();
  await new Promise((r) => setTimeout(r, 500));
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

describe("a check past its 24 hours when the proxy starts", () => {
  it("is answered refused at once, without a login", async () => {
    const session = (token: string) => app.inject({ method: "GET", url: "/jmap/session", headers: { authorization: `Bearer ${token}` } });
    expect((await session(oldToken)).statusCode).toBe(401);
    expect((await session(newToken)).statusCode).toBe(200);
    expect(imap.attempts.filter((a) => a.pass === "old-password")).toEqual([]);
    const store = new Store(dir);
    try {
      const row = store.getAccountById(accountId)!;
      expect(row.cred_check_tag ?? null).toBeNull();
      expect((await openCredentials(vaultKey, row.vault)).password).toBe("new-password");
      expect(store.getPushSubscription("made-before", accountId)).toBeNull();
    } finally {
      store.close();
    }
  });
});
