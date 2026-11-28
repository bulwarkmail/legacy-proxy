// A cross-account view in the webmail (all starred, all unread) asks for a
// keyword in any of several folders: AND [ OR [inMailbox...], keyword ].

import { afterEach, beforeEach, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ImapFlow } from "imapflow";
import { searchCompiler } from "imapflow/lib/search-compiler.js";
import { Store } from "../../src/state/store.js";
import { emailQuery, resetFolderSearchCache } from "../../src/jmap/methods/email.js";
import { listMailboxes, resetMailboxListCache } from "../../src/jmap/methods/mailbox.js";

let dir: string;
let store: Store;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "mailboxany-"));
  store = new Store(dir);
  resetFolderSearchCache();
  resetMailboxListCache();
});

afterEach(() => {
  store.db.close();
  rmSync(dir, { recursive: true, force: true });
});

interface Folder {
  uids: number[];
  flagged: number[];
}

// Every OR in IMAP SEARCH takes two search keys; a server answers BAD to one
// that has fewer, as `SEARCH OR FLAGGED` does.
function checkSearchKeys(tokens: Array<{ type: string; value?: string | unknown[] }>): void {
  let i = 0;
  const key = (): void => {
    const t = tokens[i++];
    if (!t) throw new Error("BAD Missing search key");
    if (t.type === "ATOM" && t.value === "OR") {
      key();
      key();
    } else if (t.type === "ATOM" && t.value === "NOT") key();
  };
  while (i < tokens.length) key();
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
        status: { messages: f.uids.length, unseen: 0, uidNext: Math.max(0, ...f.uids) + 1, uidValidity: 7n, highestModseq: 5n },
      })),
    // One folder at a time, as imapflow's lock does on a real connection.
    getMailboxLock: async (p: string) => {
      const prev = held;
      let release!: () => void;
      held = new Promise<void>((r) => (release = r));
      await prev;
      client.mailbox = { path: p, uidValidity: 7n, highestModseq: 5n, flags: new Set() };
      let done = false;
      return { release: () => { if (!done) { done = true; release(); } } };
    },
    noop: async () => {},
    search: async (query: Record<string, unknown>) => {
      checkSearchKeys(searchCompiler(client as never, query) as never);
      const p = (client.mailbox as { path: string }).path;
      searched.push(p);
      return query.flagged ? [...folders[p]!.flagged] : [...folders[p]!.uids];
    },
    fetch: async function* (set: number[]) {
      for (const uid of set) yield { uid, internalDate: new Date(Date.UTC(2026, 10, 1, 0, uid)) };
    },
  };
  return { client: client as unknown as ImapFlow, searched };
}

it("lists starred mail from the folders an OR of inMailbox names, and only those", async () => {
  const account = store.upsertAccount({ slug: "a", kind: "generic", host: "h", username: "u", vault: Buffer.from("v") });
  const { client, searched } = fakeServer({
    INBOX: { uids: [1, 2, 3], flagged: [2] },
    Archive: { uids: [4, 5], flagged: [4, 5] },
    Projects: { uids: [6], flagged: [6] },
    Trash: { uids: [9], flagged: [9] },
  });
  const ctx = { account, client, store };
  const boxes = await listMailboxes(client, account, store);
  const id = (name: string) => boxes.find((m) => m.name === name)!.id;

  const result = await emailQuery(
    {
      accountId: String(account.id),
      filter: {
        operator: "AND",
        conditions: [
          { operator: "OR", conditions: [{ inMailbox: id("INBOX") }, { inMailbox: id("Archive") }] },
          { hasKeyword: "$flagged" },
        ],
      },
      sort: [{ property: "receivedAt", isAscending: false }],
      calculateTotal: true,
    } as never,
    ctx as never,
  );

  expect(result.total).toBe(3);
  expect(searched.sort()).toEqual(["Archive", "INBOX"]);
});
