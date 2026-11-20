// A draft saved again is a new IMAP message, and the version it replaces is
// deleted. The webmail keeps the part blobIds of the draft it opened, so the
// save after that references parts of a message that is gone. Those must
// still resolve, or every further save fails with blobNotFound.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import type { ImapFlow } from "imapflow";
import { Store, type AccountRow } from "../../src/state/store.js";
import { configureBlobCache, DEFAULT_BLOB_CACHE_LIMITS, readBlob } from "../../src/jmap/blobs.js";
import { encodeBlobId, encodeEmailId } from "../../src/mapping/ids.js";

let dir: string;
let store: Store;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "blobdraft-"));
  store = new Store(dir);
});

afterEach(() => {
  configureBlobCache(DEFAULT_BLOB_CACHE_LIMITS);
  store.db.close();
  rmSync(dir, { recursive: true, force: true });
});

// An IMAP server holding one message, which can be expunged.
function fakeImap(pdf: Buffer) {
  const state = { expunged: false, downloads: 0 };
  const client = {
    getMailboxLock: async () => ({ release: () => {} }),
    noop: async () => {},
    download: async () => {
      state.downloads++;
      // imapflow answers `{}` for an expunged message.
      if (state.expunged) return {};
      return { content: Readable.from([pdf]), meta: { contentType: "application/pdf" } };
    },
  } as unknown as ImapFlow;
  return { client, state };
}

describe("part blobs of a replaced draft", () => {
  it("still resolve after the message they belong to is gone", async () => {
    store.db.prepare(`INSERT INTO account(id, slug, kind, host, username, vault, created_at) VALUES (1, 'imap:u', 'imap', 'imap.example.org', 'u@example.org', x'00', 0)`).run();
    store.db.prepare(`INSERT INTO mailbox(id, account_id, name, role) VALUES (3, 1, 'Drafts', 'drafts')`).run();
    const account = store.db.prepare(`SELECT * FROM account WHERE id = 1`).get() as AccountRow;
    const pdf = Buffer.from("%PDF-1.7 test");
    const { client, state } = fakeImap(pdf);
    const ctx = { account, store, client };
    const blobId = encodeBlobId(encodeEmailId({ accountIdx: 1, mailboxIdx: 3, uidvalidity: 7, uid: 2258 }), "2");

    // First save: the old draft is still there.
    expect((await readBlob(blobId, ctx))?.body.equals(pdf)).toBe(true);

    // The webmail deletes the old version once the new one is stored.
    state.expunged = true;

    // Next save references the same part again.
    const again = await readBlob(blobId, ctx);
    expect(again?.body.equals(pdf)).toBe(true);
    expect(again?.ctype).toBe("application/pdf");
    expect(state.downloads).toBe(1);
  });

  it("does not cache what the server could not produce", async () => {
    store.db.prepare(`INSERT INTO account(id, slug, kind, host, username, vault, created_at) VALUES (1, 'imap:u', 'imap', 'imap.example.org', 'u@example.org', x'00', 0)`).run();
    store.db.prepare(`INSERT INTO mailbox(id, account_id, name, role) VALUES (3, 1, 'Drafts', 'drafts')`).run();
    const account = store.db.prepare(`SELECT * FROM account WHERE id = 1`).get() as AccountRow;
    const { client, state } = fakeImap(Buffer.from("x"));
    state.expunged = true;
    const blobId = encodeBlobId(encodeEmailId({ accountIdx: 1, mailboxIdx: 3, uidvalidity: 7, uid: 1 }), "2");

    expect(await readBlob(blobId, { account, store, client })).toBeNull();
    expect(store.getCachedBlob(blobId, 1)).toBeNull();
  });
});

it("does not keep a part whose read stopped at the limit", async () => {
  store.db.prepare(`INSERT INTO account(id, slug, kind, host, username, vault, created_at) VALUES (1, 'imap:u', 'imap', 'imap.example.org', 'u@example.org', x'00', 0)`).run();
  store.db.prepare(`INSERT INTO mailbox(id, account_id, name, role) VALUES (3, 1, 'Drafts', 'drafts')`).run();
  const account = store.db.prepare(`SELECT * FROM account WHERE id = 1`).get() as AccountRow;
  const pdf = Buffer.from("%PDF-1.7 a whole file");
  // Like imapflow, hands out no more than maxBytes of the part.
  const client = {
    getMailboxLock: async () => ({ release: () => {} }),
    download: async (_range: string, _part: string, opts: { maxBytes?: number }) => ({
      content: Readable.from([pdf.subarray(0, opts.maxBytes ?? pdf.length)]),
      meta: { contentType: "application/pdf" },
    }),
  } as unknown as ImapFlow;
  const blobId = encodeBlobId(encodeEmailId({ accountIdx: 1, mailboxIdx: 3, uidvalidity: 7, uid: 9 }), "2");

  // Another attachment of the same message left room for 5 bytes.
  expect((await readBlob(blobId, { account, store, client }, 5))?.body.length).toBe(6);
  expect(store.getCachedBlob(blobId, 1)).toBeNull();

  // A download or a smaller message gets the whole part.
  expect((await readBlob(blobId, { account, store, client }))?.body.equals(pdf)).toBe(true);
});

it("does not keep a part over BLOB_CACHE_MAX_PART_BYTES", async () => {
  store.db.prepare(`INSERT INTO account(id, slug, kind, host, username, vault, created_at) VALUES (1, 'imap:u', 'imap', 'imap.example.org', 'u@example.org', x'00', 0)`).run();
  store.db.prepare(`INSERT INTO mailbox(id, account_id, name, role) VALUES (3, 1, 'Drafts', 'drafts')`).run();
  const account = store.db.prepare(`SELECT * FROM account WHERE id = 1`).get() as AccountRow;
  configureBlobCache({ ...DEFAULT_BLOB_CACHE_LIMITS, maxPartBytes: 4 });
  const { client } = fakeImap(Buffer.from("too big"));
  const blobId = encodeBlobId(encodeEmailId({ accountIdx: 1, mailboxIdx: 3, uidvalidity: 7, uid: 9 }), "2");

  expect((await readBlob(blobId, { account, store, client }))?.body.toString()).toBe("too big");
  expect(store.getCachedBlob(blobId, 1)).toBeNull();
});
