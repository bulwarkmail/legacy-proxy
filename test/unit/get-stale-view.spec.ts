import { afterEach, beforeEach, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ImapFlow } from "imapflow";
import { Store } from "../../src/state/store.js";
import { emailGet } from "../../src/jmap/methods/email.js";
import { encodeEmailId } from "../../src/mapping/ids.js";

let dir: string;
let store: Store;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "getstale-"));
  store = new Store(dir);
});

afterEach(() => {
  store.db.close();
  rmSync(dir, { recursive: true, force: true });
});

function uidsOf(set: string): number[] {
  return set.split(",").flatMap((part) => {
    const [from, to = from] = part.split(":").map(Number);
    return Array.from({ length: to! - from! + 1 }, (_, i) => from! + i);
  });
}

function setup() {
  const account = store.upsertAccount({ slug: "a", kind: "generic", host: "h", username: "u", vault: Buffer.from("v") });
  store.prep(`INSERT INTO mailbox(account_id, name, uidvalidity) VALUES (?, 'INBOX', 1)`).run(account.id);
  const mailboxIdx = (store.prep(`SELECT id FROM mailbox WHERE name = 'INBOX'`).get() as { id: number }).id;

  const server = [1, 2];
  let view: number[] = [];
  const calls = { noop: 0, fetch: [] as string[] };
  const client = {
    mailbox: false as unknown,
    getMailboxLock: async (p: string) => {
      // SELECT gives a fresh view; an already selected folder keeps its old one.
      if ((client.mailbox as { path?: string }).path !== p) {
        client.mailbox = { path: p, uidValidity: 1n, highestModseq: 5n };
        view = [...server];
      }
      return { release: () => {} };
    },
    noop: async () => {
      calls.noop++;
      view = [...server];
    },
    fetch: async function* (set: string) {
      calls.fetch.push(set);
      for (const uid of uidsOf(set)) {
        if (!view.includes(uid)) continue;
        yield {
          uid,
          flags: new Set<string>(),
          size: 10,
          internalDate: new Date("2026-01-01T00:00:00Z"),
          envelope: { subject: `m${uid}`, messageId: `<${uid}@x.io>` },
          bodyStructure: { type: "text/plain", part: "1", size: 10 },
          headers: Buffer.from(`Message-ID: <${uid}@x.io>\r\n\r\n`),
        };
      }
    },
  };
  const id = (uid: number) => encodeEmailId({ accountIdx: account.id, mailboxIdx, uidvalidity: 1, uid });
  const get = (uids: number[]) =>
    emailGet(
      { accountId: String(account.id), ids: uids.map(id), properties: ["id", "subject"] } as never,
      { account, client: client as unknown as ImapFlow, store },
    );
  return { server, calls, id, get };
}

// A pooled connection that has INBOX selected sees a message appended through
// another connection only after its next NOOP.
it("finds a message appended while the pooled connection kept its old view", async () => {
  const { server, calls, id, get } = setup();

  expect((await get([1, 2])).list).toHaveLength(2);
  expect(calls.noop).toBe(0);

  server.push(3);
  const res = await get([3]);
  expect(res.notFound).toEqual([]);
  expect(res.list.map((e) => e.id)).toEqual([id(3)]);
  expect(calls.noop).toBe(1);
});

it("asks again only for the uids the first FETCH missed", async () => {
  const { server, calls, get } = setup();
  await get([1]);
  calls.fetch.length = 0;

  server.push(3);
  expect((await get([2, 3])).list).toHaveLength(2);
  expect(calls.fetch).toEqual(["2:3", "3"]);
});

it("reports a uid the server does not have as not found, after one NOOP", async () => {
  const { calls, id, get } = setup();
  const res = await get([1, 9]);
  expect(res.list).toHaveLength(1);
  expect(res.notFound).toEqual([id(9)]);
  expect(calls.noop).toBe(1);
});
