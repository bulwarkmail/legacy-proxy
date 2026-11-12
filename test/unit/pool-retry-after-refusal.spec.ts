// After the mail server refused the stored password once, a request the user
// makes afterwards may try once right away, so a moment's hiccup at the server
// doesn't fail every new connection for minutes. The attempt after that waits
// for the end of the five-minute spread, so there are never more than three
// logins with a refused password in it. Runs against the fake IMAP server on
// 127.0.0.1 only.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ImapPool } from "../../src/imap/pool.js";
import { Store } from "../../src/state/store.js";
import { sealCredentials } from "../../src/auth/credentials.js";
import type { AppConfig } from "../../src/util/config.js";
import { startFakeImap, type FakeImap } from "./fake-imap.js";

process.env.LOG_LEVEL = "silent";

let imap: FakeImap;
let dir: string;
let store: Store;
const vaultKey = crypto.randomBytes(32);

beforeAll(async () => {
  imap = await startFakeImap({});
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "legacy-proxy-pool-retry-"));
  store = new Store(dir);
});
afterAll(async () => {
  store.close();
  await imap.close();
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* left for the OS temp cleanup */
  }
});

function poolFor(): ImapPool {
  const cfg = {
    vaultKey,
    defaultProvider: "generic",
    providers: {
      generic: {
        imap: { host: "127.0.0.1", port: imap.port, secure: false },
        smtp: { host: "127.0.0.1", port: 1, secure: false },
        sieve: null,
        carddav: null,
        auth: { mech: ["PLAIN"] },
      },
    },
  } as unknown as AppConfig;
  return new ImapPool(cfg, store);
}

async function accountWith(username: string, password: string) {
  return store.upsertAccount({
    slug: `generic:${username}`,
    kind: "generic",
    host: "127.0.0.1",
    username,
    vault: await sealCredentials(vaultKey, { mech: "PLAIN", username, password }),
  });
}
const later = () => new Promise((r) => setTimeout(r, 5));

describe("a request after one refusal of the stored password", () => {
  it("tries once right away; the next one waits without a login", async () => {
    imap.users["ray@test.local"] = "changed-at-the-server";
    const account = await accountWith("ray@test.local", "the-old-password");
    const pool = poolFor();
    const before = imap.logins;
    await expect(pool.acquire(account)).rejects.toThrow();
    expect(imap.logins - before).toBe(1);
    await later();
    // The user's next request: one more login, right away.
    await expect(pool.acquire(account)).rejects.toThrow();
    expect(imap.logins - before).toBe(2);
    await later();
    // The one after waits for the end of the spread: no login.
    await expect(pool.acquire(account)).rejects.toThrow(/trying again later/);
    expect(imap.logins - before).toBe(2);
    expect(store.getAccountById(account.id)).toMatchObject({ cred_refusals: 2, cred_refused: 0 });
    await pool.closeAll();
  });

  it("gets a connection at once when the refusal was a moment's hiccup", async () => {
    imap.users["sam@test.local"] = "something-else";
    const account = await accountWith("sam@test.local", "pw");
    const pool = poolFor();
    await expect(pool.acquire(account)).rejects.toThrow();
    // The server takes the password again a moment later.
    imap.users["sam@test.local"] = "pw";
    await later();
    const lease = await pool.acquire(account);
    lease.release();
    expect(store.getAccountById(account.id)).toMatchObject({ cred_refusals: 0, cred_refused: 0 });
    await pool.closeAll();
  });
});
