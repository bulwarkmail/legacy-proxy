import { afterEach, beforeEach, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ImapFlow } from "imapflow";
import { Store } from "../../src/state/store.js";
import { emailQuery } from "../../src/jmap/methods/email.js";
import { encodeMailboxId } from "../../src/mapping/ids.js";

let dir: string;
let store: Store;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "querystale-"));
  store = new Store(dir);
});

afterEach(() => {
  store.db.close();
  rmSync(dir, { recursive: true, force: true });
});

// A pooled connection that has INBOX selected sees mail delivered since only
// after its next NOOP, and its HIGHESTMODSEQ stays put until then. A refresh
// after IDLE reported the arrival must still list the new message.
it("lists mail that arrived while the pooled connection kept its old view", async () => {
  const account = store.upsertAccount({ slug: "a", kind: "generic", host: "h", username: "u", vault: Buffer.from("v") });
  store
    .prep(`INSERT INTO mailbox(account_id, name, uidvalidity) VALUES (?, 'INBOX', 1)`)
    .run(account.id);
  const mailboxIdx = (store.prep(`SELECT id FROM mailbox WHERE name = 'INBOX'`).get() as { id: number }).id;

  const server = [1, 2];
  let view: number[] = [];
  let noops = 0;
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
      noops++;
      view = [...server];
    },
    search: async () => view,
  };
  const ctx = { account, client: client as unknown as ImapFlow, store };
  const args = {
    accountId: String(account.id),
    filter: { inMailbox: encodeMailboxId({ accountIdx: account.id, mailboxIdx }) },
    sort: [{ property: "receivedAt", isAscending: false }],
  };

  expect((await emailQuery(args as never, ctx)).ids).toHaveLength(2);
  expect(noops).toBe(0);
  server.push(3);
  store.bumpState(account.id, "email"); // IDLE: EXISTS grew
  expect((await emailQuery(args as never, ctx)).ids).toHaveLength(3);
  expect(noops).toBe(1);
});
