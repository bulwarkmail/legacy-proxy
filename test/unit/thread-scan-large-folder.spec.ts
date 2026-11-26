// A large folder must not answer a small count drift with SEARCH ALL. That
// command returns every UID, and on a Gmail-sized folder it stalls the proxy.

import { afterEach, beforeEach, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ImapFlow } from "imapflow";
import { Store } from "../../src/state/store.js";
import {
  LARGE_MAILBOX_MESSAGES,
  buildThreadIndex,
  incrementalFetchStart,
  incrementalScan,
  shouldReconcileUidsBySearch,
} from "../../src/jmap/methods/threads.js";

let dir: string;
let store: Store;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "thread-large-"));
  store = new Store(dir);
});

afterEach(() => {
  store.db.close();
  rmSync(dir, { recursive: true, force: true });
});

it("repairs an empty folder without searching, and skips the search on a large one", () => {
  expect(shouldReconcileUidsBySearch(0, 4)).toBe(true);
  expect(shouldReconcileUidsBySearch(12, 12)).toBe(false);
  expect(shouldReconcileUidsBySearch(LARGE_MAILBOX_MESSAGES + 1, 10)).toBe(false);
  expect(incrementalFetchStart(90, 1, 5_000, true)).toBe(1);
  expect(incrementalFetchStart(LARGE_MAILBOX_MESSAGES + 1, 1, 80_000, false)).toBe(1);
  expect(incrementalFetchStart(LARGE_MAILBOX_MESSAGES + 1, 1, 80_000, true)).toBe(79_500);
  expect(incrementalFetchStart(LARGE_MAILBOX_MESSAGES + 1, 79_900, 80_000, true)).toBe(79_900);
  expect(incrementalScan(LARGE_MAILBOX_MESSAGES + 1, 1, 80_000, true)).toEqual({
    ranges: [
      { start: 1, end: 500 },
      { start: 79_500, end: null },
    ],
    uidnext: 501,
  });
  expect(incrementalScan(LARGE_MAILBOX_MESSAGES + 1, 1, 80_000, false).uidnext).toBe(80_000);
});

it("does not SEARCH ALL when a large folder's cached count disagrees", async () => {
  const searches: unknown[] = [];
  const client = {
    mailbox: null as unknown,
    list: async () => [
      {
        path: "[Gmail]/All Mail",
        name: "All Mail",
        delimiter: "/",
        subscribed: true,
        specialUse: "\\All",
        status: { messages: 25_000, unseen: 0, uidNext: 25_001, uidValidity: 1n },
      },
    ],
    getMailboxLock: async (p: string) => {
      client.mailbox = { path: p, exists: 25_000, uidNext: 25_001, uidValidity: 1n };
      return { release: () => {} };
    },
    fetch: async function* () {},
    search: async (query: unknown) => {
      searches.push(query);
      return [];
    },
  };
  const account = store.upsertAccount({
    slug: "g",
    kind: "gmail",
    host: "imap.example",
    username: "u",
    vault: Buffer.from("v"),
  });
  await buildThreadIndex({ account, client: client as unknown as ImapFlow, store });
  expect(searches).toEqual([]);
});
