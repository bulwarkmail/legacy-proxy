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
it("creates a subscription, sends the verification handshake and hides the code", async () => {
  const { call, subscribe } = await setup();
  const { id, code, created } = await subscribe();
  expect(id).toMatch(/^gp_/);
  expect(created.verified).toBe(false);
  expect(Date.parse(created.expires)).toBeGreaterThan(Date.now());
  const verification = posts.find((p) => p.kind === "PushVerification")!;
  expect(verification.url).toBe(RELAY);
  expect(verification.body).toEqual({
    "@type": "PushVerification",
    pushSubscriptionId: id,
    verificationCode: code,
  });
  const listed = (await call("PushSubscription/get", {})).list[0];
  expect(listed).toMatchObject({
    id,
    deviceClientId: "dev-1",
    url: RELAY,
    types: ["EmailDelivery"],
    verified: false,
    keys: null,
  });
  expect(listed).not.toHaveProperty("verificationCode");
  const wrong = await call("PushSubscription/set", {
    update: { [id]: { verificationCode: "nope" } },
  });
  expect(wrong.notUpdated[id].type).toBe("invalidProperties");
  const ok = await call("PushSubscription/set", {
    update: { [id]: { verificationCode: code } },
  });
  expect(ok.updated).toEqual({ [id]: null });
  expect((await call("PushSubscription/get", {})).list[0].verified).toBe(true);
});
it("rejects a non-https url, unknown types and unsupported properties", async () => {
  const { call } = await setup();
  for (const bad of [
    { url: "http://relay.example.test/x", types: ["EmailDelivery"] },
    { url: "https://x.test/" + "y".repeat(2100), types: ["EmailDelivery"] },
    { url: RELAY, types: ["Calendar"] },
    { url: RELAY, expires: "2000-01-01T00:00:00Z" },
    { url: RELAY, types: ["EmailDelivery"], unknownProp: 1 },
  ]) {
    const r = await call("PushSubscription/set", { create: { s: bad } });
    expect(r.notCreated.s.type, JSON.stringify(bad)).toBe("invalidProperties");
  }
  expect((await call("PushSubscription/get", {})).list).toHaveLength(0);
  // Web Push keys are legitimate: accepted, stored for nobody, never echoed back.
  const withKeys = await call("PushSubscription/set", {
    create: {
      s: {
        url: RELAY,
        types: ["EmailDelivery"],
        keys: { p256dh: "x", auth: "y" },
      },
    },
  });
  expect(withKeys.created.s.id).toBeTruthy();
  expect((await call("PushSubscription/get", {})).list[0].keys).toBeNull();
});
it("notifies verified subscribers only when mail is actually delivered", async () => {
  const { call, subscribe, deliver, push, mail, state } = await setup();
  const { id, code } = await subscribe();
  deliver("m1");
  await push.sync(email);
  expect(posts.filter((p) => p.kind === "StateChange")).toHaveLength(0); // still unverified
  await call("PushSubscription/set", {
    update: { [id]: { verificationCode: code } },
  });
  deliver("m2");
  await push.sync(email);
  const change = posts.filter((p) => p.kind === "StateChange");
  expect(change).toHaveLength(1);
  expect(change[0]!.body["@type"]).toBe("StateChange");
  expect(Object.keys(change[0]!.body.changed[mail.accountId])).toEqual([
    "EmailDelivery",
  ]); // subscribed type only
  // A label change is not a delivery: no notification.
  state.history = String(Number(state.history) + 1);
  state.records = [
    {
      id: state.history,
      labelsAdded: [
        {
          message: {
            id: "m2",
            threadId: "tm2",
            labelIds: ["INBOX", "STARRED"],
          },
        },
      ],
    },
  ];
  await push.sync(email);
  expect(posts.filter((p) => p.kind === "StateChange")).toHaveLength(1);
});
it("ignores mail filed straight into spam, trash, drafts or sent", async () => {
  const { call, subscribe, deliver, push } = await setup();
  const { id, code } = await subscribe();
  await call("PushSubscription/set", {
    update: { [id]: { verificationCode: code } },
  });
  for (const labels of [["SPAM"], ["TRASH", "INBOX"], ["DRAFT"], ["SENT"]]) {
    deliver("x" + labels.join(""), labels);
    await push.sync(email);
  }
  expect(posts.filter((p) => p.kind === "StateChange")).toHaveLength(0);
});
it("asks Gmail for the labels when the history record omits them", async () => {
  const { call, subscribe, push, state, get } = await setup();
  const { id, code } = await subscribe();
  await call("PushSubscription/set", {
    update: { [id]: { verificationCode: code } },
  });
  state.history = "11";
  state.records = [
    { id: "11", messagesAdded: [{ message: { id: "m9", threadId: "t9" } }] },
  ];
  state.messages.m9 = {
    id: "m9",
    threadId: "t9",
    labelIds: ["INBOX"],
    internalDate: "1",
  };
  await push.sync(email);
  expect(get.mock.calls.some((c) => c[0] === "messages/m9")).toBe(true);
  expect(posts.filter((p) => p.kind === "StateChange")).toHaveLength(1);
});
it("drops an endpoint the push service has discarded and expires old subscriptions", async () => {
  const { call, subscribe, deliver, push, store } = await setup();
  const { id, code } = await subscribe();
  await call("PushSubscription/set", {
    update: { [id]: { verificationCode: code } },
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: false, status: 410 })),
  );
  deliver("m3");
  await push.sync(email);
  expect((await call("PushSubscription/get", {})).list).toHaveLength(0);
  // An expired subscription disappears on its own.
  const second = await call("PushSubscription/set", {
    create: {
      s: {
        url: RELAY,
        types: ["EmailDelivery"],
        expires: new Date(Date.now() + 60_000).toISOString(),
      },
    },
  });
  expect(second.created.s.id).toBeTruthy();
  expect(store.subscriptions(email, Date.now() + 120_000)).toHaveLength(0);
});
it("refuses the methods entirely when push is not configured", async () => {
  const { call } = await setup(false);
  await expect(call("PushSubscription/get", {})).rejects.toMatchObject({
    type: "accountReadOnly",
  });
  await expect(
    call("PushSubscription/set", { create: { s: { url: RELAY } } }),
  ).rejects.toMatchObject({ type: "accountReadOnly" });
});
