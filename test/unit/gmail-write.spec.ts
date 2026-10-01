import Fastify from "fastify";
import { registerGmailBackend } from "../../src/gmail/backend.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { afterEach, it, expect, vi } from "vitest";
import { GmailStore } from "../../src/gmail/store.js";
import { GmailMail } from "../../src/gmail/mail.js";
import { GmailApi } from "../../src/gmail/api.js";
import { GMAIL_MODIFY, GMAIL_READONLY } from "../../src/gmail/config.js";
import { emailPatch } from "../../src/gmail/write.js";
import { JmapError } from "../../src/jmap/errors.js";
const email = "writer@gmail.com";
const profile = { emailAddress: email, historyId: "1", messagesTotal: 1, threadsTotal: 1 };
const labels = [
  ...["INBOX", "TRASH", "SPAM", "UNREAD", "STARRED", "SENT", "DRAFT", "IMPORTANT"].map((id) => ({
    id,
    name: id,
    type: "system",
    messagesTotal: 0,
  })),
  { id: "Label_1", name: "Work", type: "user", messagesTotal: 1 },
];
const message = { id: "a", threadId: "t", internalDate: "1000", labelIds: ["INBOX", "UNREAD", "Label_1"] };
const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const c of cleanup.splice(0)) c();
});
async function setup(scopes = [GMAIL_MODIFY], enabled = true) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gmail-write-"));
  const store = new GmailStore(dir, crypto.randomBytes(32));
  cleanup.push(() => {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  await store.save(
    email,
    { mech: "XOAUTH2", username: email, refreshToken: "refresh", scopes },
    { profile, labels },
  );
  let current = structuredClone(message);
  let labelList = structuredClone(labels);
  const get = vi.fn(async (resource: string) => {
    if (resource === "profile") return profile;
    if (resource === "labels") return { labels: labelList };
    if (resource.startsWith("labels/")) {
      const l = labelList.find((l) => l.id === resource.slice(7));
      if (!l) throw new JmapError("notFound");
      return l;
    }
    if (resource === "messages/a") return structuredClone(current);
    if (resource === "messages") return { messages: [{ id: "a", threadId: "t" }] };
    throw new JmapError("notFound");
  });
  const mutate = vi.fn(async (resource: string, _cost: number, method: string, data: any) => {
    if (resource === "messages/a/modify") {
      current.labelIds = [
        ...new Set([
          ...current.labelIds.filter((l) => !data.removeLabelIds.includes(l)),
          ...data.addLabelIds,
        ]),
      ];
      return structuredClone(current);
    }
    if (resource === "labels") {
      const label = { id: "Label_2", type: "user", messagesTotal: 0, ...data };
      labelList.push(label);
      return label;
    }
    const id = resource.slice(7);
    if (method === "PATCH") {
      labelList = labelList.map((l) => (l.id === id ? { ...l, ...data } : l));
      return labelList.find((l) => l.id === id);
    }
    if (method === "DELETE") {
      labelList = labelList.filter((l) => l.id !== id);
      return {};
    }
    throw new JmapError("serverFail");
  });
  const api = { get, mutate } as any;
  const mail = new GmailMail(email, api, store, enabled);
  const set = (kind: string, a: any) =>
    mail.methods()[kind + "/set"]!({ accountId: mail.accountId, ...a }) as Promise<any>;
  return { store, mail, api, get, mutate, set };
}
it("maps read/unread and stars to Gmail label deltas", () => {
  expect(emailPatch(message, { "keywords/$seen": true, "keywords/$flagged": true }, labels)).toEqual({
    addLabelIds: ["STARRED"],
    removeLabelIds: ["UNREAD"],
  });
  expect(
    emailPatch(
      { ...message, labelIds: ["STARRED"] },
      { "keywords/$seen": null, "keywords/$flagged": null },
      labels,
    ),
  ).toEqual({ addLabelIds: ["UNREAD"], removeLabelIds: ["STARRED"] });
});
it("archives while retaining user labels, and supports trash/restore", () => {
  expect(emailPatch(message, { mailboxIds: { all: true } }, labels)).toEqual({
    addLabelIds: [],
    removeLabelIds: ["INBOX"],
  });
  expect(emailPatch(message, { mailboxIds: { l_TRASH: true }, "keywords/$seen": true }, labels)).toEqual({
    addLabelIds: ["TRASH"],
    removeLabelIds: ["INBOX", "Label_1", "UNREAD"],
  });
  expect(emailPatch({ ...message, labelIds: ["TRASH"] }, { mailboxIds: { l_INBOX: true } }, labels)).toEqual({
    addLabelIds: ["INBOX"],
    removeLabelIds: ["TRASH"],
  });
});
it.each([
  { subject: "changed" },
  { "mailboxIds/l_SENT": true },
  { "keywords/$draft": true },
  { "keywords/$label:red": true },
  { mailboxIds: { all: true }, "mailboxIds/l_INBOX": null },
])("rejects unsupported patch before touching Google: %j", async (patch) => {
  const { set, mutate } = await setup();
  const r = await set("Email", { update: { m_a: patch } });
  expect(r.notUpdated.m_a.type).toBe("invalidProperties");
  expect(mutate).not.toHaveBeenCalled();
});
it.each([
  [GMAIL_READONLY, true],
  [GMAIL_MODIFY, false],
])("requires both modify consent and operator enablement", async (scope, enabled) => {
  const { set, mutate, mail } = await setup([scope as string], enabled as boolean);
  expect(await mail.writable()).toBe(false);
  await expect(set("Email", { update: { m_a: { "keywords/$seen": true } } })).rejects.toMatchObject({
    type: "accountReadOnly",
  });
  expect(mutate).not.toHaveBeenCalled();
});
it("updates partial successes and invalidates cached metadata and state", async () => {
  const { set, mail } = await setup();
  await mail.message("a");
  const oldState = await mail.state();
  const result = await set("Email", {
    ifInState: oldState,
    update: { m_a: { "keywords/$seen": true }, m_missing: { "keywords/$seen": true } },
  });
  expect(result.updated.m_a.keywords.$seen).toBe(true);
  expect(result.notUpdated.m_missing.type).toBe("notFound");
  expect(result.newState).not.toBe(oldState);
  expect((await mail.message("a")).labelIds).not.toContain("UNREAD");
});
it("rejects a stale ifInState without mutation", async () => {
  const { set, mutate } = await setup();
  await expect(
    set("Email", { ifInState: "stale", update: { m_a: { "keywords/$seen": true } } }),
  ).rejects.toMatchObject({ type: "stateMismatch" });
  expect(mutate).not.toHaveBeenCalled();
});
it("rejects permanent deletion and mail creation", async () => {
  const { set, mutate } = await setup();
  const r = await set("Email", { create: { c: {} }, destroy: ["m_a"] });
  expect(r.notCreated.c.type).toBe("forbidden");
  expect(r.notDestroyed.m_a.type).toBe("forbidden");
  expect(mutate).not.toHaveBeenCalled();
});
it("creates, renames and deletes user labels while protecting system labels", async () => {
  const { set, mutate } = await setup();
  expect((await set("Mailbox", { create: { c: { name: "New", parentId: null } } })).created.c.id).toBe(
    "l_Label_2",
  );
  expect((await set("Mailbox", { update: { l_Label_2: { name: "Renamed" } } })).updated).toHaveProperty(
    "l_Label_2",
  );
  const r = await set("Mailbox", { destroy: ["l_INBOX", "l_Label_1", "l_Label_2"] });
  expect(r.destroyed).toEqual(["l_Label_2"]);
  expect(r.notDestroyed.l_INBOX.type).toBe("forbidden");
  expect(r.notDestroyed.l_Label_1.type).toBe("mailboxHasEmail");
  const remove = await set("Mailbox", { destroy: ["l_Label_1"], onDestroyRemoveEmails: true });
  expect(remove.destroyed).toEqual(["l_Label_1"]);
  expect(mutate.mock.calls.some((c) => c[0].startsWith("messages/"))).toBe(false);
});
it("keeps successful writes visible when the post-write read fails", async () => {
  const { set, get, mutate } = await setup();
  const impl = mutate.getMockImplementation()!;
  mutate.mockImplementation(async (...args: any[]) => {
    const result = await (impl as any)(...args);
    get.mockRejectedValue(new JmapError("serverUnavailable"));
    return result;
  });
  const r = await set("Email", { update: { m_a: { "keywords/$seen": true } } });
  expect(r.updated.m_a.keywords.$seen).toBe(true);
  expect(r.newState).toMatch(/^w/);
});
it("serializes simultaneous writes so a following update sees the first", async () => {
  const { set, mail } = await setup();
  await Promise.all([
    set("Email", { update: { m_a: { "keywords/$seen": true } } }),
    set("Email", { update: { m_a: { "keywords/$flagged": true } } }),
  ]);
  const m = await mail.message("a");
  expect(m.labelIds).toContain("STARRED");
  expect(m.labelIds).not.toContain("UNREAD");
});
it("does not repopulate the cache with a read started before invalidation", async () => {
  const { mail, store, get } = await setup();
  let resolve!: (value: any) => void;
  get.mockImplementationOnce(
    () =>
      new Promise((r) => {
        resolve = r;
      }),
  );
  const pending = mail.profile();
  store.invalidate(email);
  resolve(profile);
  await pending;
  expect(store.cached(email, "profile")).toBeNull();
});
it("guards mutation in the API gateway and never retries ambiguous writes", async () => {
  const { store } = await setup();
  const request = vi.fn().mockRejectedValue({ response: { status: 503 }, message: "SECRET" });
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
    store,
  );
  await expect(api.mutate("labels", 5, "POST", { name: "new" })).rejects.toMatchObject({
    type: "serverFail",
    message: "Google update failed; refresh before retrying",
  });
  expect(request).toHaveBeenCalledTimes(1);
  expect((await store.load(email))!.credentials.scopes).toEqual([GMAIL_MODIFY]);
});
it("rejects instead of throwing when the account write queue is full", async () => {
  const { mail } = await setup();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const blockers = Array.from({ length: 10 }, () => (mail as any).exclusive(() => gate));
  let result: Promise<void> | undefined;
  expect(() => {
    result = mail.runScheduled();
  }).not.toThrow();
  await expect(result).rejects.toMatchObject({ type: "serverUnavailable" });
  release();
  await Promise.all(blockers);
});
it("marks writes Google never received or refused as safe to retry", async () => {
  const { store } = await setup();
  const { GmailNotSent } = await import("../../src/gmail/api.js");
  const make = (client: any) =>
    new GmailApi(
      email,
      { config: { writeEnabled: true, composeEnabled: true }, createClient: () => client } as any,
      store,
    );
  const base = {
    credentials: {},
    setCredentials(c: any) {
      this.credentials = c;
    },
  };
  const expired = make({
    ...base,
    getAccessToken: async () => {
      throw { response: { data: { error: "invalid_grant" } } };
    },
    request: vi.fn(),
  });
  await expect(expired.mutate("drafts/send", 100, "POST", { id: "d" })).rejects.toBeInstanceOf(GmailNotSent);
  const rejected = make({
    ...base,
    getAccessToken: async () => {},
    request: vi.fn().mockRejectedValue({ response: { status: 400 } }),
  });
  await expect(rejected.mutate("drafts/send", 100, "POST", { id: "d" })).rejects.toBeInstanceOf(GmailNotSent);
  const unknown = make({
    ...base,
    getAccessToken: async () => {},
    request: vi.fn().mockRejectedValue({ code: "ECONNRESET" }),
  });
  const error = await unknown.mutate("drafts/send", 100, "POST", { id: "d" }).catch((e) => e);
  expect(error).not.toBeInstanceOf(GmailNotSent);
  expect(error.type).toBe("serverFail");
});

it("updates session permissions after consent without changing the bridge password", async () => {
  const { store, mail } = await setup([GMAIL_READONLY]);
  const password = store.issuePassword(email);
  const app = Fastify();
  registerGmailBackend(
    app,
    { publicUrl: "https://bridge.test", limits: { maxCallsInRequest: 10 } } as any,
    { allowedEmails: new Set([email]), writeEnabled: true } as any,
    store,
    {} as any,
    () => mail,
  );
  app.get("/jmap/session", async () => ({ legacy: true }));
  try {
    const headers = { authorization: "Bearer " + password };
    let response = (await app.inject({ url: "/jmap/session", headers })).json();
    expect(response.accounts[mail.accountId].isReadOnly).toBe(true);
    const oldState = response.state;
    await store.save(
      email,
      { mech: "XOAUTH2", username: email, scopes: [GMAIL_MODIFY] },
      { profile, labels },
    );
    response = (await app.inject({ url: "/jmap/session", headers })).json();
    expect(response.accounts[mail.accountId].isReadOnly).toBe(false);
    expect(response.state).not.toBe(oldState);
    expect(response.capabilities["urn:ietf:params:jmap:submission"]).toBeUndefined();
    expect(store.authenticate(password)).toBe(email);
  } finally {
    await app.close();
  }
});
it("blocks send and permanent deletion at the gateway boundary", async () => {
  const { store } = await setup();
  const api = new GmailApi(email, {} as any, store);
  await expect(api.mutate("messages/send", 100, "POST", {})).rejects.toMatchObject({ type: "forbidden" });
  await expect(api.mutate("messages/a", 10, "DELETE")).rejects.toMatchObject({ type: "forbidden" });
});
it("rejects inherited keyword names", () => {
  expect(() => emailPatch(message, { "keywords/constructor": true }, labels)).toThrow("Unsupported keyword");
});

it("token refresh cannot downgrade scopes granted by a simultaneous reconnect", async () => {
  const { store } = await setup();
  await store.updateCredentials(
    email,
    {
      mech: "XOAUTH2",
      username: email,
      refreshToken: "refresh",
      accessToken: "new",
      scopes: [GMAIL_READONLY],
    },
    "refresh",
  );
  expect((await store.load(email))!.credentials.scopes).toEqual([GMAIL_MODIFY]);
});
