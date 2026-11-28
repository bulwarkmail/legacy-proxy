// An account-wide Gmail search runs in All Mail, Trash and Spam only: every
// other label is a second copy of a message already in All Mail.

import { afterEach, beforeEach, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ImapFlow } from "imapflow";
import { Store } from "../../src/state/store.js";
import { emailQuery, resetFolderSearchCache } from "../../src/jmap/methods/email.js";
import { listMailboxes, resetMailboxListCache } from "../../src/jmap/methods/mailbox.js";
import { decodeMailboxId, encodeEmailId } from "../../src/mapping/ids.js";

let dir: string;
let store: Store;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "gmailsearch-"));
  store = new Store(dir);
  resetFolderSearchCache();
  resetMailboxListCache();
});

afterEach(() => {
  store.db.close();
  rmSync(dir, { recursive: true, force: true });
});

const FOLDERS: Record<string, { specialUse?: string; hits: number[] }> = {
  INBOX: { specialUse: "\\Inbox", hits: [1] },
  "[Gmail]/All Mail": { specialUse: "\\All", hits: [11, 12] },
  Work: { hits: [3] },
  "[Gmail]/Trash": { specialUse: "\\Trash", hits: [21] },
  "[Gmail]/Spam": { specialUse: "\\Junk", hits: [31] },
};

function fakeGmail() {
  const searched: string[] = [];
  let held: Promise<void> = Promise.resolve();
  const client = {
    mailbox: false as unknown,
    list: async () =>
      Object.entries(FOLDERS).map(([p, f]) => ({
        path: p,
        name: p,
        delimiter: "/",
        subscribed: true,
        specialUse: f.specialUse,
        status: { messages: f.hits.length, unseen: 0, uidNext: Math.max(...f.hits) + 1, uidValidity: 7n },
      })),
    // One folder at a time, as imapflow's lock does on a real connection.
    getMailboxLock: async (p: string) => {
      const prev = held;
      let release!: () => void;
      held = new Promise<void>((r) => (release = r));
      await prev;
      client.mailbox = { path: p, uidValidity: 7n };
      let done = false;
      return { release: () => { if (!done) { done = true; release(); } } };
    },
    noop: async () => {},
    search: async () => {
      const p = (client.mailbox as { path: string }).path;
      searched.push(p);
      return [...FOLDERS[p]!.hits];
    },
    fetch: async function* () {
      const p = (client.mailbox as { path: string }).path;
      for (const uid of FOLDERS[p]!.hits) yield { uid, internalDate: new Date(Date.UTC(2026, 10, 1, 0, uid)) };
    },
  };
  return { client: client as unknown as ImapFlow, searched };
}

async function setup() {
  const account = store.upsertAccount({ slug: "g", kind: "gmail", host: "imap.gmail.com", username: "u", vault: Buffer.from("v") });
  const { client, searched } = fakeGmail();
  const boxes = await listMailboxes(client, account, store);
  const idOf = (role: string) => boxes.find((m) => m.role === role)!.id;
  const ctx = { account, client, store };
  return { account, ctx, searched, idOf };
}

it("searches All Mail, Trash and Spam, and keeps their hits", async () => {
  const { account, ctx, searched } = await setup();
  const res = await emailQuery({ accountId: String(account.id), filter: { text: "invoice" } } as never, ctx as never);
  expect(searched.sort()).toEqual(["[Gmail]/All Mail", "[Gmail]/Spam", "[Gmail]/Trash"]);
  expect(res.total).toBe(4);
});

it("searches only All Mail when Trash and Spam are excluded", async () => {
  const { account, ctx, searched, idOf } = await setup();
  const res = await emailQuery(
    {
      accountId: String(account.id),
      filter: { operator: "AND", conditions: [{ text: "invoice" }, { inMailboxOtherThan: [idOf("trash"), idOf("junk")] }] },
    } as never,
    ctx as never,
  );
  expect(searched).toEqual(["[Gmail]/All Mail"]);
  expect(res.total).toBe(2);
});

it("shows the Inbox copy of an All Mail hit and accepts it as the anchor", async () => {
  const { account, ctx, idOf } = await setup();
  const inbox = decodeMailboxId(idOf("inbox")).mailboxIdx;
  const all = decodeMailboxId(idOf("all")).mailboxIdx;
  const headersRaw = Buffer.from("Message-ID: <m12@example.com>\r\n\r\n");
  store.upsertEmailCacheRows([
    { accountId: account.id, mailboxId: all, uidvalidity: 7, uid: 12, threadId: "T1", internaldate: 1, headersRaw },
    { accountId: account.id, mailboxId: inbox, uidvalidity: 7, uid: 1, threadId: "T1", internaldate: 1, headersRaw },
  ]);
  const filter = { operator: "AND", conditions: [{ text: "invoice" }, { inMailboxOtherThan: [idOf("trash"), idOf("junk")] }] };
  const inboxCopy = encodeEmailId({ accountIdx: account.id, mailboxIdx: inbox, uidvalidity: 7, uid: 1 });
  const allOnly = encodeEmailId({ accountIdx: account.id, mailboxIdx: all, uidvalidity: 7, uid: 11 });

  const res = await emailQuery({ accountId: String(account.id), filter } as never, ctx as never);
  expect(res.ids).toEqual([inboxCopy, allOnly]);

  const next = await emailQuery(
    { accountId: String(account.id), filter, anchor: inboxCopy, anchorOffset: 1 } as never,
    ctx as never,
  );
  expect(next.ids).toEqual([allOnly]);
});
