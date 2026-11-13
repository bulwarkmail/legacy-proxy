import { expect, it } from "vitest";
import { classify } from "../../src/gmail/history.js";
import { fakeGmail } from "./gmail-fake.js";

it("moves labels on the cached row instead of reading the message again", async () => {
  const f = await fakeGmail();
  const rows = async () =>
    ((await f.methods["Email/get"]!({
      accountId: f.mail.accountId,
      ids: ["m_m5", "m_m4"],
      properties: ["keywords", "mailboxIds", "subject"],
    })) as any).list as { id: string; keywords: Record<string, boolean>; mailboxIds: Record<string, boolean> }[];
  expect((await rows()).map((r) => !!r.keywords.$seen)).toEqual([false, true]);
  await f.threads("t_t5", "t_t4");
  const reads = () => f.calls("messages/").length + f.calls("threads/").length;
  const before = reads();

  // Read in another client, then starred and archived: three records.
  f.messages[0]!.labelIds = ["STARRED"];
  f.record({ labelsRemoved: [{ message: { id: "m5", threadId: "t5", labelIds: ["INBOX"] }, labelIds: ["UNREAD"] }] });
  f.record({ labelsAdded: [{ message: { id: "m5", threadId: "t5", labelIds: ["INBOX", "STARRED"] }, labelIds: ["STARRED"] }] });
  f.record({ labelsRemoved: [{ message: { id: "m5", threadId: "t5", labelIds: ["STARRED"] }, labelIds: ["INBOX"] }] });

  const [m5, m4] = await rows();
  expect(m5!.keywords).toEqual({ $seen: true, $flagged: true });
  expect(m5!.mailboxIds).toEqual({ all: true });
  expect(m4!.keywords).toEqual({ $seen: true });
  await f.threads("t_t5", "t_t4");
  // Neither the rows nor their conversations were read again.
  expect(reads()).toBe(before);
});

it("tells a relabel from a change that has to be read again", () => {
  const change = classify([
    { id: "1", labelsRemoved: [{ message: { id: "a", threadId: "ta" }, labelIds: ["UNREAD"] }] },
    { id: "2", labelsAdded: [{ message: { id: "a", threadId: "ta" }, labelIds: ["STARRED"] }] },
    // No label list on the record: nothing to apply, so forget the message.
    { id: "3", labelsAdded: [{ message: { id: "b", threadId: "tb" } }] },
    { id: "4", messagesAdded: [{ message: { id: "c", threadId: "tc" } }] },
    { id: "5", labelsAdded: [{ message: { id: "c", threadId: "tc" }, labelIds: ["INBOX"] }] },
    { id: "6", messagesDeleted: [{ message: { id: "d", threadId: "td" } }] },
  ]);
  expect(change.drop.sort()).toEqual(["b", "c", "d"]);
  expect([...change.relabel]).toEqual([
    ["a", [{ add: [], remove: ["UNREAD"] }, { add: ["STARRED"], remove: [] }]],
  ]);
  // Only conversations that gained or lost a message.
  expect(change.threads.sort()).toEqual(["tc", "td"]);
});

it("marks cached mail read without reading it first, a few at a time, and keeps the rows", async () => {
  const f = await fakeGmail();
  const ids = ["m_m5", "m_m3"];
  const rows = async () =>
    ((await f.methods["Email/get"]!({ accountId: f.mail.accountId, ids, properties: ["keywords", "subject"] })) as any)
      .list as { keywords: Record<string, boolean> }[];
  await rows();
  f.get.mockClear();
  let inFlight = 0;
  let together = 0;
  const modify = f.mutate.getMockImplementation()!;
  f.mutate.mockImplementation(async (...args: any[]) => {
    inFlight++;
    together = Math.max(together, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 10));
    inFlight--;
    return (modify as any)(...args);
  });
  const set = (await f.methods["Email/set"]!({
    accountId: f.mail.accountId,
    update: Object.fromEntries(ids.map((id) => [id, { "keywords/$seen": true }])),
  })) as any;
  expect(Object.keys(set.updated).sort()).toEqual(["m_m3", "m_m5"]);
  expect(set.updated.m_m5.keywords).toEqual({ $seen: true });
  expect(f.mutate).toHaveBeenCalledTimes(2);
  expect(together).toBe(2);
  // No message was read to learn its labels, and none is read to list it again.
  expect((await rows()).map((r) => r.keywords)).toEqual([{ $seen: true }, { $seen: true }]);
  expect(f.calls("messages/")).toEqual([]);
  expect(f.batch.mock.calls.filter((c) => c[0][0].resource.startsWith("messages/")).length).toBe(1);
});

it("reads the labels of a message it has never seen before changing them", async () => {
  const f = await fakeGmail();
  const set = (await f.methods["Email/set"]!({
    accountId: f.mail.accountId,
    update: { m_m5: { "keywords/$seen": true } },
  })) as any;
  expect(set.updated.m_m5.keywords).toEqual({ $seen: true });
  expect(f.calls("messages/m5").map((c) => c[2].format)).toEqual(["minimal"]);
});

it("reads the labels from Gmail before replacing a message's mailboxes whole, cached or not", async () => {
  const f = await fakeGmail();
  await f.methods["Email/get"]!({ accountId: f.mail.accountId, ids: ["m_m5", "m_m4"], properties: ["subject"] });
  // Starred in another client since the last sync: the cached copy has not heard.
  f.messages[0]!.labelIds = ["INBOX", "UNREAD", "STARRED"];
  f.get.mockClear();
  // Archive: every mailbox but All mail is to go.
  const set = (await f.methods["Email/set"]!({
    accountId: f.mail.accountId,
    update: { m_m5: { mailboxIds: { all: true } } },
  })) as any;
  expect(f.calls("messages/m5").map((c) => c[2].format)).toEqual(["minimal"]);
  expect(set.updated.m_m5.mailboxIds).toEqual({ all: true });
  // The star put on elsewhere survives, and the row shows it without a read.
  expect(f.messages[0]!.labelIds.sort()).toEqual(["STARRED", "UNREAD"]);
  f.get.mockClear();
  const row = ((await f.methods["Email/get"]!({
    accountId: f.mail.accountId,
    ids: ["m_m5"],
    properties: ["keywords"],
  })) as any).list[0];
  expect(row.keywords).toEqual({ $flagged: true });
  expect(f.calls("messages/")).toEqual([]);
});
