// The attachments a single Email/set create may load.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Store, type AccountRow } from "../../src/state/store.js";
import { emailSet } from "../../src/jmap/methods/email.js";
import { encodeBlobId, encodeEmailId, encodeMailboxId } from "../../src/mapping/ids.js";
import { MAX_SIZE_ATTACHMENTS_PER_EMAIL } from "../../src/jmap/capabilities.js";

let dir: string;
let store: Store;
let account: AccountRow;
let mailboxIdx: number;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "limits-"));
  store = new Store(dir);
  account = store.upsertAccount({ slug: "a", kind: "generic", host: "example.org", username: "u@example.org", vault: Buffer.from("v") });
  mailboxIdx = Number(
    store.prep(`INSERT INTO mailbox(account_id, name, uidvalidity) VALUES (?, 'Drafts', 1)`).run(account.id).lastInsertRowid,
  );
});

afterEach(() => {
  store.db.close();
  rmSync(dir, { recursive: true, force: true });
});

const HALF = Math.floor(MAX_SIZE_ATTACHMENTS_PER_EMAIL / 2) + 1;

function upload(id: string): void {
  store.putUpload({ id, accountId: account.id, ctype: "application/pdf", body: Buffer.alloc(HALF) });
}

const pdf = (blobId: string, name: string) => ({ blobId, type: "application/pdf", name });

async function create(email: Record<string, unknown>, client: Record<string, unknown>) {
  const r = await emailSet(
    {
      accountId: String(account.id),
      create: {
        d: {
          mailboxIds: { [encodeMailboxId({ accountIdx: account.id, mailboxIdx })]: true },
          subject: "big",
          bodyValues: { "1": { value: "x" } },
          ...email,
        },
      },
    } as never,
    { account, store, client: client as never },
  );
  return r.notCreated?.d as { type?: string } | undefined;
}

const text = { textBody: [{ partId: "1", type: "text/plain" }] };

describe("Email/set create", () => {
  it("refuses attachments past maxSizeAttachmentsPerEmail before writing anything", async () => {
    upload("Ua");
    upload("Ub");
    const append = vi.fn();
    const error = await create({ ...text, attachments: [pdf("Ua", "a.pdf"), pdf("Ub", "b.pdf")] }, { append });
    expect(error).toMatchObject({ type: "tooLarge" });
    expect(append).not.toHaveBeenCalled();
  });

  it("counts a blob once for each part that carries it", async () => {
    upload("Ua");
    const append = vi.fn();
    const error = await create({ ...text, attachments: [pdf("Ua", "a.pdf"), pdf("Ua", "again.pdf")] }, { append });
    expect(error).toMatchObject({ type: "tooLarge" });
    expect(append).not.toHaveBeenCalled();
  });

  it("leaves out the attachments a bodyStructure makes the message ignore", async () => {
    upload("Ua");
    upload("Ub");
    const append = vi.fn();
    const error = await create(
      { bodyStructure: { partId: "1", type: "text/plain" }, attachments: [pdf("Ua", "a.pdf"), pdf("Ub", "b.pdf")] },
      { append },
    );
    expect(error?.type).not.toBe("tooLarge");
    expect(append).toHaveBeenCalledOnce();
  });

  it("stops fetching a part of stored mail once it is past the limit", async () => {
    const CHUNK = 1_000_000;
    const partSize = 4 * MAX_SIZE_ATTACHMENTS_PER_EMAIL;
    let delivered = 0;
    let asked: number | undefined;
    const append = vi.fn();
    const client = {
      append,
      mailbox: false,
      getMailboxLock: async () => ({ release: () => {} }),
      // Like imapflow, hands out no more than maxBytes of the part.
      download: async (_range: string, _part: string, opts: { maxBytes?: number }) => {
        asked = opts.maxBytes;
        const cap = Math.min(partSize, opts.maxBytes ?? Infinity);
        return {
          meta: { contentType: "application/pdf" },
          content: (async function* () {
            while (delivered < cap) {
              const chunk = Buffer.alloc(Math.min(CHUNK, cap - delivered));
              delivered += chunk.length;
              yield chunk;
            }
          })(),
        };
      },
    };
    const emailId = encodeEmailId({ accountIdx: account.id, mailboxIdx, uidvalidity: 1, uid: 7 });

    const error = await create({ ...text, attachments: [pdf(encodeBlobId(emailId, "2"), "huge.pdf")] }, client);

    expect(error).toMatchObject({ type: "tooLarge" });
    expect(asked).toBe(MAX_SIZE_ATTACHMENTS_PER_EMAIL + 1);
    expect(delivered).toBe(MAX_SIZE_ATTACHMENTS_PER_EMAIL + 1);
    expect(append).not.toHaveBeenCalled();
  });
});
