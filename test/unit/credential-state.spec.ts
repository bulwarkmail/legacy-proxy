// The account row's credential state in the SQLite store: the generation that
// session tokens are checked against, and the list of ended tokens.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { nextStoredAttemptAt, Store, STORED_CREDENTIAL_SPREAD_MS } from "../../src/state/store.js";

const open: Store[] = [];
const dirs: string[] = [];
afterEach(() => {
  for (const s of open.splice(0)) s.close();
  for (const d of dirs.splice(0)) {
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {
      /* left for the OS temp cleanup */
    }
  }
});
const tempDir = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "legacy-proxy-cred-"));
  dirs.push(d);
  return d;
};
const storeIn = (dir: string) => {
  const s = new Store(dir);
  open.push(s);
  return s;
};
const account = (rotate?: boolean) => ({
  slug: "generic:u@test.local",
  kind: "generic",
  host: "imap.test",
  username: "u@test.local",
  vault: Buffer.from("sealed"),
  rotate,
});

describe("credential generation", () => {
  it("starts at 0 and moves only when a login stores different credentials", () => {
    const store = storeIn(tempDir());
    const moved: number[] = [];
    store.setCredentialListener((id) => moved.push(id));

    const first = store.upsertAccount(account());
    expect(first.cred_gen).toBe(0);
    expect(store.upsertAccount(account(false)).cred_gen).toBe(0);
    expect(moved).toEqual([]);

    expect(store.upsertAccount(account(true)).cred_gen).toBe(1);
    expect(moved).toEqual([first.id]);
  });

  it("is added to a database from before it existed, with every account at 0", () => {
    const dir = tempDir();
    const old = new Database(path.join(dir, "proxy.db"));
    old.exec(`CREATE TABLE account (
      id INTEGER PRIMARY KEY AUTOINCREMENT, slug TEXT NOT NULL UNIQUE, kind TEXT NOT NULL,
      host TEXT NOT NULL, username TEXT NOT NULL, vault BLOB NOT NULL, created_at INTEGER NOT NULL)`);
    old.prepare(`INSERT INTO account(slug, kind, host, username, vault, created_at) VALUES(?,?,?,?,?,?)`).run(
      "generic:old@test.local", "generic", "imap.test", "old@test.local", Buffer.from("v"), 1,
    );
    old.close();

    const store = storeIn(dir);
    expect(store.getAccount("generic:old@test.local")).toMatchObject({ username: "old@test.local", cred_gen: 0 });
  });
});

// Three refusals spread over the least time that may set the mark.
const t0 = 1_700_000_000_000;
const spread = [t0, t0 + STORED_CREDENTIAL_SPREAD_MS / 2, t0 + STORED_CREDENTIAL_SPREAD_MS];

describe("refused mark", () => {
  it("is set after three refusals in a row and moves the generation", () => {
    const store = storeIn(tempDir());
    const moved: number[] = [];
    store.setCredentialListener((id) => moved.push(id));
    const { id } = store.upsertAccount(account());

    expect(store.noteCredentialRefusal(id, 0, spread[0])).toBe(false);
    expect(store.noteCredentialRefusal(id, 0, spread[1])).toBe(false);
    expect(store.noteCredentialRefusal(id, 0, spread[2])).toBe(true);
    expect(store.getAccountById(id)).toMatchObject({ cred_refused: 1, cred_gen: 1 });
    expect(moved).toEqual([id]);
    expect(store.accountsWithActivePushSubs()).toEqual([]);
  });

  it("is not set by refusals that come faster than the least spread", () => {
    const store = storeIn(tempDir());
    const { id } = store.upsertAccount(account());
    for (let i = 0; i < 5; i++) expect(store.noteCredentialRefusal(id, 0, t0 + i * 1000)).toBe(false);
    expect(store.getAccountById(id)).toMatchObject({ cred_refused: 0, cred_gen: 0 });
  });

  it("spaces the next try after each refusal evenly over the least spread", () => {
    const store = storeIn(tempDir());
    const { id } = store.upsertAccount(account());
    expect(nextStoredAttemptAt(store.getAccountById(id)!)).toBe(0);
    store.noteCredentialRefusal(id, 0, spread[0]);
    expect(nextStoredAttemptAt(store.getAccountById(id)!)).toBe(spread[1]);
    store.noteCredentialRefusal(id, 0, spread[1]);
    expect(nextStoredAttemptAt(store.getAccountById(id)!)).toBe(spread[2]);
  });

  it("needs the refusals in a row", () => {
    const store = storeIn(tempDir());
    const { id } = store.upsertAccount(account());
    store.noteCredentialRefusal(id, 0);
    store.noteCredentialRefusal(id, 0);
    store.noteCredentialSuccess(id);
    expect(store.noteCredentialRefusal(id, 0)).toBe(false);
    expect(store.getAccountById(id)!.cred_refused).toBe(0);
  });

  it("does not count a refusal of credentials the row no longer holds", () => {
    const store = storeIn(tempDir());
    const { id } = store.upsertAccount(account());
    store.upsertAccount(account(true));
    for (let i = 0; i < 5; i++) expect(store.noteCredentialRefusal(id, 0)).toBe(false);
    expect(store.getAccountById(id)!.cred_refused).toBe(0);
  });

  it("is cleared by the next successful login, which tells the listener", () => {
    const store = storeIn(tempDir());
    const { id } = store.upsertAccount(account());
    for (const at of spread) store.noteCredentialRefusal(id, 0, at);
    const told: number[] = [];
    store.setCredentialListener((acc) => told.push(acc));
    expect(store.upsertAccount(account(false))).toMatchObject({ cred_refused: 0, cred_refusals: 0, cred_gen: 1 });
    expect(told).toEqual([id]);
  });
});

describe("push subscriptions and the credential generation", () => {
  const subscribe = (store: Store, accountId: number, id: string, createdAt = Date.now()) =>
    store.insertPushSubscription({
      id,
      accountId,
      deviceClientId: null,
      url: "https://relay.example/" + id,
      types: null,
      expires: Date.now() + 86400_000,
      verificationCode: null,
      verified: true,
      createdAt,
      lastPushAt: null,
    });

  it("end when a sign-in replaces the password they were made under", () => {
    const store = storeIn(tempDir());
    const { id } = store.upsertAccount(account());
    subscribe(store, id, "s1");
    expect(store.accountsWithActivePushSubs()).toEqual([id]);
    store.upsertAccount(account(true));
    expect(store.listPushSubscriptions(id)).toEqual([]);
    expect(store.accountsWithActivePushSubs()).toEqual([]);
    expect(store.activePushSubscriptions(id)).toEqual([]);
  });

  it("end when the stored password is marked refused", () => {
    const store = storeIn(tempDir());
    const { id } = store.upsertAccount(account());
    subscribe(store, id, "s1");
    for (const at of spread) store.noteCredentialRefusal(id, 0, at);
    expect(store.listPushSubscriptions(id)).toEqual([]);
  });

  it("stay when nothing moves, and those made since the replacing sign-in move along", () => {
    const store = storeIn(tempDir());
    const { id } = store.upsertAccount(account());
    subscribe(store, id, "old", t0 - 1);
    store.upsertAccount(account(false));
    expect(store.listPushSubscriptions(id).map((s) => s.id)).toEqual(["old"]);
    subscribe(store, id, "new", t0 + 1);
    store.upsertAccount({ ...account(true), keepSince: t0 });
    expect(store.listPushSubscriptions(id).map((s) => s.id)).toEqual(["new"]);
    expect(store.accountsWithActivePushSubs()).toEqual([id]);
  });
});

describe("ended session tokens", () => {
  it("stay ended after a restart and are dropped once they would have expired", () => {
    const dir = tempDir();
    const before = storeIn(dir);
    before.endSession("a".repeat(64), Date.now() + 60_000);
    before.endSession("b".repeat(64), Date.now() - 1);
    before.close();
    open.splice(open.indexOf(before), 1);

    const after = storeIn(dir);
    expect(after.isSessionEnded("a".repeat(64))).toBe(true);
    after.endSession("c".repeat(64), Date.now() + 60_000);
    expect(after.isSessionEnded("b".repeat(64))).toBe(false);
  });
});
