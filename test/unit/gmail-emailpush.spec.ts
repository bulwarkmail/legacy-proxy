import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { afterEach, beforeEach, it, expect, vi } from "vitest";
import { GmailStore } from "../../src/gmail/store.js";
import { GmailMail } from "../../src/gmail/mail.js";
import { GmailPush } from "../../src/gmail/push.js";
import { GMAIL_MODIFY } from "../../src/gmail/config.js";
import { JmapError } from "../../src/jmap/errors.js";
const email = "pushed@example.test";
const PUSH = {
  topic: "projects/p/topics/gmail",
  token: "a-very-long-shared-secret-token-123",
};
const RELAY = "https://relay.example.test/push/device-1";
const labels = [
  { id: "INBOX", name: "INBOX", type: "system" },
  { id: "DRAFT", name: "DRAFT", type: "system" },
];
const cleanup: (() => void)[] = [];
let posts: { url: string; kind: string; body: any }[] = [];
beforeEach(() => {
  posts = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: any) => {
      posts.push({
        url,
        kind: init.headers["x-push-type"],
        body: JSON.parse(init.body),
      });
      return { ok: true, status: 200 };
    }),
  );
});
afterEach(() => {
  for (const f of cleanup.splice(0)) f();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
async function setup(pushEnabled = true) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gmail-subs-"));
  const store = new GmailStore(dir, crypto.randomBytes(32));
  cleanup.push(() => {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  await store.save(
    email,
    {
      mech: "XOAUTH2",
      username: email,
      refreshToken: "r",
      scopes: [GMAIL_MODIFY],
    },
    {
      profile: {
        emailAddress: email,
        historyId: "10",
        messagesTotal: 1,
        threadsTotal: 1,
      },
      labels,
    },
  );
  const state = {
    history: "10",
    records: [] as any[],
    messages: {} as Record<string, any>,
  };
  const get = vi.fn(async (resource: string, _c: number, params: any = {}) => {
    if (resource === "profile")
      return {
        emailAddress: email,
        historyId: state.history,
        messagesTotal: 1,
        threadsTotal: 1,
      };
    if (resource === "labels") return { labels };
    if (resource.startsWith("labels/"))
      return labels.find((l) => l.id === resource.slice(7));
    if (resource === "history")
      return {
        historyId: state.history,
        history: params.startHistoryId === state.history ? [] : state.records,
      };
    if (resource.startsWith("messages/")) {
      const m = state.messages[decodeURIComponent(resource.slice(9))];
      if (!m) throw new JmapError("notFound");
      return m;
    }
    throw Error("unexpected " + resource);
  });
  const mutate = vi.fn(async () => ({
    historyId: state.history,
    expiration: String(Date.now() + 7 * 86400_000),
  }));
  const mail = new GmailMail(
    email,
    { get, mutate } as any,
    store,
    true,
    true,
    false,
    undefined,
    pushEnabled,
  );
  const push = new GmailPush(store, () => mail, new Set([email]), PUSH, {
    warn: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
  } as any);
  cleanup.push(() => push.stop());
  await mail.pushSync(); // prime the history cursor, as a real account does on first read
  const call = (name: string, args: any = {}) =>
    mail.methods()[name]!(args) as Promise<any>;
  const subscribe = async () => {
    const r = await call("PushSubscription/set", {
      create: {
        s: { deviceClientId: "dev-1", url: RELAY, types: ["EmailDelivery"] },
      },
    });
    const id = r.created.s.id;
    const code = posts.find((p) => p.kind === "PushVerification")!.body
      .verificationCode;
    return { id, code, created: r.created.s };
  };
  const deliver = (id: string, labelIds = ["INBOX", "UNREAD"]) => {
    state.history = String(Number(state.history) + 1);
    state.records = [
      {
        id: state.history,
        messagesAdded: [{ message: { id, threadId: "t" + id, labelIds } }],
      },
    ];
    state.messages[id] = {
      id,
      threadId: "t" + id,
      labelIds,
      internalDate: "1",
    };
  };
  return { store, mail, push, call, subscribe, deliver, state, get };
}

/** A verified subscription that also asks to hear what arrived. */
async function subscribeWithEmailPush(
  call: (name: string, args?: any) => Promise<any>,
  accountId: string,
  config: Record<string, unknown>,
) {
  const created = await call("PushSubscription/set", {
    create: {
      s: {
        deviceClientId: "dev-1",
        url: RELAY,
        types: ["EmailDelivery"],
        emailPush: { [accountId]: config },
      },
    },
  });
  const id = created.created?.s?.id;
  if (!id) return { id: null, notCreated: created.notCreated?.s };
  const code = posts.find((p) => p.kind === "PushVerification")!.body
    .verificationCode;
  await call("PushSubscription/set", {
    update: { [id]: { verificationCode: code } },
  });
  posts.length = 0;
  return { id, notCreated: undefined };
}

it("pushes the delivered message, not just the fact of a delivery", async () => {
  const { mail, call, deliver, push } = await setup();
  const { id } = await subscribeWithEmailPush(call, mail.accountId, {
    filter: {
      operator: "AND",
      conditions: [{ notKeyword: "$junk" }, { inMailboxOtherThan: ["l_SPAM"] }],
    },
    properties: ["id", "threadId"],
  });
  expect(id).toMatch(/^gp_/);
  // The client reads its own config back to decide whether to patch it.
  const listed = (await call("PushSubscription/get", {})).list[0];
  expect(listed.emailPush[mail.accountId].properties).toEqual(["id", "threadId"]);

  deliver("m1");
  await push.sync(email);

  const pushed = posts.filter((p) => p.kind === "EmailPush");
  expect(pushed).toHaveLength(1);
  expect(pushed[0]!.body).toMatchObject({
    "@type": "EmailPush",
    accountId: mail.accountId,
    emails: [{ id: "m_m1", threadId: "t_tm1" }],
  });
  expect(typeof pushed[0]!.body.state).toBe("string");
  // Only what was asked for: no subject, no preview, nothing through the relay
  // that the subscriber did not request.
  expect(Object.keys(pushed[0]!.body.emails[0])).toEqual(["id", "threadId"]);
  // And no EmailDelivery ping for the same arrival: it would only send the
  // client back to guessing which message it was.
  const changes = posts.filter((p) => p.kind === "StateChange");
  expect(
    changes.some((c) => c.body.changed[mail.accountId]?.EmailDelivery),
  ).toBe(false);
});

it("stays quiet when the delivery is not one the subscriber asked for", async () => {
  const { mail, call, deliver, push } = await setup();
  await subscribeWithEmailPush(call, mail.accountId, {
    filter: { notKeyword: "$seen" },
    properties: ["id"],
  });

  // Delivered already read - Gmail without the UNREAD label - so the filter
  // rejects it. Nothing at all should reach the device: not an EmailPush,
  // and not the EmailDelivery ping either.
  deliver("m2", ["INBOX"]);
  await push.sync(email);

  expect(posts.filter((p) => p.kind === "EmailPush")).toHaveLength(0);
  expect(
    posts
      .filter((p) => p.kind === "StateChange")
      .some((c) => c.body.changed[mail.accountId]?.EmailDelivery),
  ).toBe(false);
});

it("still sends a bare state change to a subscription without emailPush", async () => {
  const { mail, call, deliver, push, subscribe } = await setup();
  const { id, code } = await subscribe();
  await call("PushSubscription/set", {
    update: { [id]: { verificationCode: code } },
  });
  posts.length = 0;

  deliver("m3");
  await push.sync(email);

  const changes = posts.filter((p) => p.kind === "StateChange");
  expect(changes).toHaveLength(1);
  expect(changes[0]!.body.changed[mail.accountId].EmailDelivery).toBeTruthy();
  expect(posts.filter((p) => p.kind === "EmailPush")).toHaveLength(0);
});

it("refuses a filter or a property it could not honour", async () => {
  const { mail, call } = await setup();
  for (const config of [
    { filter: { text: "invoice" }, properties: ["id"] },
    { filter: {}, properties: ["bodyValues"] },
    { filter: {}, properties: ["id"], urgency: "immediate" },
    { filter: {}, properties: ["id"], nonsense: true },
  ]) {
    const { id, notCreated } = await subscribeWithEmailPush(
      call,
      mail.accountId,
      config,
    );
    expect(id, JSON.stringify(config)).toBeNull();
    expect(notCreated.type).toBe("invalidProperties");
  }
  // An account the connection does not serve is refused too.
  const other = await subscribeWithEmailPush(call, "g_somebodyelse", {
    filter: {},
    properties: ["id"],
  });
  expect(other.id).toBeNull();
  expect(other.notCreated.description).toMatch(/No access/);
});
