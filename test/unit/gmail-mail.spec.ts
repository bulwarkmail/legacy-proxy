import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import Fastify from "fastify";
import { afterEach, expect, it, vi } from "vitest";
import { GmailStore } from "../../src/gmail/store.js";
import { GmailMail } from "../../src/gmail/mail.js";
import { mapMessage, blobId } from "../../src/gmail/message.js";
import { gmailFilter } from "../../src/gmail/filter.js";
import { registerGmailBackend } from "../../src/gmail/backend.js";
import { GmailConnection } from "../../src/gmail/connection.js";
import { GmailApi } from "../../src/gmail/api.js";
import {
  CORE_CAPABILITY,
  MAIL_CAPABILITY,
} from "../../src/jmap/capabilities.js";
const dirs: string[] = [];
const stores: GmailStore[] = [];
afterEach(() => {
  for (const s of stores.splice(0)) s.close();
  for (const d of dirs.splice(0))
    fs.rmSync(d, { recursive: true, force: true });
  vi.useRealTimers();
});
const email = "test@gmail.com";
const profile = {
  emailAddress: email,
  messagesTotal: 3,
  threadsTotal: 2,
  historyId: "123",
};
const labels = [
  {
    id: "INBOX",
    name: "INBOX",
    type: "system",
    messagesTotal: 3,
    messagesUnread: 2,
    threadsTotal: 2,
    threadsUnread: 1,
  },
];
const message = {
  id: "a",
  threadId: "t1",
  internalDate: "1700000000000",
  labelIds: ["INBOX", "UNREAD", "Label_1"],
  payload: {
    mimeType: "multipart/mixed",
    parts: [
      {
        partId: "0",
        mimeType: "text/plain",
        headers: [
          { name: "Content-Type", value: "text/plain; charset=iso-8859-1" },
        ],
        body: {
          data: Buffer.from([99, 97, 102, 233]).toString("base64url"),
          size: 4,
        },
      },
      {
        partId: "1",
        mimeType: "application/pdf",
        filename: "test.pdf",
        body: { attachmentId: "att", size: 3 },
      },
    ],
  },
};
function setup() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "gmail-mail-"));
  dirs.push(d);
  const store = new GmailStore(d, crypto.randomBytes(32));
  stores.push(store);
  const get = vi.fn(
    async (resource: string, _cost: number, params: any = {}) => {
      if (resource === "profile") return profile;
      if (resource === "labels") return { labels };
      if (resource === "labels/INBOX") return labels[0];
      if (resource === "messages")
        return params.pageToken
          ? {
              messages: [
                { id: "b", threadId: "t1" },
                { id: "c", threadId: "t2" },
              ],
              resultSizeEstimate: 900,
            }
          : {
              messages: [
                { id: "a", threadId: "t1" },
                { id: "b", threadId: "t1" },
              ],
              nextPageToken: "p2",
              resultSizeEstimate: 800,
            };
      if (resource === "messages/a/attachments/att")
        return { data: Buffer.from("PDF").toString("base64url") };
      if (resource === "messages/a") return message;
      throw Error("Unexpected fixture resource");
    },
  );
  const mail = new GmailMail(email, { get } as any, store);
  return { store, mail, get };
}
it("paginates exact IDs, de-duplicates pages, reverses and collapses threads, reuses cache", async () => {
  const { mail, get } = setup();
  const q = mail.methods()["Email/query"]!;
  const a = {
    accountId: mail.accountId,
    calculateTotal: true,
    filter: { subject: "test" },
  };
  expect(await q({ ...a, limit: 2 })).toMatchObject({
    ids: ["m_a", "m_b"],
    total: 3,
  });
  expect(await q({ ...a, position: 2 })).toMatchObject({
    ids: ["m_c"],
    total: 3,
  });
  expect(await q({ ...a, collapseThreads: true })).toMatchObject({
    ids: ["m_a", "m_c"],
    total: 2,
  });
  expect(
    await q({
      ...a,
      sort: [{ property: "receivedAt", isAscending: true }],
      anchor: "m_b",
      anchorOffset: 1,
    }),
  ).toMatchObject({ ids: ["m_a"], position: 2 });
  expect(get.mock.calls.filter((c) => c[0] === "messages")).toHaveLength(2);
  await expect(
    q({ ...a, sort: [{ property: "subject" }] }),
  ).rejects.toMatchObject({
    type: "unsupportedSort",
  });
  await expect(q({ ...a, anchor: "missing" })).rejects.toMatchObject({
    type: "anchorNotFound",
  });
});
it("maps labels, charset, immutable part blobs, truncation and attachments", async () => {
  const get = vi.fn(async (p: any) => Buffer.from(p.body.data, "base64url"));
  const result = await mapMessage(
    message,
    { fetchTextBodyValues: true, maxBodyValueBytes: 4 },
    get,
  );
  expect(result).toMatchObject({
    id: "m_a",
    threadId: "t_t1",
    mailboxIds: { all: true, l_INBOX: true, l_Label_1: true },
    keywords: {},
    hasAttachment: true,
    bodyValues: {
      "0": { value: "caf", isTruncated: true, isEncodingProblem: false },
    },
  });
  expect((result.attachments as any[])[0]).toMatchObject({
    name: "test.pdf",
    blobId: blobId("a", "1"),
  });
  expect(get).toHaveBeenCalledTimes(1);
});
it("downloads attachment bytes and scopes cache entries by account", async () => {
  const { mail, store, get } = setup();
  expect((await mail.download(blobId("a", "1"))).body.toString()).toBe("PDF");
  await mail.download(blobId("a", "1"));
  expect(
    get.mock.calls.filter((c) => c[0].includes("attachments")),
  ).toHaveLength(1);
  expect(store.cached("other@gmail.com", "profile")).toBeNull();
});
it("rejects other accounts and writes, invalidates mailbox state on label changes", async () => {
  const { mail, store } = setup();
  const methods = mail.methods();
  await expect(
    methods["Email/get"]!({ accountId: "other", ids: [] }),
  ).rejects.toMatchObject({
    type: "accountNotFound",
  });
  await expect(
    methods["Email/set"]!({ accountId: mail.accountId }),
  ).rejects.toMatchObject({
    type: "accountReadOnly",
  });
  const old = await mail.mailboxState();
  store.cache(email, "labels:g123", [{ ...labels[0], name: "renamed" }], 60000);
  expect(await mail.mailboxState()).not.toBe(old);
  expect(
    await methods["Mailbox/changes"]!({
      accountId: mail.accountId,
      sinceState: old,
    }),
  ).toMatchObject({
    updated: ["l_INBOX"],
    created: [],
    destroyed: [],
  });
});
it("filters only supported Gmail searches", () => {
  expect(
    gmailFilter(
      {
        operator: "AND",
        conditions: [{ inMailbox: "l_INBOX" }, { notKeyword: "$seen" }],
      },
      labels,
    ),
  ).toBe("(in:inbox) (-(-is:unread))");
  expect(() => gmailFilter({ unsupported: true }, labels)).toThrow();
  expect(() => gmailFilter({ subject: "test\nquery" }, labels)).toThrow();
});
it("matches every word of a free-text search and excludes mailboxes", () => {
  const boxes = [
    ...labels,
    { id: "TRASH", name: "TRASH", type: "system" },
    { id: "SPAM", name: "SPAM", type: "system" },
  ];
  expect(gmailFilter({ text: 'quarterly  report "exact phrase"' }, boxes)).toBe(
    '"quarterly" "report" "exact phrase"',
  );
  expect(
    gmailFilter(
      {
        operator: "AND",
        conditions: [
          { text: "x" },
          { inMailboxOtherThan: ["l_TRASH", "l_SPAM"] },
        ],
      },
      boxes,
    ),
  ).toBe('("x") (-(in:trash) -(in:spam))');
  expect(gmailFilter({ inMailboxOtherThan: ["all"] }, boxes)).toBe(
    "in:anywhere -in:anywhere",
  );
  expect(() => gmailFilter({ text: "  " }, boxes)).toThrow();
  expect(() => gmailFilter({ inMailboxOtherThan: "l_TRASH" }, boxes)).toThrow();
});
it("rotates bridge passwords and leaves non-bridge passwords to the legacy backend", async () => {
  const { store, mail } = setup();
  await store.save(
    email,
    { mech: "XOAUTH2", username: email, refreshToken: "fake" },
    { profile, labels },
  );
  const old = store.issuePassword(email);
  const password = store.issuePassword(email);
  expect(store.authenticate(old)).toBeNull();
  expect(store.authenticate(password, "other@gmail.com")).toBeNull();
  const app = Fastify();
  const cfg: any = {
    publicUrl: "https://bridge.test",
    limits: { maxCallsInRequest: 10 },
  };
  const google: any = { allowedEmails: new Set([email]) };
  registerGmailBackend(
    app,
    cfg,
    google,
    store,
    new GmailConnection(google, store),
    () => mail,
  );
  app.get("/jmap/session", async () => ({ legacy: true }));
  app.post("/jmap", async () => ({ legacy: true }));
  app.get("/jmap/download/:accountId/:blobId/:type/:name", async () => ({
    legacy: true,
  }));
  try {
    const authorization =
      "Basic " + Buffer.from(`${email}:${password}`).toString("base64");
    const session = await app.inject({
      url: "/jmap/session",
      headers: { authorization },
    });
    expect(session.statusCode).toBe(200);
    expect(session.json().accounts[mail.accountId].isReadOnly).toBe(true);
    expect(
      session.json().capabilities["urn:ietf:params:jmap:submission"],
    ).toBeUndefined();
    expect(
      (
        await app.inject({
          url: "/jmap/session",
          headers: { authorization: "Bearer " + old },
        })
      ).statusCode,
    ).toBe(401);
    // A sign-in token opens the same mailbox, as a bearer token only.
    const signedIn = store.issueTokens(email, "webmail");
    const bearer = await app.inject({
      url: "/jmap/session",
      headers: { authorization: "Bearer " + signedIn.accessToken },
    });
    expect(bearer.statusCode).toBe(200);
    expect(bearer.json().accounts[mail.accountId]).toBeDefined();
    expect(
      (
        await app.inject({
          url: "/jmap/session",
          headers: {
            authorization:
              "Basic " + Buffer.from(`${email}:${signedIn.accessToken}`).toString("base64"),
          },
        })
      ).json(),
    ).toEqual({ legacy: true });
    store.revokeToken(signedIn.refreshToken, "webmail");
    expect(
      (
        await app.inject({
          url: "/jmap/session",
          headers: { authorization: "Bearer " + signedIn.accessToken },
        })
      ).statusCode,
    ).toBe(401);
    // An IMAP app password for an allowlisted address still reaches the legacy backend.
    const imap = await app.inject({
      url: "/jmap/session",
      headers: {
        authorization:
          "Basic " + Buffer.from(`${email}:app-password`).toString("base64"),
      },
    });
    expect(imap.json()).toEqual({ legacy: true });
    expect(
      (
        await app.inject({
          url: "/jmap/session",
          headers: {
            authorization:
              "Basic " + Buffer.from(`${email}:gmap_wrong`).toString("base64"),
          },
        })
      ).statusCode,
    ).toBe(401);
    const r = await app.inject({
      url: "/jmap",
      method: "POST",
      headers: { authorization },
      payload: {
        using: [CORE_CAPABILITY, MAIL_CAPABILITY],
        methodCalls: [["Email/set", { accountId: mail.accountId }, "a"]],
      },
    });
    expect(r.json().methodResponses[0]).toMatchObject([
      "error",
      { type: "accountReadOnly" },
      "a",
    ]);
    expect(
      (
        await app.inject({
          url: "/jmap",
          method: "POST",
          headers: { authorization },
          payload: { using: [CORE_CAPABILITY], methodCalls: [null] },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          url: `/jmap/download/other/${blobId("a", "1")}/text%2Fplain/file`,
          headers: { authorization },
        })
      ).statusCode,
    ).toBe(404);
  } finally {
    await app.close();
  }
});
it("sanitizes Google errors before they reach JMAP or logs", async () => {
  const { store } = setup();
  await store.save(
    email,
    { mech: "XOAUTH2", username: email, refreshToken: "fake" },
    { profile, labels },
  );
  const client: any = {
    credentials: {},
    setCredentials(c: any) {
      this.credentials = c;
    },
    getAccessToken: async () => {},
    request: async () => {
      throw Object.assign(Error("SECRET TOKEN"), { response: { status: 401 } });
    },
  };
  const connection: any = { createClient: () => client };
  await expect(
    new GmailApi(email, connection, store).get("profile", 1),
  ).rejects.toMatchObject({
    type: "serverUnavailable",
    message:
      "Google authorization expired or was revoked. Reconnect the Google account; the saved draft is retained.",
  });
});

it("opens a large folder without scanning every page", async () => {
  const { mail, store, get } = setup();
  store.cache(email, "profile", { ...profile, messagesTotal: 100000 }, 60000);
  const result = await mail.methods()["Email/query"]!({
    accountId: mail.accountId,
    limit: 2,
    calculateTotal: true,
  });
  expect(result).toMatchObject({ ids: ["m_a", "m_b"], total: 100000 });
  expect(get.mock.calls.filter((c) => c[0] === "messages")).toHaveLength(1);
});

it("lists a folder page by label id instead of a label-name search", async () => {
  const { mail, store, get } = setup();
  // Only this one label's counters are seeded: a folder page must not need
  // the whole label set (one Gmail call per label) to answer.
  store.cache(
    email,
    "label:Label_1:g123",
    {
      id: "Label_1",
      name: "Work / Q&A (2026)",
      type: "user",
      messagesTotal: 2,
    },
    60_000,
  );
  const result = await mail.methods()["Email/query"]!({
    accountId: mail.accountId,
    filter: { inMailbox: "l_Label_1" },
    limit: 2,
    calculateTotal: true,
  });
  expect(result).toMatchObject({ ids: ["m_a", "m_b"], total: 2 });
  const listing = get.mock.calls.find((c) => c[0] === "messages")!;
  expect(listing[2]).toMatchObject({
    labelIds: "Label_1",
    includeSpamTrash: "true",
  });
  expect(listing[2]).not.toHaveProperty("q");
  expect(get.mock.calls.some((c) => c[0] === "labels")).toBe(false);
});
it("treats unmapped client keywords as absent", () => {
  expect(gmailFilter({ hasKeyword: "label/custom.tag" }, labels)).toBe(
    "in:anywhere -in:anywhere",
  );
  expect(gmailFilter({ notKeyword: "$pinned" }, labels)).toBe(
    "-(in:anywhere -in:anywhere)",
  );
});
it("de-duplicates overlapping native folder pages before calculating offsets", async () => {
  const { mail, get } = setup();
  const result = await mail.methods()["Email/query"]!({
    accountId: mail.accountId,
    limit: 3,
    calculateTotal: true,
  });
  expect(result).toMatchObject({ ids: ["m_a", "m_b", "m_c"], total: 3 });
  expect(get.mock.calls.filter((c) => c[0] === "messages")).toHaveLength(2);
});
it("returns malformed thread IDs in notFound without contacting Google", async () => {
  const { mail, get } = setup();
  const result = await mail.methods()["Thread/get"]!({
    accountId: mail.accountId,
    ids: ["bad", "t_../private"],
  });
  expect(result).toMatchObject({ list: [], notFound: ["bad", "t_../private"] });
  expect(get.mock.calls.some((c) => c[0].startsWith("threads/"))).toBe(false);
});
it("treats malformed blob IDs as missing downloads", async () => {
  const { mail, get } = setup();
  await expect(mail.download("gb_invalid")).rejects.toMatchObject({
    type: "notFound",
  });
  expect(get).not.toHaveBeenCalled();
});
it.each([429, 503, "rateLimitExceeded"])(
  "retries temporary Google failure %s, preserving secret redaction",
  async (kind) => {
    const { store } = setup();
    await store.save(
      email,
      { mech: "XOAUTH2", username: email, refreshToken: "fake" },
      { profile, labels },
    );
    vi.useFakeTimers();
    const request = vi
      .fn()
      .mockRejectedValueOnce({
        message: "SECRET",
        response: {
          status: typeof kind === "number" ? kind : 403,
          data: { error: { errors: [{ reason: kind }] } },
          headers: new Headers(),
        },
      })
      .mockResolvedValue({ data: profile });
    const client: any = {
      credentials: {},
      setCredentials(c: any) {
        this.credentials = c;
      },
      getAccessToken: async () => {},
      request,
    };
    const promise = new GmailApi(
      email,
      { createClient: () => client } as any,
      store,
    ).get("profile", 1);
    await vi.runAllTimersAsync();
    expect(await promise).toEqual(profile);
    expect(request).toHaveBeenCalledTimes(2);
  },
);
it("does not retry permanent Google permission errors", async () => {
  const { store } = setup();
  await store.save(
    email,
    { mech: "XOAUTH2", username: email, refreshToken: "fake" },
    { profile, labels },
  );
  const request = vi.fn().mockRejectedValue({
    message: "SECRET",
    response: {
      status: 403,
      data: { error: { errors: [{ reason: "domainPolicy" }] } },
    },
  });
  const client: any = {
    credentials: {},
    setCredentials(c: any) {
      this.credentials = c;
    },
    getAccessToken: async () => {},
    request,
  };
  await expect(
    new GmailApi(email, { createClient: () => client } as any, store).get(
      "profile",
      1,
    ),
  ).rejects.toMatchObject({
    message: "Google denied access; verify account permissions",
  });
  expect(request).toHaveBeenCalledTimes(1);
});
it("bounds retries and honors long Retry-After without holding a request open", async () => {
  const { store } = setup();
  await store.save(
    email,
    { mech: "XOAUTH2", username: email, refreshToken: "fake" },
    { profile, labels },
  );
  const request = vi.fn().mockRejectedValue({
    response: { status: 429, headers: new Headers({ "retry-after": "60" }) },
  });
  const client: any = {
    credentials: {},
    setCredentials(c: any) {
      this.credentials = c;
    },
    getAccessToken: async () => {},
    request,
  };
  const api = new GmailApi(email, { createClient: () => client } as any, store);
  await expect(api.get("profile", 1)).rejects.toMatchObject({
    message: "Google rate limit; retry later",
  });
  await expect(api.get("profile", 1)).rejects.toMatchObject({
    type: "serverUnavailable",
  });
  expect(request).toHaveBeenCalledTimes(1);
});
it("stops after three attempts on a persistent Google outage", async () => {
  const { store } = setup();
  await store.save(
    email,
    { mech: "XOAUTH2", username: email, refreshToken: "fake" },
    { profile, labels },
  );
  vi.useFakeTimers();
  const request = vi
    .fn()
    .mockRejectedValue({ message: "SECRET", response: { status: 503 } });
  const client: any = {
    credentials: {},
    setCredentials(c: any) {
      this.credentials = c;
    },
    getAccessToken: async () => {},
    request,
  };
  const result = expect(
    new GmailApi(email, { createClient: () => client } as any, store).get(
      "profile",
      1,
    ),
  ).rejects.toMatchObject({
    message: "Google temporarily unavailable; retry later",
  });
  await vi.runAllTimersAsync();
  await result;
  expect(request).toHaveBeenCalledTimes(3);
});
it("applies a rate-limit cooldown to requests already waiting for their slot", async () => {
  const { store } = setup();
  await store.save(
    email,
    { mech: "XOAUTH2", username: email, refreshToken: "fake" },
    { profile, labels },
  );
  vi.useFakeTimers();
  const times: number[] = [];
  const request = vi.fn(async () => {
    times.push(Date.now());
    if (times.length === 1) throw { response: { status: 429 } };
    return { data: profile };
  });
  const client: any = {
    credentials: {},
    setCredentials(c: any) {
      this.credentials = c;
    },
    getAccessToken: async () => {},
    request,
  };
  const api = new GmailApi(email, { createClient: () => client } as any, store);
  const results = Promise.all([api.get("profile", 1), api.get("profile", 1)]);
  await vi.runAllTimersAsync();
  expect(await results).toEqual([profile, profile]);
  expect(times[1]! - times[0]!).toBeGreaterThanOrEqual(1000);
});

it("finds the inbox by role so push previews work, and rejects unknown mailbox filters", async () => {
  const f = await setup();
  const call = (filter: unknown) =>
    f.mail.methods()["Mailbox/query"]!({
      accountId: f.mail.accountId,
      filter,
    }) as Promise<{ ids: string[] }>;
  const all = (await call(null)).ids;
  expect(all.length).toBeGreaterThan(1);
  const inbox = await call({ role: "inbox" });
  expect(inbox.ids).toEqual(["l_INBOX"]);
  expect(
    (await call({ role: null })).ids.every(
      (id) => !["l_INBOX", "l_SENT"].includes(id),
    ),
  ).toBe(true);
  expect((await call({ hasAnyRole: true })).ids).toContain("l_INBOX");
  expect(
    (
      await call({
        operator: "AND",
        conditions: [{ role: "inbox" }, { name: "IN" }],
      })
    ).ids,
  ).toEqual(["l_INBOX"]);
  expect(
    (await call({ operator: "NOT", conditions: [{ role: "inbox" }] })).ids,
  ).not.toContain("l_INBOX");
  // Gmail labels are flat: a child query is empty rather than wrong.
  expect((await call({ parentId: "l_INBOX" })).ids).toEqual([]);
  await expect(call({ isSubscribed: "yes" })).rejects.toMatchObject({
    type: "invalidArguments",
  });
  await expect(call({ sortOrder: 1 })).rejects.toMatchObject({
    type: "unsupportedFilter",
  });
});

it("answers unread-in-folder queries from the label counters instead of scanning", async () => {
  const f = await setup();
  const before = f.get.mock.calls.length;
  const r = (await f.mail.methods()["Email/query"]!({
    accountId: f.mail.accountId,
    filter: {
      operator: "AND",
      conditions: [{ inMailbox: "l_INBOX" }, { notKeyword: "$seen" }],
    },
    sort: [{ property: "receivedAt", isAscending: false }],
    limit: 1,
    calculateTotal: true,
  })) as { ids: string[]; total: number };
  // The Inbox label's own unread counter, not an enumeration of every message.
  expect(r.total).toBe(2); // il contatore messagesUnread della Inbox nel fixture
  expect(r.ids.length).toBeLessThanOrEqual(1);
  const listed = f.get.mock.calls
    .slice(before)
    .filter((c) => c[0] === "messages");
  expect(listed.length).toBeGreaterThan(0);
  // Listed by label membership (INBOX + UNREAD), never by a search query.
  for (const call of listed) {
    expect(call[2].labelIds).toEqual(["INBOX", "UNREAD"]);
    expect(call[2].q).toBeUndefined();
  }
});
