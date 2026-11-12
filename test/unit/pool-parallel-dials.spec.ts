// Requests that need a connection at the same time (a browser opens a
// message: several JMAP calls and inline image downloads on the "bulk" role)
// and the pool's dials: connections still being opened count against the role
// caps, and while the stored password has not worked yet, the account's dials
// go one at a time. At most 3 logins with a stored password the server refuses
// reach it, however many requests arrive together.
// Runs against the fake IMAP server on 127.0.0.1 only.

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
  imap = await startFakeImap({ "u@test.local": "changed-at-the-server" });
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "legacy-proxy-pool-dials-"));
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

describe("parallel requests and a stored password the server refuses", () => {
  it("sends at most three logins with it, also when eight requests need a connection at once", async () => {
    const username = "u@test.local";
    const account = store.upsertAccount({
      slug: `generic:${username}`,
      kind: "generic",
      host: "127.0.0.1",
      username,
      vault: await sealCredentials(vaultKey, { mech: "PLAIN", username, password: "the-old-password" }),
    });
    const pool = poolFor();
    const before = imap.logins;
    // Three JMAP calls and five downloads of the message the user just opened.
    const roles = ["interactive", "interactive", "interactive", "bulk", "bulk", "bulk", "bulk", "bulk"] as const;
    const results = await Promise.allSettled(roles.map((role) => pool.acquire(account, role)));
    expect(results.every((r) => r.status === "rejected")).toBe(true);
    expect(store.getAccountById(account.id)!.cred_refused).toBe(1);
    expect(imap.logins - before).toBeLessThanOrEqual(3);
    await pool.closeAll();
  });

  // With a password that works: the role caps (3 interactive, 2 bulk) count
  // dials in progress as well as open connections.
  it("opens no more connections than the role caps when eight requests arrive at once", async () => {
    const username = "w@test.local";
    imap.users[username] = "right";
    const account = store.upsertAccount({
      slug: `generic:${username}`,
      kind: "generic",
      host: "127.0.0.1",
      username,
      vault: await sealCredentials(vaultKey, { mech: "PLAIN", username, password: "right" }),
    });
    const pool = poolFor();
    const before = imap.logins;
    const roles = ["interactive", "interactive", "interactive", "interactive", "bulk", "bulk", "bulk", "bulk"] as const;
    // Each borrower gives its connection back shortly after it got one, so callers parked at a cap go on.
    await Promise.all(
      roles.map((role) =>
        pool.acquire(account, role).then((lease) => new Promise<void>((r) => setTimeout(() => (lease.release(), r()), 200))),
      ),
    );
    expect(imap.logins - before).toBeLessThanOrEqual(5);
    await pool.closeAll();
  });
});
