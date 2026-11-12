// Gmail bridge sign-ins: every refresh hands out a new refresh token. The one
// that was used still answers for a minute after its first use (two tabs that
// refresh together both carry on); presented again after that it is refused
// and every token of its sign-in stops working, while the account's other
// sign-ins carry on. A sign-in ends a year after it was made. Times are passed
// in, so nothing here waits.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { GmailStore } from "../../src/gmail/store.js";
import { GMAIL_READONLY } from "../../src/gmail/config.js";

const EMAIL = "owner@gmail.test";
const SECOND = 1000;
const DAY = 86400_000;
const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const f of cleanup.splice(0).reverse()) f();
});

function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "legacy-proxy-gmail-tokens-"));
  cleanup.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function openStore(dir: string) {
  const store = new GmailStore(dir, crypto.randomBytes(32));
  cleanup.push(() => store.close());
  return store;
}
async function connected(): Promise<GmailStore> {
  const store = openStore(tempDir());
  await store.save(
    EMAIL,
    { mech: "XOAUTH2", username: EMAIL, accessToken: "fake-access", refreshToken: "fake-refresh", scopes: [GMAIL_READONLY] },
    { profile: { emailAddress: EMAIL, historyId: "5", messagesTotal: 1, threadsTotal: 1 }, labels: [] },
  );
  return store;
}

describe("refreshing a bridge sign-in", () => {
  it("hands out a new refresh token every time, and the new tokens work", async () => {
    const store = await connected();
    const t0 = Date.now();
    const first = store.issueTokens(EMAIL, "webmail", t0);
    const second = store.refreshTokens(first.refreshToken, "webmail", t0 + 600 * SECOND);
    expect(second).not.toBeNull();
    expect(second!.refreshToken).not.toBe(first.refreshToken);
    expect(store.authenticateToken(second!.accessToken, t0 + 601 * SECOND)).toBe(EMAIL);
    const third = store.refreshTokens(second!.refreshToken, "webmail", t0 + 1200 * SECOND);
    expect(third!.refreshToken).not.toBe(second!.refreshToken);
    expect(third!.refreshToken).not.toBe(first.refreshToken);
  });

  it("answers a second tab that brings the same token a few seconds later, and both carry on", async () => {
    const store = await connected();
    const t0 = Date.now();
    const first = store.issueTokens(EMAIL, "webmail", t0);
    const tabA = store.refreshTokens(first.refreshToken, "webmail", t0 + 600 * SECOND);
    const tabB = store.refreshTokens(first.refreshToken, "webmail", t0 + 610 * SECOND);
    expect(tabA).not.toBeNull();
    expect(tabB).not.toBeNull();
    expect(tabB!.refreshToken).not.toBe(tabA!.refreshToken);
    expect(store.refreshTokens(tabA!.refreshToken, "webmail", t0 + 1200 * SECOND)).not.toBeNull();
    expect(store.refreshTokens(tabB!.refreshToken, "webmail", t0 + 1200 * SECOND)).not.toBeNull();
  });

  it("counts the minute from the token's first use; a second use does not extend it", async () => {
    const store = await connected();
    const t0 = Date.now();
    const first = store.issueTokens(EMAIL, "webmail", t0);
    const a = store.refreshTokens(first.refreshToken, "webmail", t0 + 600 * SECOND);
    const b = store.refreshTokens(first.refreshToken, "webmail", t0 + 640 * SECOND);
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    // 61 seconds after the first use, 21 after the second.
    expect(store.refreshTokens(first.refreshToken, "webmail", t0 + 661 * SECOND)).toBeNull();
  });

  it("refuses a token brought back after that minute and ends every token of its sign-in", async () => {
    const store = await connected();
    const t0 = Date.now();
    const first = store.issueTokens(EMAIL, "webmail", t0);
    const second = store.refreshTokens(first.refreshToken, "webmail", t0 + 600 * SECOND)!;
    expect(store.refreshTokens(first.refreshToken, "webmail", t0 + 900 * SECOND)).toBeNull();
    expect(store.refreshTokens(second.refreshToken, "webmail", t0 + 901 * SECOND)).toBeNull();
    expect(store.authenticateToken(second.accessToken, t0 + 901 * SECOND)).toBeNull();
    expect(store.authenticateToken(first.accessToken, t0 + 901 * SECOND)).toBeNull();
  });

  it("leaves the account's other sign-ins alone when one is ended that way", async () => {
    const store = await connected();
    const t0 = Date.now();
    const phone = store.issueTokens(EMAIL, "webmail", t0);
    const laptop = store.issueTokens(EMAIL, "webmail", t0);
    const next = store.refreshTokens(laptop.refreshToken, "webmail", t0 + 600 * SECOND)!;
    expect(store.refreshTokens(laptop.refreshToken, "webmail", t0 + 900 * SECOND)).toBeNull();
    expect(store.refreshTokens(next.refreshToken, "webmail", t0 + 901 * SECOND)).toBeNull();
    expect(store.authenticateToken(phone.accessToken, t0 + 902 * SECOND)).toBe(EMAIL);
    expect(store.refreshTokens(phone.refreshToken, "webmail", t0 + 902 * SECOND)).not.toBeNull();
  });

  it("refuses another client's refresh without ending the sign-in", async () => {
    const store = await connected();
    const t0 = Date.now();
    const first = store.issueTokens(EMAIL, "webmail", t0);
    expect(store.refreshTokens(first.refreshToken, "other-app", t0 + 600 * SECOND)).toBeNull();
    expect(store.refreshTokens(first.refreshToken, "webmail", t0 + 700 * SECOND)).not.toBeNull();
  });

  it("refuses a refresh once the account is disconnected", async () => {
    const store = await connected();
    const t0 = Date.now();
    const first = store.issueTokens(EMAIL, "webmail", t0);
    const second = store.refreshTokens(first.refreshToken, "webmail", t0 + 600 * SECOND)!;
    store.disconnect(EMAIL);
    expect(store.refreshTokens(second.refreshToken, "webmail", t0 + 700 * SECOND)).toBeNull();
  });

  it("ends the sign-in a year after it was made, however often it was refreshed", async () => {
    const store = await connected();
    const t0 = Date.now();
    let current = store.issueTokens(EMAIL, "webmail", t0).refreshToken;
    let lastWorking = 0;
    for (let day = 30; day <= 3 * 365; day += 30) {
      const next = store.refreshTokens(current, "webmail", t0 + day * DAY);
      if (!next) break;
      current = next.refreshToken;
      lastWorking = day;
    }
    expect(lastWorking).toBe(360);
  });

  it("still lets a refresh token lapse when it goes unused for 180 days", async () => {
    const store = await connected();
    const t0 = Date.now();
    const first = store.issueTokens(EMAIL, "webmail", t0);
    expect(store.refreshTokens(first.refreshToken, "webmail", t0 + 181 * DAY)).toBeNull();
  });

  it("ends the whole sign-in when its refresh token is revoked, a second tab's token too", async () => {
    const store = await connected();
    const t0 = Date.now();
    const first = store.issueTokens(EMAIL, "webmail", t0);
    const tabA = store.refreshTokens(first.refreshToken, "webmail", t0 + 600 * SECOND)!;
    const tabB = store.refreshTokens(first.refreshToken, "webmail", t0 + 605 * SECOND)!;
    store.revokeToken(tabA.refreshToken, "webmail");
    expect(store.refreshTokens(tabB.refreshToken, "webmail", t0 + 700 * SECOND)).toBeNull();
    expect(store.authenticateToken(tabB.accessToken, t0 + 700 * SECOND)).toBeNull();
  });
});

describe("tokens stored before sign-ins were recorded", () => {
  it("keep working and form a sign-in of their own, dated when the database was upgraded", () => {
    const dir = tempDir();
    const refresh = "gmrt_" + crypto.randomBytes(32).toString("base64url");
    const access = "gmat_" + crypto.randomBytes(32).toString("base64url");
    const hash = (t: string) => crypto.createHash("sha256").update(t).digest("hex");
    const writtenAt = Date.now();
    // The two tables as the bridge created them before.
    const old = new Database(path.join(dir, "gmail.sqlite3"));
    old.exec(`
      CREATE TABLE gmail_connection (email TEXT PRIMARY KEY, vault BLOB NOT NULL, snapshot TEXT NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE gmail_token (
        hash TEXT PRIMARY KEY, email TEXT NOT NULL, client TEXT NOT NULL, kind TEXT NOT NULL,
        parent TEXT, expires INTEGER NOT NULL
      );
    `);
    old.prepare("INSERT INTO gmail_connection VALUES (?,?,?,?)").run(EMAIL, Buffer.alloc(40), "{}", writtenAt);
    old.prepare("INSERT INTO gmail_token VALUES (?,?,?,'refresh',NULL,?)").run(hash(refresh), EMAIL, "webmail", writtenAt + 180 * DAY);
    old.prepare("INSERT INTO gmail_token VALUES (?,?,?,'access',?,?)").run(hash(access), EMAIL, "webmail", hash(refresh), writtenAt + 3600_000);
    old.close();

    const upgradedAt = Date.now();
    const store = openStore(dir);
    expect(store.authenticateToken(access, upgradedAt + 60 * SECOND)).toBe(EMAIL);
    const next = store.refreshTokens(refresh, "webmail", upgradedAt + 10 * DAY);
    expect(next).not.toBeNull();
    expect(next!.refreshToken).not.toBe(refresh);
    // Refreshed every 90 days: it works until a year after the upgrade, not longer.
    let current = next!.refreshToken;
    for (const day of [100, 190, 280, 360]) current = store.refreshTokens(current, "webmail", upgradedAt + day * DAY)!.refreshToken;
    expect(store.refreshTokens(current, "webmail", upgradedAt + 366 * DAY)).toBeNull();
  });
});
