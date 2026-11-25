// The thread index used to SELECT every non-empty folder on each build; on
// Gmail, where every label is a folder, that took tens of seconds. Now one
// LIST-STATUS tells which folders moved, and only those are opened.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ImapFlow } from "imapflow";
import { Store } from "../../src/state/store.js";
import { buildThreadIndex } from "../../src/jmap/methods/threads.js";

let dir: string;
let store: Store;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "threadscan-"));
  store = new Store(dir);
});

afterEach(() => {
  store.db.close();
  rmSync(dir, { recursive: true, force: true });
});

type Status = { messages: number; uidNext: number; uidValidity: bigint };

function fakeServer(folders: Record<string, Status>) {
  const log = { lists: 0, selects: [] as string[] };
  const client = {
    mailbox: null as unknown,
    list: async () => {
      log.lists++;
      await new Promise((r) => setTimeout(r, 5));
      return Object.entries(folders).map(([p, status]) => ({ path: p, name: p, delimiter: "/", subscribed: true, status: { ...status, unseen: 0 } }));
    },
    getMailboxLock: async (p: string) => {
      log.selects.push(p);
      const st = folders[p]!;
      client.mailbox = { path: p, exists: st.messages, uidNext: st.uidNext, uidValidity: st.uidValidity };
      return { release: () => {} };
    },
    fetch: async function* () {},
    search: async () => [],
  };
  return { client: client as unknown as ImapFlow, log };
}

describe("thread index scan", () => {
  it("opens only the folders whose STATUS moved since the last scan", async () => {
    const folders: Record<string, Status> = {
      INBOX: { messages: 3, uidNext: 10, uidValidity: 1n },
      "[Gmail]/All Mail": { messages: 9, uidNext: 50, uidValidity: 1n },
      Work: { messages: 2, uidNext: 7, uidValidity: 1n },
      Empty: { messages: 0, uidNext: 1, uidValidity: 1n },
    };
    const { client, log } = fakeServer(folders);
    const account = store.upsertAccount({ slug: "a", kind: "gmail", host: "h", username: "u", vault: Buffer.from("v") });
    const ctx = { account, client, store };

    await buildThreadIndex(ctx);
    expect(log.selects.sort()).toEqual(["INBOX", "Work", "[Gmail]/All Mail"]);

    log.selects = [];
    store.bumpState(account.id, "email");
    await buildThreadIndex(ctx);
    expect(log.selects).toEqual([]);

    folders.INBOX = { messages: 4, uidNext: 11, uidValidity: 1n };
    folders["[Gmail]/All Mail"] = { messages: 10, uidNext: 51, uidValidity: 1n };
    store.bumpState(account.id, "email");
    await buildThreadIndex(ctx);
    expect(log.selects.sort()).toEqual(["INBOX", "[Gmail]/All Mail"]);
  });

  it("shares one build between requests that arrive together", async () => {
    const { client, log } = fakeServer({ INBOX: { messages: 1, uidNext: 2, uidValidity: 1n } });
    const account = store.upsertAccount({ slug: "b", kind: "generic", host: "h", username: "u", vault: Buffer.from("v") });
    const ctx = { account, client, store };
    await Promise.all([buildThreadIndex(ctx), buildThreadIndex(ctx), buildThreadIndex(ctx)]);
    expect(log.lists).toBe(1);
    expect(log.selects).toEqual(["INBOX"]);
  });

  it("returns the bulk connection before reading the cached rows", async () => {
    const { client, log } = fakeServer({ INBOX: { messages: 1, uidNext: 2, uidValidity: 1n } });
    const account = store.upsertAccount({ slug: "c", kind: "generic", host: "h", username: "u", vault: Buffer.from("v") });
    store.bumpState(account.id, "email");
    let released = false;
    const pool = {
      acquire: async () => ({
        client,
        release: () => {
          released = true;
        },
      }),
    };
    const original = store.getThreadIndexRows.bind(store);
    store.getThreadIndexRows = ((id: number) => {
      expect(released).toBe(true);
      return original(id);
    }) as typeof store.getThreadIndexRows;
    const index = await buildThreadIndex({ account, client, store, pool: pool as never });
    expect(log.selects).toEqual(["INBOX"]);
    expect(released).toBe(true);
    expect(index.members).toBeInstanceOf(Map);
  });
});
