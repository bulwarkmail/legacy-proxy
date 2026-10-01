import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { GmailStore } from "../../src/gmail/store.js";
import { GmailMail } from "../../src/gmail/mail.js";
import { mapMessage } from "../../src/gmail/message.js";

const email = "labels@example.test";
const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const f of cleanup.splice(0)) f();
});
const labels = [
  { id: "INBOX", name: "INBOX", type: "system", messagesTotal: 2, messagesUnread: 1 },
  { id: "UNREAD", name: "UNREAD", type: "system", messagesTotal: 1 },
  { id: "STARRED", name: "STARRED", type: "system" },
  { id: "IMPORTANT", name: "IMPORTANT", type: "system" },
  { id: "CHAT", name: "CHAT", type: "system" },
  { id: "CATEGORY_SOCIAL", name: "CATEGORY_SOCIAL", type: "system" },
  { id: "Label_1", name: "Receipts", type: "user", labelListVisibility: "labelHide" },
];

it("lists places mail is filed, not read, star or importance states", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gmail-labels-"));
  const store = new GmailStore(dir, crypto.randomBytes(32));
  cleanup.push(() => {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const get = vi.fn(async (resource: string) => {
    if (resource === "profile")
      return { emailAddress: email, historyId: "5", messagesTotal: 2, threadsTotal: 2 };
    if (resource === "labels") return { labels };
    if (resource.startsWith("labels/")) return labels.find((l) => l.id === resource.slice(7));
    throw Error("Unexpected fixture resource " + resource);
  });
  const mail = new GmailMail(email, { get } as any, store);
  const boxes = await mail.mailboxes();
  expect(boxes.map((b) => b.id)).toEqual(["all", "l_INBOX", "l_CATEGORY_SOCIAL", "l_Label_1"]);
  expect(boxes.find((b) => b.id === "l_INBOX")!.name).toBe("Inbox");
  expect(boxes.find((b) => b.id === "l_CATEGORY_SOCIAL")!.name).toBe("Social");
  expect(boxes.find((b) => b.id === "l_Label_1")).toMatchObject({ name: "Receipts", isSubscribed: false });
  expect(boxes.find((b) => b.id === "all")!.unreadEmails).toBe(1);
  const mapped = await mapMessage(
    { id: "m", threadId: "t", internalDate: "0", labelIds: ["INBOX", "UNREAD", "STARRED", "IMPORTANT"] },
    { properties: ["mailboxIds", "keywords"] },
    async () => Buffer.alloc(0),
  );
  expect(mapped.mailboxIds).toEqual({ all: true, l_INBOX: true });
  expect(mapped.keywords).toEqual({ $flagged: true, $important: true });
});

it("returns the whole folder list for an account with more labels than maxObjectsInGet", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gmail-labels-"));
  const store = new GmailStore(dir, crypto.randomBytes(32));
  cleanup.push(() => {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  // A real Workspace mailbox with 124 labels used to answer `requestTooLarge`
  // to Bulwark's `Mailbox/get` with no ids, leaving the client with no folders
  // at all - an empty inbox that retried forever.
  const many = [
    { id: "INBOX", name: "INBOX", type: "system", messagesTotal: 1, messagesUnread: 1 },
    ...Array.from({ length: 130 }, (_, i) => ({
      id: `Label_${i}`,
      name: `Folder ${i}`,
      type: "user",
    })),
  ];
  const get = vi.fn(async (resource: string) => {
    if (resource === "profile")
      return { emailAddress: email, historyId: "5", messagesTotal: 1, threadsTotal: 1 };
    if (resource === "labels") return { labels: many };
    if (resource.startsWith("labels/"))
      return many.find((l) => l.id === decodeURIComponent(resource.slice(7)));
    throw Error("Unexpected fixture resource " + resource);
  });
  const mail = new GmailMail(email, { get } as any, store);
  const methods = mail.methods();

  const all = (await methods["Mailbox/get"]!({ accountId: mail.accountId })) as any;
  expect(all.list).toHaveLength(132); // 130 user labels + Inbox + the synthetic "all"
  expect(all.list.some((m: any) => m.id === "l_INBOX")).toBe(true);

  const queried = (await methods["Mailbox/query"]!({ accountId: mail.accountId })) as any;
  expect(queried.ids).toHaveLength(132);

  // A caller naming its own ids is still bounded by maxObjectsInGet.
  await expect(
    methods["Email/get"]!({
      accountId: mail.accountId,
      ids: Array.from({ length: 101 }, (_, i) => `m_${i}`),
    }),
  ).rejects.toMatchObject({ type: "requestTooLarge" });
});

it("answers a push preview's mailbox query without reading every label's counters", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gmail-labels-"));
  const store = new GmailStore(dir, crypto.randomBytes(32));
  cleanup.push(() => {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const many = [
    { id: "INBOX", name: "INBOX", type: "system", messagesTotal: 3, messagesUnread: 2 },
    ...Array.from({ length: 130 }, (_, i) => ({
      id: `Label_${i}`,
      name: `Folder ${i}`,
      type: "user",
    })),
  ];
  const get = vi.fn(async (resource: string) => {
    if (resource === "profile")
      return { emailAddress: email, historyId: "5", messagesTotal: 3, threadsTotal: 3 };
    if (resource === "labels") return { labels: many };
    if (resource.startsWith("labels/"))
      return many.find((l) => l.id === decodeURIComponent(resource.slice(7)));
    if (resource === "messages") return { messages: [{ id: "x", threadId: "t" }] };
    throw Error("Unexpected fixture resource " + resource);
  });
  const mail = new GmailMail(email, { get } as any, store);
  const methods = mail.methods();

  // "Which mailbox is the inbox" - the first half of /api/push/preview.
  const query = (await methods["Mailbox/query"]!({
    accountId: mail.accountId,
    filter: { role: "inbox" },
    limit: 1,
  })) as any;
  expect(query.ids).toEqual(["l_INBOX"]);

  // The second half: newest unread in that mailbox, with its total.
  const unread = (await methods["Email/query"]!({
    accountId: mail.accountId,
    filter: {
      operator: "AND",
      conditions: [{ inMailbox: "l_INBOX" }, { notKeyword: "$seen" }],
    },
    sort: [{ property: "receivedAt", isAscending: false }],
    limit: 1,
    calculateTotal: true,
  })) as any;
  expect(unread).toMatchObject({ ids: ["m_x"], total: 2 });

  // One label detail (INBOX), not 131 of them: on a real Workspace account
  // that difference was ~7.5 s per preview, and the notification arrived
  // generic because the service worker had given up waiting.
  const details = get.mock.calls.filter((c) => String(c[0]).startsWith("labels/"));
  expect(details.map((c) => c[0])).toEqual(["labels/INBOX"]);
});

it("reads every label's counters through the batch endpoint, 100 to a request", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gmail-labels-"));
  const store = new GmailStore(dir, crypto.randomBytes(32));
  cleanup.push(() => {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  // A Workspace mailbox with 124 labels: one labels.get each used to cost 11
  // round trips at 12 in flight, ~3.5 s.
  const many = [
    { id: "INBOX", name: "INBOX", type: "system" },
    ...Array.from({ length: 123 }, (_, i) => ({ id: `Label_${i}`, name: `L${i}`, type: "user" })),
  ];
  const detail = (id: string) => ({ ...many.find((l) => l.id === id)!, messagesTotal: 3, messagesUnread: 1 });
  const get = vi.fn(async (resource: string) => {
    if (resource === "profile")
      return { emailAddress: email, historyId: "5", messagesTotal: 2, threadsTotal: 2 };
    if (resource === "labels") return { labels: many };
    if (resource.startsWith("labels/")) return detail(decodeURIComponent(resource.slice(7)));
    throw Error("Unexpected fixture resource " + resource);
  });
  const batch = vi.fn(async (reads: { resource: string }[]) =>
    reads.map((read) => {
      const id = decodeURIComponent(read.resource.slice(7));
      // One part fails on its own: that label alone is read again singly.
      return id === "Label_7" ? { status: 500 } : { status: 200, data: detail(id) };
    }),
  );
  const mail = new GmailMail(email, { get, batch } as any, store);

  const labels = await mail.labels();

  expect(labels).toHaveLength(124);
  expect(labels.every((l) => l.messagesTotal === 3)).toBe(true);
  expect(batch).toHaveBeenCalledTimes(2);
  expect(batch.mock.calls.map((c) => c[0].length)).toEqual([100, 24]);
  const singles = get.mock.calls.filter((c) => String(c[0]).startsWith("labels/"));
  expect(singles.map((c) => c[0])).toEqual(["labels/Label_7"]);
});

it("does not fall back to one read per label when Google throttles the batch", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gmail-labels-"));
  const store = new GmailStore(dir, crypto.randomBytes(32));
  cleanup.push(() => {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const get = vi.fn(async (resource: string) => {
    if (resource === "profile")
      return { emailAddress: email, historyId: "5", messagesTotal: 2, threadsTotal: 2 };
    if (resource === "labels") return { labels };
    if (resource.startsWith("labels/")) return labels.find((l) => l.id === resource.slice(7));
    throw Error("Unexpected fixture resource " + resource);
  });
  const { JmapError } = await import("../../src/jmap/errors.js");
  const batch = vi.fn(async () => {
    throw new JmapError("serverUnavailable", "Google rate limit; retry later");
  });
  const mail = new GmailMail(email, { get, batch } as any, store);

  await expect(mail.labels()).rejects.toMatchObject({ type: "serverUnavailable" });
  expect(get.mock.calls.filter((c) => String(c[0]).startsWith("labels/"))).toHaveLength(0);
});
