// An account-wide Email/query (a keyword over every folder but Trash and
// Junk, as label counters send it) searches only the folders whose
// HIGHESTMODSEQ moved since their last search.

import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ImapFlow } from "imapflow";
import { Store } from "../../src/state/store.js";
import {
  emailQuery,
  FOLDER_SEARCH_CACHE_MAX_UIDS,
  folderSearchHit,
  rememberFolderSearch,
  resetFolderSearchCache,
} from "../../src/jmap/methods/email.js";
import { listMailboxes, resetMailboxListCache } from "../../src/jmap/methods/mailbox.js";

let dir: string;
let store: Store;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "foldersearch-"));
  store = new Store(dir);
  resetFolderSearchCache();
  resetMailboxListCache();
});

afterEach(() => {
  vi.useRealTimers();
  store.db.close();
  rmSync(dir, { recursive: true, force: true });
});

interface Folder {
  uids: number[];
  labelled: number[];
  modseq: number | null;
}

function fakeServer(folders: Record<string, Folder>) {
  const searched: string[] = [];
  let held: Promise<void> = Promise.resolve();
  const client = {
    mailbox: false as unknown,
    list: async () =>
      Object.entries(folders).map(([p, f]) => ({
        path: p,
        name: p,
        delimiter: "/",
        subscribed: true,
        specialUse: p === "Trash" ? "\\Trash" : undefined,
        status: {
          messages: f.uids.length,
          unseen: 0,
          uidNext: Math.max(0, ...f.uids) + 1,
          uidValidity: 7n,
          ...(f.modseq === null ? {} : { highestModseq: BigInt(f.modseq) }),
        },
      })),
    // One folder at a time, as imapflow's lock does on a real connection.
    getMailboxLock: async (p: string) => {
      const prev = held;
      let release!: () => void;
      held = new Promise<void>((r) => (release = r));
      await prev;
      // An already selected folder keeps the view (and modseq) it had until a NOOP.
      if ((client.mailbox as { path?: string }).path !== p) {
        client.mailbox = { path: p, uidValidity: 7n, highestModseq: BigInt(folders[p]!.modseq ?? 0) };
      }
      let done = false;
      return { release: () => { if (!done) { done = true; release(); } } };
    },
    noop: async () => {},
    search: async () => {
      const p = (client.mailbox as { path: string }).path;
      searched.push(p);
      return [...folders[p]!.labelled];
    },
    fetch: async function* (_set: unknown, _q: unknown) {
      const p = (client.mailbox as { path: string }).path;
      for (const uid of folders[p]!.labelled) yield { uid, internalDate: new Date(Date.UTC(2026, 10, 1, 0, uid)) };
    },
  };
  return { client: client as unknown as ImapFlow, searched };
}

async function labelQuery(ctx: { account: { id: number }; client: ImapFlow; store: Store }, trashId: string) {
  return emailQuery(
    {
      accountId: String(ctx.account.id),
      filter: { operator: "AND", conditions: [{ hasKeyword: "$label:work" }, { inMailboxOtherThan: [trashId] }] },
      limit: 1,
      calculateTotal: true,
    } as never,
    ctx as never,
  );
}

it("searches again only the folders that changed", async () => {
  const account = store.upsertAccount({ slug: "a", kind: "generic", host: "h", username: "u", vault: Buffer.from("v") });
  const folders: Record<string, Folder> = {
    INBOX: { uids: [1, 2, 3], labelled: [2], modseq: 10 },
    Archive: { uids: [1, 2], labelled: [1, 2], modseq: 20 },
    Projects: { uids: [5], labelled: [5], modseq: 30 },
    Trash: { uids: [9], labelled: [9], modseq: 40 },
  };
  const { client, searched } = fakeServer(folders);
  const ctx = { account, client, store };
  const trashId = (await listMailboxes(client, account, store)).find((m) => m.role === "trash")!.id;

  expect((await labelQuery(ctx, trashId)).total).toBe(4);
  expect(searched.sort()).toEqual(["Archive", "INBOX", "Projects"]);

  // Nothing moved: no folder is searched, not even selected.
  searched.length = 0;
  expect((await labelQuery(ctx, trashId)).total).toBe(4);
  expect(searched).toEqual([]);

  // The label comes off a message in INBOX (another device, then IDLE): only INBOX is searched.
  folders.INBOX!.labelled = [];
  folders.INBOX!.modseq = 11;
  store.bumpState(account.id, "email");
  searched.length = 0;
  expect((await labelQuery(ctx, trashId)).total).toBe(3);
  expect(searched).toEqual(["INBOX"]);
});

it("searches a folder again after an expunge that left its modseq alone", async () => {
  const account = store.upsertAccount({ slug: "d", kind: "generic", host: "h", username: "u", vault: Buffer.from("v") });
  const folders: Record<string, Folder> = {
    INBOX: { uids: [1], labelled: [], modseq: 10 },
    Archive: { uids: [1, 2], labelled: [1, 2], modseq: 20 },
    Trash: { uids: [9], labelled: [], modseq: 40 },
  };
  const { client, searched } = fakeServer(folders);
  const ctx = { account, client, store };
  const trashId = (await listMailboxes(client, account, store)).find((m) => m.role === "trash")!.id;
  expect((await labelQuery(ctx, trashId)).total).toBe(2);

  // Message 1 is moved out of Archive on another device. A CONDSTORE server
  // without QRESYNC needn't move HIGHESTMODSEQ for that, and UIDNEXT stays;
  // only the count drops.
  folders.Archive!.uids = [2];
  folders.Archive!.labelled = [2];
  store.bumpState(account.id, "email");
  searched.length = 0;
  expect((await labelQuery(ctx, trashId)).total).toBe(1);
  expect(searched).toEqual(["Archive"]);
});

it("keeps the UIDs of all remembered searches under the cap", () => {
  const live = { path: "Archive", uidValidity: 7, uidNext: 1, messages: 0, highestModseq: 5 };
  const uids = (n: number) => Array.from({ length: n }, (_, i) => i + 1);
  const half = Math.ceil(FOLDER_SEARCH_CACHE_MAX_UIDS * 0.6);

  rememberFolderSearch("a", live, uids(half));
  expect(folderSearchHit("a", live)).toHaveLength(half);
  // The second big result pushes the first one out.
  rememberFolderSearch("b", live, uids(half));
  expect(folderSearchHit("a", live)).toBeNull();
  expect(folderSearchHit("b", live)).toHaveLength(half);
  // One result above the cap is not kept, and leaves the others alone.
  rememberFolderSearch("c", live, uids(FOLDER_SEARCH_CACHE_MAX_UIDS + 1));
  expect(folderSearchHit("c", live)).toBeNull();
  expect(folderSearchHit("b", live)).toHaveLength(half);
});

it("keeps searching every folder on a server without CONDSTORE", async () => {
  const account = store.upsertAccount({ slug: "b", kind: "generic", host: "h", username: "u", vault: Buffer.from("v") });
  const folders: Record<string, Folder> = {
    INBOX: { uids: [1], labelled: [1], modseq: null },
    Archive: { uids: [2], labelled: [2], modseq: null },
    Trash: { uids: [3], labelled: [], modseq: null },
  };
  const { client, searched } = fakeServer(folders);
  const ctx = { account, client, store };
  const trashId = (await listMailboxes(client, account, store)).find((m) => m.role === "trash")!.id;

  expect((await labelQuery(ctx, trashId)).total).toBe(2);
  store.bumpState(account.id, "email");
  searched.length = 0;
  expect((await labelQuery(ctx, trashId)).total).toBe(2);
  expect(searched.sort()).toEqual(["Archive", "INBOX"]);
});

it("doesn't file an older cached search under a newer modseq", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  const account = store.upsertAccount({ slug: "c", kind: "generic", host: "h", username: "u", vault: Buffer.from("v") });
  const folders: Record<string, Folder> = {
    INBOX: { uids: [1, 2], labelled: [1], modseq: 10 },
    Trash: { uids: [], labelled: [], modseq: 50 },
  };
  const { client } = fakeServer(folders);
  const ctx = { account, client, store };
  const trashId = (await listMailboxes(client, account, store)).find((m) => m.role === "trash")!.id;
  expect((await labelQuery(ctx, trashId)).total).toBe(1);

  // Another device labels message 2. The connection that has INBOX open
  // still reports modseq 10; a Mailbox state move refreshes the LIST, which
  // reports 11. The old search, served from the search cache, must not be
  // remembered as the result for 11.
  folders.INBOX!.labelled = [1, 2];
  folders.INBOX!.modseq = 11;
  store.bumpState(account.id, "mailbox");
  await labelQuery(ctx, trashId);

  // Once the search cache has expired, a fresh search finds both.
  vi.setSystemTime(Date.now() + 31_000);
  expect((await labelQuery(ctx, trashId)).total).toBe(2);
});
