// A folder list that is past its short TTL is still usable. The recount must
// not block the request, and a failed dial must not crash the process.

import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ImapFlow } from "imapflow";
import { Store } from "../../src/state/store.js";
import { listMailboxes } from "../../src/jmap/methods/mailbox.js";

let dir: string;
let store: Store;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "mbox-stale-"));
  store = new Store(dir);
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  store.db.close();
  rmSync(dir, { recursive: true, force: true });
});

function client(lists: { n: number }) {
  return {
    list: async () => {
      lists.n += 1;
      return [
        {
          path: "INBOX",
          name: "INBOX",
          delimiter: "/",
          subscribed: true,
          specialUse: "\\Inbox",
          status: { messages: 1, unseen: 0, uidNext: 2, uidValidity: 1n },
        },
      ];
    },
  } as unknown as ImapFlow;
}

it("returns a stale list and swallows a failed background dial", async () => {
  const lists = { n: 0 };
  const account = store.upsertAccount({
    slug: "a",
    kind: "generic",
    host: "imap.example",
    username: "u",
    vault: Buffer.from("v"),
  });
  const imap = client(lists);
  const first = await listMailboxes(imap, account, store);
  expect(lists.n).toBe(1);
  vi.advanceTimersByTime(31_000);
  const pool = {
    acquire: async () => {
      throw new Error("dial failed");
    },
  };
  const again = await listMailboxes(imap, account, store, { pool: pool as never });
  expect(again.map((m) => m.name)).toEqual(first.map((m) => m.name));
  expect(lists.n).toBe(1);
  await Promise.resolve();
  await vi.runAllTimersAsync();
  expect(lists.n).toBe(1);
});
