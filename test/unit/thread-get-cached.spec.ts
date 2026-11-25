// Thread/get of a thread already in email_cache must not LIST the account.

import { afterEach, beforeEach, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ImapFlow } from "imapflow";
import { Store } from "../../src/state/store.js";
import { threadGet } from "../../src/jmap/methods/threads.js";

let dir: string;
let store: Store;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "thread-get-"));
  store = new Store(dir);
});

afterEach(() => {
  store.db.close();
  rmSync(dir, { recursive: true, force: true });
});

it("answers a stored thread without listing folders", async () => {
  const account = store.upsertAccount({
    slug: "a",
    kind: "generic",
    host: "imap.example",
    username: "u",
    vault: Buffer.from("v"),
  });
  const mailbox = store
    .prep(
      `INSERT INTO mailbox(account_id, name, delim, role, total, unread, subscribed, last_seen)
       VALUES(?, 'INBOX', '/', 'inbox', 1, 0, 1, 0) RETURNING id`,
    )
    .get(account.id) as { id: number };
  store.upsertEmailCacheRows([
    {
      accountId: account.id,
      mailboxId: mailbox.id,
      uidvalidity: 1,
      uid: 4,
      threadId: "Tknown",
      internaldate: 1_000,
    },
  ]);
  let listed = false;
  const client = {
    list: async () => {
      listed = true;
      return [];
    },
  };
  const res = await threadGet(
    { accountId: String(account.id), ids: ["Tknown"] },
    { account, client: client as unknown as ImapFlow, store },
  );
  expect(listed).toBe(false);
  expect(res.notFound).toEqual([]);
  expect(res.list).toHaveLength(1);
  expect(res.list[0]!.emailIds).toHaveLength(1);
});
