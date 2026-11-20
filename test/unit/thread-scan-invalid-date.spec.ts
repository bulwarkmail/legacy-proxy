import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ImapFlow } from "imapflow";
import { Store } from "../../src/state/store.js";

// What imapflow yields for a date it could not parse: the raw string.
const UNPARSEABLE = "Tue, 3 Nov 2026 04:21:57 +0000 From: Sender <sender@example.com> MIME-Version: 1.0";

type Message = { uid: number; internalDate: Date | string };

let dir: string;
let store: Store;
let buildThreadIndex: typeof import("../../src/jmap/methods/threads.js").buildThreadIndex;

beforeEach(async () => {
  // The index is cached per account id in the module, and every test starts
  // a store whose first account has the same id.
  vi.resetModules();
  ({ buildThreadIndex } = await import("../../src/jmap/methods/threads.js"));
  dir = mkdtempSync(path.join(tmpdir(), "threadscandate-"));
  store = new Store(dir);
});

afterEach(() => {
  store.db.close();
  rmSync(dir, { recursive: true, force: true });
});

function serverWith(messages: Message[]) {
  const uids = () => messages.map((m) => m.uid);
  const uidNext = () => Math.max(...uids()) + 1;
  // "<start>:*" from the scan, a set of uids and ranges from the gap fill.
  const wanted = (set: string) =>
    set.endsWith(":*")
      ? uids().filter((uid) => uid >= Number(set.split(":")[0]))
      : set.split(",").flatMap((part) => {
          const [from, to = from] = part.split(":").map(Number);
          return uids().filter((uid) => uid >= from! && uid <= to!);
        });
  const client = {
    mailbox: null as unknown,
    list: async () => [
      {
        path: "INBOX",
        name: "INBOX",
        delimiter: "/",
        subscribed: true,
        status: { messages: messages.length, uidNext: uidNext(), uidValidity: 1n, unseen: 0 },
      },
    ],
    getMailboxLock: async (p: string) => {
      client.mailbox = { path: p, exists: messages.length, uidNext: uidNext(), uidValidity: 1n };
      return { release: () => {} };
    },
    fetch: async function* (set: string) {
      const asked = wanted(set);
      for (const m of messages) {
        if (!asked.includes(m.uid)) continue;
        yield { uid: m.uid, internalDate: m.internalDate, envelope: { messageId: `<${m.uid}@x.io>` }, headers: Buffer.from("") };
      }
    },
    search: async () => uids(),
  };
  return client as unknown as ImapFlow;
}

const inbox = () => (store.prep(`SELECT id FROM mailbox WHERE name = 'INBOX'`).get() as { id: number }).id;
const day = (d: number) => new Date(Date.UTC(2026, 10, d));

it("indexes the whole folder when one INTERNALDATE does not parse", async () => {
  const client = serverWith([
    { uid: 1, internalDate: day(1) },
    { uid: 2, internalDate: UNPARSEABLE },
    { uid: 3, internalDate: day(3) },
  ]);
  const account = store.upsertAccount({ slug: "a", kind: "generic", host: "h", username: "u", vault: Buffer.from("v") });

  await buildThreadIndex({ account, client, store });

  expect(store.getEmailCacheUids(account.id, inbox()).sort()).toEqual([1, 2, 3]);
});

it("fills a gap in the cache with a message whose INTERNALDATE does not parse", async () => {
  const messages: Message[] = [
    { uid: 1, internalDate: day(1) },
    { uid: 2, internalDate: day(2) },
    { uid: 3, internalDate: day(3) },
  ];
  const client = serverWith(messages);
  const account = store.upsertAccount({ slug: "a", kind: "generic", host: "h", username: "u", vault: Buffer.from("v") });
  await buildThreadIndex({ account, client, store });

  // The cache lost the rows of two messages, one of them unreadable, and a
  // new message arrived: the scan reads uid 4, the gap fill uids 2 and 3.
  store.deleteEmailCacheUids(account.id, inbox(), [2, 3]);
  messages[1]!.internalDate = UNPARSEABLE;
  messages.push({ uid: 4, internalDate: day(4) });
  store.bumpState(account.id, "email");
  await buildThreadIndex({ account, client, store });

  expect(store.getEmailCacheUids(account.id, inbox()).sort()).toEqual([1, 2, 3, 4]);
});
