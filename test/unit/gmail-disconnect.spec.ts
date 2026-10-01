import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { GmailStore } from "../../src/gmail/store.js";
import { GmailConnection } from "../../src/gmail/connection.js";
import { GMAIL_MODIFY } from "../../src/gmail/config.js";

const email = "gone@example.test";
const kept = "kept@example.test";
const snapshot = {
  profile: { emailAddress: email, historyId: "7", messagesTotal: 0, threadsTotal: 0 },
  labels: [],
};
const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const f of cleanup.splice(0)) f();
});
async function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gmail-disconnect-"));
  const store = new GmailStore(dir, crypto.randomBytes(32));
  cleanup.push(() => {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  await store.save(
    email,
    { mech: "XOAUTH2", username: email, refreshToken: "REFRESH", scopes: [GMAIL_MODIFY] },
    snapshot,
  );
  await store.save(kept, { mech: "XOAUTH2", username: kept, refreshToken: "OTHER" }, snapshot);
  return store;
}

it("revokes the grant and deletes every row stored for the account", async () => {
  const store = await setup();
  const password = store.issuePassword(email);
  const keptPassword = store.issuePassword(kept);
  store.cache(email, "profile", { cached: true }, 60_000);
  store.checkpoint(email, "7", [], []);
  store.upload(email, Buffer.from("x"), "text/plain");
  store.rememberDraft(email, "orig", "draft1");
  store.beginSubmission(email, "orig", "fingerprint");
  store.watchSave(email, Date.now() + 60_000, "7");
  const revokeToken = vi.fn(async () => ({}));
  const connection = new GmailConnection(
    { allowedEmails: new Set([email]) } as any,
    store,
    () => ({ revokeToken }) as any,
  );
  expect(await connection.disconnect(email)).toBe(true);
  expect(revokeToken).toHaveBeenCalledWith("REFRESH");
  expect(store.hasConnection(email)).toBe(false);
  expect(store.authenticate(password)).toBeNull();
  expect(store.cached(email, "profile")).toBeNull();
  expect(store.cursor(email)).toBeNull();
  expect(store.draft(email, "orig")).toBeNull();
  expect(store.submission(email, "orig")).toBeNull();
  expect(store.watch(email)).toBeNull();
  expect(store.hasConnection(kept)).toBe(true);
  expect(store.authenticate(keptPassword)).toBe(kept);
});

it("still deletes local data when Google cannot revoke the grant", async () => {
  const store = await setup();
  const revokeToken = vi.fn(async () => {
    throw new Error("invalid_token");
  });
  const connection = new GmailConnection(
    { allowedEmails: new Set([email]) } as any,
    store,
    () => ({ revokeToken }) as any,
  );
  expect(await connection.disconnect(email)).toBe(false);
  expect(store.hasConnection(email)).toBe(false);
});
