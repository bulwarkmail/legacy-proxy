import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { GmailStore } from "../../src/gmail/store.js";
import { GmailMail } from "../../src/gmail/mail.js";
import { labelKeyword } from "../../src/gmail/message.js";

const email = "many-tags@gmail.com";
const profile = { emailAddress: email, historyId: "7", messagesTotal: 1, threadsTotal: 1 };
const user = Array.from({ length: 30 }, (_, i) => ({
  id: `Label_${i}`,
  name: `Tag ${i}`,
  type: "user",
  messagesTotal: i + 1,
  messagesUnread: i,
}));
const labels = [
  ...["INBOX", "UNREAD", "SENT", "DRAFT", "SPAM", "TRASH"].map((id) => ({ id, name: id, type: "system", messagesTotal: 0 })),
  ...user,
];
const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const f of cleanup.splice(0)) f();
});
function open() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gmail-label-batch-"));
  const store = new GmailStore(dir, crypto.randomBytes(32));
  cleanup.push(() => {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return store;
}
function fixture() {
  const singles: string[] = [];
  const batches: string[][] = [];
  const detail = (resource: string) => labels.find((l) => resource === `labels/${l.id}`);
  const get = vi.fn(async (resource: string) => {
    if (resource === "profile") return profile;
    if (resource === "labels") return { labels };
    if (detail(resource)) {
      singles.push(resource);
      // Slow enough that concurrent askers overlap.
      await new Promise((resolve) => setTimeout(resolve, 5));
      return detail(resource);
    }
    if (resource === "messages") return { messages: [{ id: "a", threadId: "t" }] };
    throw Error("Unexpected fixture resource " + resource);
  });
  const batch = vi.fn(async (reads: { resource: string }[]) => {
    batches.push(reads.map((r) => r.resource));
    return reads.map((r) => ({ status: 200, data: detail(r.resource) }));
  });
  return { get, batch, singles, batches };
}
const count = (mail: GmailMail, filter: unknown) =>
  (mail.methods()["Email/query"]!({ accountId: mail.accountId, filter, limit: 1, calculateTotal: true }) as Promise<{
    total: number;
  }>).then((r) => r.total);

it("reads the counters of many tags through one batch instead of one call per label", async () => {
  const { get, batch, singles, batches } = fixture();
  const mail = new GmailMail(email, { get, batch } as never, open());
  // What a client counting its tags sends: total and unread for each, a few calls at a time.
  const totals: number[] = [];
  const unread: number[] = [];
  for (let i = 0; i < user.length; i += 2) {
    const tags = [user[i]!, user[i + 1]!].map((l) => ({ hasKeyword: labelKeyword(l.name) }));
    const [t0, u0, t1, u1] = await Promise.all([
      count(mail, tags[0]),
      count(mail, { operator: "AND", conditions: [tags[0], { notKeyword: "$seen" }] }),
      count(mail, tags[1]),
      count(mail, { operator: "AND", conditions: [tags[1], { notKeyword: "$seen" }] }),
    ]);
    totals.push(t0!, t1!);
    unread.push(u0!, u1!);
  }
  expect(totals).toEqual(user.map((l) => l.messagesTotal));
  expect(unread).toEqual(user.map((l) => l.messagesUnread));
  // A handful read on their own, then the whole set in one batch.
  expect(singles.length).toBeLessThanOrEqual(10);
  expect(batches).toHaveLength(1);
  expect(batches[0]).toHaveLength(labels.length);
});

it("reads one label on its own, once, however many ask for it at the same time", async () => {
  const { get, batch, singles, batches } = fixture();
  const mail = new GmailMail(email, { get, batch } as never, open());
  const tag = { hasKeyword: labelKeyword("Tag 3") };
  const answers = await Promise.all([
    count(mail, tag),
    count(mail, tag),
    count(mail, { operator: "AND", conditions: [tag, { notKeyword: "$seen" }] }),
    count(mail, { inMailbox: "l_Label_3" }),
  ]);
  expect(answers).toEqual([4, 4, 3, 4]);
  expect(singles).toEqual(["labels/Label_3"]);
  expect(batches).toEqual([]);
});
