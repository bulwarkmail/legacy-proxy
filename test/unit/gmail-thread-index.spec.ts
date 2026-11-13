import { afterEach, expect, it, vi } from "vitest";

afterEach(() => {
  vi.useRealTimers();
});
import { email, fakeGmail } from "./gmail-fake.js";

it("lists the account once and then answers conversations without asking Gmail", async () => {
  const f = await fakeGmail({ index: true, pageSize: 2 });
  // The first question finds no index: it is answered by Gmail, as before,
  // and starts the listing in the background.
  const first = await f.threads("t_t1");
  expect(first.list[0]!.emailIds).toEqual(["m_m1", "m_m2", "m_m3"]);
  await f.indexed();
  // Three pages of two: ids and threads only, no message or thread read.
  expect(f.calls("messages").filter((c) => c[0] === "messages" && !c[2].labelIds)).toHaveLength(3);
  expect(f.store.threadIndexSize(email)).toBe(5);

  f.get.mockClear();
  f.batch.mockClear();
  const again = await f.threads("t_t1", "t_t4", "t_t5", "t_nope");
  // Oldest first, as a conversation reads.
  expect(again.list).toEqual([
    { id: "t_t1", emailIds: ["m_m1", "m_m2", "m_m3"] },
    { id: "t_t4", emailIds: ["m_m4"] },
    { id: "t_t5", emailIds: ["m_m5"] },
  ]);
  expect(again.notFound).toEqual(["t_nope"]);
  // Only the thread the index does not know was asked of Gmail.
  expect(f.calls("threads/").map((c) => c[0])).toEqual(["threads/nope"]);
  expect(f.batch).not.toHaveBeenCalled();
});

it("keeps the index current from history: arrivals, deletions, and nothing for a label change", async () => {
  const f = await fakeGmail({ index: true });
  await f.threads("t_t1");
  await f.indexed();

  // A reply arrives in the conversation, and a lone message is deleted.
  f.messages.unshift({ id: "m6", threadId: "t1", labelIds: ["INBOX", "UNREAD"] });
  f.messages.splice(f.messages.findIndex((m) => m.id === "m4"), 1);
  f.record({
    messagesAdded: [{ message: { id: "m6", threadId: "t1", labelIds: ["INBOX", "UNREAD"] } }],
    messagesDeleted: [{ message: { id: "m4", threadId: "t4" } }],
  });
  f.get.mockClear();
  const after = await f.threads("t_t1", "t_t5");
  expect(after.list).toEqual([
    { id: "t_t1", emailIds: ["m_m1", "m_m2", "m_m3", "m_m6"] },
    { id: "t_t5", emailIds: ["m_m5"] },
  ]);
  expect(f.calls("threads/")).toEqual([]);
  // The deleted conversation is gone from the index; Gmail confirms it.
  expect((await f.threads("t_t4")).notFound).toEqual(["t_t4"]);
  expect(f.store.threadIndexSize(email)).toBe(5);
});

it("does not put back a message deleted while the account was being listed", async () => {
  const f = await fakeGmail({ index: true, pageSize: 2 });
  let fired = false;
  // m1 sits on the last page. It is deleted, and the deletion synced, after
  // the first page was read and before the last one is.
  f.onPage(async (page) => {
    if (page !== 1 || fired) return;
    fired = true;
    f.record({ messagesDeleted: [{ message: { id: "m1", threadId: "t1" } }] });
    await f.mail.state();
    // The listing still returns it on the next page: a page token is a snapshot.
  });
  await f.threads("t_t5");
  await f.indexed();
  expect(fired).toBe(true);
  expect(f.store.threadIndexMembers(email, "t1")).toEqual(["m2", "m3"]);
});

it("keeps answering from the index while it is listed again", async () => {
  const f = await fakeGmail({ index: true, pageSize: 2 });
  await f.threads("t_t1");
  await f.indexed();
  const listings = () => f.calls("messages").filter((c) => c[0] === "messages" && !c[2].labelIds).length;
  const first = listings();
  const built = f.store.threadIndexBuiltAt(email)!;
  // Eight days on, the index is due for a fresh listing. A message arrives
  // while that listing is half way through.
  vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + 8 * 24 * 60 * 60_000 });
  f.sync();
  let arrived = false;
  f.onPage(async (page) => {
    if (page !== 1 || arrived) return;
    arrived = true;
    f.messages.unshift({ id: "m7", threadId: "t1", labelIds: ["INBOX"] });
    f.record({ messagesAdded: [{ message: { id: "m7", threadId: "t1", labelIds: ["INBOX"] } }] });
    // Asked in the middle of the listing: answered, from the index, current.
    f.get.mockClear();
    expect((await f.threads("t_t1")).list[0]!.emailIds).toEqual(["m_m1", "m_m2", "m_m3", "m_m7"]);
    expect(f.calls("threads/")).toEqual([]);
  });
  f.get.mockClear();
  expect((await f.threads("t_t1", "t_t5")).list.map((t) => t.emailIds.length)).toEqual([3, 1]);
  expect(f.calls("threads/")).toEqual([]);
  for (let i = 0; i < 200 && f.store.threadIndexBuiltAt(email) === built; i++)
    await new Promise((resolve) => setTimeout(resolve, 5));
  expect(f.store.threadIndexBuiltAt(email)).toBeGreaterThan(built);
  expect(arrived).toBe(true);
  expect(listings()).toBeGreaterThan(0);
  expect(first).toBeGreaterThan(0);
  // The fresh listing heard of the arrival too.
  expect(f.store.threadIndexMembers(email, "t1")).toEqual(["m1", "m2", "m3", "m7"]);
});

it("orders a conversation by date once its rows are cached, wherever history added a message", async () => {
  const f = await fakeGmail({ index: true });
  await f.threads("t_t1");
  await f.indexed();
  // An imported message: new to the account, older than the rest of its thread.
  f.messages.push({ id: "m0", threadId: "t1", labelIds: ["INBOX"] });
  f.record({ messagesAdded: [{ message: { id: "m0", threadId: "t1", labelIds: ["INBOX"] } }] });
  // Unseen, it sits where history put it: last.
  expect((await f.threads("t_t1")).list[0]!.emailIds).toEqual(["m_m1", "m_m2", "m_m3", "m_m0"]);
  // Once the conversation's rows are read, their dates decide.
  await f.methods["Email/get"]!({
    accountId: f.mail.accountId,
    ids: ["m_m0", "m_m1", "m_m2", "m_m3"],
    properties: ["receivedAt"],
  });
  f.get.mockClear();
  expect((await f.threads("t_t1")).list[0]!.emailIds).toEqual(["m_m0", "m_m1", "m_m2", "m_m3"]);
  expect(f.calls("threads/")).toEqual([]);
});
