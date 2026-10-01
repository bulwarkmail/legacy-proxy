import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { afterEach, it, expect, vi } from "vitest";
import { GmailStore } from "../../src/gmail/store.js";
import { GmailMail } from "../../src/gmail/mail.js";
import { JmapError } from "../../src/jmap/errors.js";
import { readHistory, emailDelta } from "../../src/gmail/history.js";
const cleanup: (() => void)[] = [];
afterEach(() => {
  cleanup.splice(0).forEach((f) => f());
  vi.useRealTimers();
});
const email = "workspace@example.test";
function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gmail-history-"));
  const key = crypto.randomBytes(32);
  let store = new GmailStore(dir, key);
  cleanup.push(() => {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  let history = "10";
  let labelName = "INBOX";
  let unread = true;
  let fail = false;
  let expire = false;
  const records = [
    { id: "11", labelsRemoved: [{ message: { id: "a", threadId: "ta" }, labelIds: ["UNREAD"] }] },
  ];
  const get = vi.fn(async (resource: string, _cost: number, params: any = {}) => {
    if (resource === "profile")
      return { emailAddress: email, historyId: history, messagesTotal: 2, threadsTotal: 2 };
    if (resource === "history") {
      if (fail) throw new JmapError("serverUnavailable");
      if (expire) throw new JmapError("notFound");
      return { historyId: history, history: params.startHistoryId === "10" ? records : [] };
    }
    if (resource === "labels") return { labels: [{ id: "INBOX", name: labelName, type: "system" }] };
    if (resource === "labels/INBOX")
      return {
        id: "INBOX",
        name: labelName,
        type: "system",
        messagesTotal: 2,
        messagesUnread: unread ? 1 : 0,
      };
    if (resource.startsWith("messages/"))
      return {
        id: resource.slice(9),
        threadId: "t" + resource.slice(9),
        labelIds: unread ? ["INBOX", "UNREAD"] : ["INBOX"],
        internalDate: "0",
      };
    throw Error("Unexpected resource");
  });
  const api = { get } as any;
  let mail = new GmailMail(email, api, store);
  return {
    get,
    get store() {
      return store;
    },
    get mail() {
      return mail;
    },
    advance: () => {
      history = "11";
      unread = false;
      labelName = "Renamed";
      store.cache(
        email,
        "profile",
        { emailAddress: email, historyId: history, messagesTotal: 2, threadsTotal: 2 },
        30000,
      );
    },
    fail: () => {
      fail = true;
    },
    expire: () => {
      expire = true;
    },
    restart: () => {
      store.close();
      store = new GmailStore(dir, key);
      mail = new GmailMail(email, api, store);
    },
  };
}
it("paginates history fully and preserves IDs larger than JS safe integers", async () => {
  const get = vi
    .fn()
    .mockResolvedValueOnce({
      historyId: "90071992547409999",
      history: [{ id: "90071992547409997" }],
      nextPageToken: "p",
    })
    .mockResolvedValueOnce({ historyId: "90071992547409999", history: [{ id: "90071992547409998" }] });
  const r = await readHistory({ get } as any, "90071992547409996");
  expect(r.records).toHaveLength(2);
  expect(get.mock.calls[1][2]).toMatchObject({ startHistoryId: "90071992547409996", pageToken: "p" });
});
it("rejects expired and repeated history without a partial result", async () => {
  await expect(
    readHistory({ get: vi.fn().mockRejectedValue(new JmapError("notFound")) } as any, "10"),
  ).rejects.toMatchObject({ type: "cannotCalculateChanges" });
  await expect(
    readHistory({ get: vi.fn().mockResolvedValue({ historyId: "11", nextPageToken: "p" }) } as any, "10"),
  ).rejects.toMatchObject({ type: "cannotCalculateChanges" });
});
it("coalesces creation/deletion and sent-draft aliases into disjoint changes", () => {
  const r = emailDelta(
    [
      { id: "1", messagesAdded: [{ message: { id: "temporary" } }] },
      {
        id: "2",
        messagesDeleted: [{ message: { id: "temporary" } }, { message: { id: "draft" } }],
        messagesAdded: [{ message: { id: "sent" } }, { message: { id: "new" } }],
        labelsAdded: [{ message: { id: "old" } }],
      },
    ],
    (id) => (id === "sent" ? "draft" : id),
  );
  expect(r).toEqual({ created: ["m_new"], updated: ["m_draft", "m_old"], destroyed: [] });
});
it("invalidates only changed messages, keeps unchanged bodies, and exposes Email/changes", async () => {
  const f = setup();
  const old = await f.mail.state();
  await f.mail.message("a");
  await f.mail.message("b");
  const calls = f.get.mock.calls.filter((c) => c[0] === "messages/b").length;
  f.advance();
  const r = (await f.mail.methods()["Email/changes"]!({
    accountId: f.mail.accountId,
    sinceState: old,
  })) as any;
  expect(r).toMatchObject({ updated: ["m_a"], created: [], destroyed: [], hasMoreChanges: false });
  expect(f.store.cursor(email)).toBe("11");
  await f.mail.message("b");
  expect(f.get.mock.calls.filter((c) => c[0] === "messages/b")).toHaveLength(calls);
  const a = await f.mail.message("a");
  expect(a.labelIds).not.toContain("UNREAD");
});
it("persists cursor and mailbox snapshots across real database close/reopen", async () => {
  const f = setup();
  const before = await f.mail.mailboxState();
  const old = await f.mail.state();
  f.restart();
  f.advance();
  expect(
    await f.mail.methods()["Mailbox/changes"]!({ accountId: f.mail.accountId, sinceState: before }),
  ).toMatchObject({ updated: ["l_INBOX"] });
  expect(
    await f.mail.methods()["Email/changes"]!({ accountId: f.mail.accountId, sinceState: old }),
  ).toMatchObject({ updated: ["m_a"] });
});
it("leaves the cursor unchanged on network failure and clears stale caches after expired history", async () => {
  const f = setup();
  await f.mail.state();
  await f.mail.message("a");
  f.advance();
  f.fail();
  await expect(f.mail.state()).rejects.toMatchObject({ type: "serverUnavailable" });
  expect(f.store.cursor(email)).toBe("10");
  const e = setup();
  const old = await e.mail.state();
  await e.mail.message("a");
  e.advance();
  e.expire();
  await e.mail.state();
  expect(e.store.cursor(email)).toBe("11");
  expect(e.store.cached(email, "message:v2:a")).toBeNull();
  await expect(
    e.mail.methods()["Email/changes"]!({ accountId: e.mail.accountId, sinceState: old }),
  ).rejects.toMatchObject({ type: "cannotCalculateChanges" });
});
it("refuses too-small maxChanges without handing out a partial checkpoint", async () => {
  const f = setup();
  const old = await f.mail.mailboxState();
  f.advance();
  await expect(
    f.mail.methods()["Mailbox/changes"]!({ accountId: f.mail.accountId, sinceState: old, maxChanges: 0 }),
  ).rejects.toMatchObject({ type: "invalidArguments" });
});
it("keeps sync cursors and snapshot contents isolated between accounts", async () => {
  const f = setup();
  await f.mail.mailboxState();
  expect(f.store.cursor("other@example.test")).toBeNull();
  expect(f.store.mailboxSnapshot("other@example.test", await f.mail.mailboxState())).toBeNull();
});
it("refreshes credentials durably and sanitizes revoked grants", async () => {
  const f = setup();
  const { GmailApi } = await import("../../src/gmail/api.js");
  await f.store.save(
    email,
    { mech: "XOAUTH2", username: email, refreshToken: "refresh", accessToken: "old", expiresAt: 1 },
    { profile: { emailAddress: email, historyId: "10", messagesTotal: 0, threadsTotal: 0 }, labels: [] },
  );
  const client: any = {
    credentials: {},
    setCredentials(c: any) {
      this.credentials = c;
    },
    getAccessToken: vi.fn(async () => {
      client.credentials.access_token = "fresh";
      client.credentials.expiry_date = Date.now() + 3600000;
    }),
    request: vi.fn(async () => ({ data: { ok: true } })),
  };
  const api = new GmailApi(email, { createClient: () => client } as any, f.store);
  await api.get("profile", 1);
  f.restart();
  expect((await f.store.load(email))?.credentials.accessToken).toBe("fresh");
  client.getAccessToken.mockRejectedValue({
    response: { status: 400, data: { error: "invalid_grant", error_description: "SECRET" } },
    config: { headers: { Authorization: "SECRET" } },
  });
  const restarted = new GmailApi(email, { createClient: () => client } as any, f.store);
  await expect(restarted.get("profile", 1)).rejects.toMatchObject({
    type: "serverUnavailable",
    message: expect.stringContaining("revoked"),
  });
  expect((await f.store.load(email))?.credentials.refreshToken).toBe("refresh");
});
it("retries transient read network failures, but never replays a write", async () => {
  vi.useFakeTimers();
  const f = setup();
  const { GmailApi } = await import("../../src/gmail/api.js");
  await f.store.save(
    email,
    {
      mech: "XOAUTH2",
      username: email,
      refreshToken: "r",
      scopes: ["https://www.googleapis.com/auth/gmail.modify"],
    },
    { profile: { emailAddress: email, historyId: "10", messagesTotal: 0, threadsTotal: 0 }, labels: [] },
  );
  const request = vi
    .fn()
    .mockRejectedValueOnce({ code: "ECONNRESET" })
    .mockResolvedValue({ data: { ok: true } });
  const client: any = {
    credentials: {},
    setCredentials(c: any) {
      this.credentials = c;
    },
    getAccessToken: async () => {},
    request,
  };
  const api = new GmailApi(
    email,
    { config: { writeEnabled: true }, createClient: () => client } as any,
    f.store,
  );
  const read = api.get("profile", 1);
  await vi.runAllTimersAsync();
  expect(await read).toEqual({ ok: true });
  expect(request).toHaveBeenCalledTimes(2);
  request.mockReset().mockRejectedValue({ code: "ECONNRESET" });
  const write = expect(api.mutate("labels", 5, "POST", { name: "test" })).rejects.toMatchObject({
    type: "serverFail",
  });
  await vi.runAllTimersAsync();
  await write;
  expect(request).toHaveBeenCalledTimes(1);
});
