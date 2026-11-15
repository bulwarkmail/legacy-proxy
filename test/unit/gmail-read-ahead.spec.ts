import { expect, it } from "vitest";
import { fakeGmail } from "./gmail-fake.js";

it("reads only the rows of a listed page once the index knows the conversations", async () => {
  const f = await fakeGmail({ index: true });
  await f.threads("t_t1");
  await f.indexed();
  f.get.mockClear();
  f.batch.mockClear();
  const listed = (await f.methods["Email/query"]!({
    accountId: f.mail.accountId,
    filter: { inMailbox: "l_INBOX" },
    limit: 50,
  })) as any;
  const rows = (await f.methods["Email/get"]!({
    accountId: f.mail.accountId,
    ids: listed.ids,
    properties: ["threadId", "subject", "hasAttachment"],
  })) as any;
  const threads = await f.threads(...rows.list.map((r: any) => r.threadId));
  expect(threads.list.find((t) => t.id === "t_t1")!.emailIds).toEqual(["m_m1", "m_m2", "m_m3"]);
  // One batch of message rows as metadata; no conversation was read.
  expect(f.batch.mock.calls.map((c) => [c[0][0].resource.split("/")[0], c[0][0].params?.format, c[0].length])).toEqual([
    ["messages", "metadata", 4],
  ]);
  expect(f.calls("threads/")).toEqual([]);
});

const batchedIds = (f: Awaited<ReturnType<typeof fakeGmail>>) =>
  f.batch.mock.calls.map((c) => (c[0] as { resource: string }[]).map((r) => r.resource.split("/")[1]));
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

it("reads the next page's rows ahead of a scroll when the minute has room, and not otherwise", async () => {
  for (const spare of [6000, 500]) {
    const f = await fakeGmail({ index: true, older: 12, spare });
    await f.threads("t_t1");
    await f.indexed();
    f.batch.mockClear();
    const listed = (await f.methods["Email/query"]!({
      accountId: f.mail.accountId,
      filter: { inMailbox: "l_INBOX" },
      limit: 5,
    })) as any;
    expect(listed.ids).toEqual(["m_m5", "m_m4", "m_m3", "m_m1", "m_o100"]);
    await settle();
    const next = ["o99", "o98", "o97", "o96", "o95"];
    expect(batchedIds(f)).toEqual(
      spare === 6000 ? [["m5", "m4", "m3", "m1", "o100"], next] : [["m5", "m4", "m3", "m1", "o100"]],
    );
    // The scroll: the next page is asked for and, read ahead, costs nothing.
    f.batch.mockClear();
    const rows = (await f.methods["Email/get"]!({
      accountId: f.mail.accountId,
      ids: next.map((id) => "m_" + id),
      properties: ["subject"],
    })) as any;
    expect(rows.list).toHaveLength(5);
    expect(f.batch).toHaveBeenCalledTimes(spare === 6000 ? 0 : 1);
  }
});

it("reads rows two callers ask for at the same moment only once", async () => {
  const f = await fakeGmail();
  const ask = () =>
    f.methods["Email/get"]!({
      accountId: f.mail.accountId,
      ids: ["m_m5", "m_m4", "m_m3"],
      properties: ["subject"],
    }) as Promise<any>;
  const [a, b] = await Promise.all([ask(), ask()]);
  expect(a.list).toHaveLength(3);
  expect(b.list).toHaveLength(3);
  expect(batchedIds(f)).toEqual([["m5", "m4", "m3"]]);
  expect(f.calls("messages/")).toHaveLength(3); // the three reads of that one batch
});

it("does not hold a read of other messages behind a page being read", async () => {
  const f = await fakeGmail({ index: true, older: 12 });
  await f.threads("t_t1");
  await f.indexed();
  const read = f.batch.getMockImplementation()!;
  let pageDone = false;
  // The page's rows take a while; anything else answers at once.
  f.batch.mockImplementation(async (reads: { resource: string }[]) => {
    if (reads.some((r) => r.resource === "messages/m5")) {
      await new Promise((resolve) => setTimeout(resolve, 80));
      pageDone = true;
    }
    return (read as any)(reads);
  });
  await f.methods["Email/query"]!({ accountId: f.mail.accountId, filter: { inMailbox: "l_INBOX" }, limit: 5 });
  // Two old messages nobody listed - new mail read as it arrives is the same case.
  const other = (await f.methods["Email/get"]!({
    accountId: f.mail.accountId,
    ids: ["m_o90", "m_o89"],
    properties: ["subject"],
  })) as any;
  expect(other.list).toHaveLength(2);
  expect(pageDone).toBe(false);
  // The page's own rows do wait for it, and are read once.
  const rows = (await f.methods["Email/get"]!({
    accountId: f.mail.accountId,
    ids: ["m_m5", "m_m4"],
    properties: ["subject"],
  })) as any;
  expect(rows.list).toHaveLength(2);
  expect(pageDone).toBe(true);
  expect(batchedIds(f).filter((ids) => ids.includes("m5"))).toHaveLength(1);
});
