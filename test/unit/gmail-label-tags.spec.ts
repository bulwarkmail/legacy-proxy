import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { GmailStore } from "../../src/gmail/store.js";
import { GmailMail } from "../../src/gmail/mail.js";
import { emailPatch } from "../../src/gmail/write.js";
import { gmailFilter } from "../../src/gmail/filter.js";
import { labelKeyword } from "../../src/gmail/message.js";
import { JmapError } from "../../src/jmap/errors.js";

const email = "tagger@gmail.com";
const profile = { emailAddress: email, historyId: "7", messagesTotal: 1, threadsTotal: 1 };
const labels = [
  ...["INBOX", "UNREAD", "STARRED", "SENT", "DRAFT", "SPAM", "TRASH", "IMPORTANT"].map((id) => ({
    id,
    name: id,
    type: "system",
    messagesTotal: 0,
  })),
  { id: "Label_1", name: "Fornitori/Società Agricola", type: "user", messagesTotal: 1 },
  { id: "Label_2", name: "Da leggere", type: "user", messagesTotal: 1 },
];
const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const f of cleanup.splice(0)) f();
});
function open() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gmail-tags-"));
  const store = new GmailStore(dir, crypto.randomBytes(32));
  cleanup.push(() => {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return store;
}

it("folds a label name into a keyword, keeping its nesting", () => {
  expect(labelKeyword("Fornitori/Società Agricola")).toBe("$label:fornitori/societa-agricola");
  expect(labelKeyword("Da leggere")).toBe("$label:da-leggere");
  // A name with nothing an IMAP flag can hold cannot be carried as a tag.
  expect(labelKeyword("★")).toBeNull();
});

it("puts user labels on the message as tags, and leaves system labels to mailboxes", async () => {
  const store = open();
  const message = {
    id: "a",
    threadId: "t",
    internalDate: "1700000000000",
    labelIds: ["INBOX", "UNREAD", "Label_1"],
    payload: { mimeType: "text/plain", headers: [{ name: "Subject", value: "Hello" }] },
  };
  const get = vi.fn(async (resource: string) => {
    if (resource === "profile") return profile;
    if (resource === "labels") return { labels };
    if (resource === "messages/a") return message;
    throw Error("Unexpected fixture resource " + resource);
  });
  const mail = new GmailMail(email, { get } as never, store);
  const result = (await mail.methods()["Email/get"]!({
    accountId: mail.accountId,
    ids: ["m_a"],
    properties: ["keywords", "mailboxIds"],
  })) as { list: { keywords: Record<string, true>; mailboxIds: Record<string, true> }[] };
  expect(result.list[0]!.keywords).toEqual({ "$label:fornitori/societa-agricola": true });
  // The label is still a mailbox too: that is what a folder view reads.
  expect(result.list[0]!.mailboxIds).toEqual({ all: true, l_INBOX: true, l_Label_1: true });
});

const message = { id: "a", threadId: "t", internalDate: "1000", labelIds: ["INBOX", "Label_1"] };

it("adds and removes the Gmail label a tag names", () => {
  expect(emailPatch(message, { "keywords/$label:da-leggere": true }, labels)).toEqual({
    addLabelIds: ["Label_2"],
    removeLabelIds: [],
  });
  // A "/" inside a patch token is escaped as ~1, so a nested tag reads as one path segment.
  expect(emailPatch(message, { "keywords/$label:fornitori~1societa-agricola": null }, labels)).toEqual({
    addLabelIds: [],
    removeLabelIds: ["Label_1"],
  });
});

it("refuses to invent a label for an unknown tag, but forgets one without complaint", () => {
  expect(() => emailPatch(message, { "keywords/$label:nowhere": true }, labels)).toThrow(JmapError);
  expect(emailPatch(message, { "keywords/$label:nowhere": null }, labels)).toEqual({
    addLabelIds: [],
    removeLabelIds: [],
  });
});

it("strips labels only when the keywords it is given mention tags at all", () => {
  // Marking a message read wholesale must not silently unfile it.
  expect(emailPatch(message, { keywords: { $seen: true } }, labels)).toEqual({
    addLabelIds: [],
    removeLabelIds: [],
  });
  // Naming one tag means the set is the truth: the others go. Leaving $seen
  // out of a wholesale set means unread, which is UNREAD to Gmail.
  expect(emailPatch(message, { keywords: { "$label:da-leggere": true } }, labels)).toEqual({
    addLabelIds: ["Label_2", "UNREAD"],
    removeLabelIds: ["Label_1"],
  });
});

it("searches a tag as the label it is", () => {
  expect(gmailFilter({ hasKeyword: "$label:da-leggere" }, labels)).toBe('label:"Da leggere"');
  expect(gmailFilter({ hasKeyword: "$label:gone" }, labels)).toBe("in:anywhere -in:anywhere");
});

it("enumerates the account's keywords from the labels rather than the mailbox", async () => {
  const store = open();
  const counted = labels.map((label) =>
    label.id === "Label_1"
      ? { ...label, messagesTotal: 12, messagesUnread: 3, color: { backgroundColor: "#42d692" } }
      : label.id === "STARRED"
        ? { ...label, messagesTotal: 4, messagesUnread: 1 }
        : label,
  );
  const get = vi.fn(async (resource: string) => {
    if (resource === "profile") return { ...profile, messagesTotal: 100 };
    if (resource === "labels") return { labels: counted };
    const found = counted.find((l) => resource === `labels/${l.id}`);
    if (found) return found;
    throw Error("Unexpected fixture resource " + resource);
  });
  const mail = new GmailMail(email, { get } as never, store);
  const result = (await mail.methods()["Keyword/get"]!({ accountId: mail.accountId })) as {
    totalEmails: number;
    list: Record<string, unknown>[];
  };
  expect(result.totalEmails).toBe(100);
  expect(result.list).toContainEqual({
    id: "$label:fornitori/societa-agricola",
    name: "Fornitori/Società Agricola",
    color: "#42d692",
    total: 12,
    unread: 3,
    isProviderLabel: true,
    source: "provider",
  });
  // States Gmail keeps as labels are keywords here, counted but not tags.
  expect(result.list).toContainEqual(
    expect.objectContaining({ id: "$flagged", total: 4, isProviderLabel: false }),
  );
  expect(result.list.some((k) => k.id === "$label:inbox")).toBe(false);
});

it("counts a tag from its label's counters, and an unknown tag without asking Gmail", async () => {
  const store = open();
  const calls: string[] = [];
  const get = vi.fn(async (resource: string, _cost?: number, params?: Record<string, unknown>) => {
    calls.push(resource + (params?.q ? "?q" : params?.labelIds ? "?labelIds" : ""));
    if (resource === "profile") return profile;
    if (resource === "labels") return { labels };
    if (resource === "labels/Label_2") return { ...labels.at(-1), messagesTotal: 7, messagesUnread: 3 };
    if (resource === "messages") return { messages: [{ id: "a", threadId: "t" }] };
    throw Error("Unexpected fixture resource " + resource);
  });
  const mail = new GmailMail(email, { get } as never, store);
  const query = mail.methods()["Email/query"]!;
  const count = async (filter: unknown) =>
    ((await query({ accountId: mail.accountId, filter, limit: 1, calculateTotal: true })) as { total: number }).total;

  expect(await count({ hasKeyword: "$label:da-leggere" })).toBe(7);
  expect(
    await count({ operator: "AND", conditions: [{ hasKeyword: "$label:da-leggere" }, { notKeyword: "$seen" }] }),
  ).toBe(3);
  // Exact counters and a listing by label id: never a search.
  expect(calls.some((c) => c.endsWith("?q"))).toBe(false);

  calls.length = 0;
  expect(await count({ hasKeyword: "$label:another-accounts-tag" })).toBe(0);
  expect(
    await count({ operator: "AND", conditions: [{ hasKeyword: "$label:another-accounts-tag" }, { notKeyword: "$seen" }] }),
  ).toBe(0);
  expect(calls.filter((c) => c.startsWith("messages") || c.startsWith("labels/"))).toEqual([]);
});
