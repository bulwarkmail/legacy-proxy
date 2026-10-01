import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { simpleParser } from "mailparser";
import Fastify from "fastify";
import { afterEach, it, expect, vi } from "vitest";
import { GmailStore } from "../../src/gmail/store.js";
import { GmailMail } from "../../src/gmail/mail.js";
import { GMAIL_MODIFY } from "../../src/gmail/config.js";
import { JmapError } from "../../src/jmap/errors.js";
import { dispatch } from "../../src/jmap/router.js";
import { registerGmailBackend } from "../../src/gmail/backend.js";
import { CORE_CAPABILITY, MAIL_CAPABILITY, SUBMISSION_CAPABILITY } from "../../src/jmap/capabilities.js";
const email = "writer@example.test";
const caps = [CORE_CAPABILITY, MAIL_CAPABILITY, SUBMISSION_CAPABILITY];
const profile = { emailAddress: email, historyId: "1", messagesTotal: 0, threadsTotal: 0 };
const labels = ["INBOX", "SENT", "DRAFT"].map((id) => ({
  id,
  name: id,
  type: "system",
  messagesTotal: 0,
  messagesUnread: 0,
}));
const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const f of cleanup.splice(0)) f();
});
async function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gmail-compose-"));
  const store = new GmailStore(dir, crypto.randomBytes(32));
  cleanup.push(() => {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  await store.save(
    email,
    { mech: "XOAUTH2", username: email, refreshToken: "refresh", scopes: [GMAIL_MODIFY] },
    { profile, labels },
  );
  const drafts = new Map<string, any>();
  const messages = new Map<string, any>();
  let next = 0;
  const get = vi.fn(async (resource: string, _cost: number, params: any = {}) => {
    if (resource === "profile") return { ...profile, messagesTotal: messages.size };
    if (resource === "labels") return { labels };
    if (resource.startsWith("labels/")) return labels.find((l) => l.id === resource.slice(7));
    if (resource === "drafts") return { drafts: [...drafts.values()] };
    if (resource.startsWith("drafts/")) {
      const d = drafts.get(resource.slice(7));
      if (!d) throw new JmapError("notFound");
      return structuredClone(d);
    }
    if (resource === "messages")
      return { messages: [...messages.values()].map((m) => ({ id: m.id, threadId: m.threadId })) };
    if (resource.startsWith("messages/")) {
      const m = messages.get(resource.slice(9));
      if (!m) throw new JmapError("notFound");
      return structuredClone(m);
    }
    throw Error("Unexpected fixture resource");
  });
  const mutate = vi.fn(async (resource: string, _cost: number, method: string, data: any) => {
    if (resource === "drafts") {
      const n = ++next;
      const m = {
        id: "dmsg" + n,
        threadId: "thread" + n,
        labelIds: ["DRAFT"],
        internalDate: "1000",
        raw: data.message.raw,
      };
      const d = { id: "draft" + n, message: m };
      messages.set(m.id, m);
      drafts.set(d.id, d);
      return structuredClone(d);
    }
    if (resource === "drafts/send") {
      const d = drafts.get(data.id);
      if (!d) throw new JmapError("notFound");
      const m = { ...d.message, id: "sent" + next, labelIds: ["SENT"] };
      messages.delete(d.message.id);
      messages.set(m.id, m);
      drafts.delete(d.id);
      return structuredClone(m);
    }
    if (resource === "messages/import") {
      const n = ++next;
      const m = {
        id: "imsg" + n,
        threadId: "ithread" + n,
        labelIds: [...data.labelIds],
        internalDate: "2000",
        sizeEstimate: 800,
        raw: data.raw,
      };
      messages.set(m.id, m);
      // Live Gmail answers messages.import with the id alone.
      return { id: m.id };
    }
    if (resource.startsWith("drafts/") && method === "DELETE") {
      const d = drafts.get(resource.slice(7));
      if (!d) throw new JmapError("notFound");
      messages.delete(d.message.id);
      drafts.delete(d.id);
      return {};
    }
    throw Error("Unexpected fixture mutation");
  });
  const api = { get, mutate } as any;
  const mail = new GmailMail(email, api, store, true, true);
  const request = (calls: any[]) =>
    dispatch(
      { using: caps, methodCalls: calls },
      { methods: mail.methods(), maxCallsInRequest: 20, sessionState: "s" },
    );
  const create = (extra: any = {}) => ({ ...draftInput(), ...extra });
  const save = async (extra: any = {}) => {
    const r = (await mail.methods()["Email/set"]!({
      accountId: mail.accountId,
      create: { d: create(extra) },
    })) as any;
    if (!r.created?.d) throw Error(JSON.stringify(r.notCreated));
    return r.created.d;
  };
  return { dir, store, mail, api, get, mutate, drafts, messages, request, save, create };
}
function draftInput() {
  return {
    from: [{ name: "Writer", email }],
    to: [{ email: "recipient@example.test" }],
    cc: [{ email: "copy@example.test" }],
    bcc: [{ email: "hidden@example.test" }],
    subject: "Compose test",
    mailboxIds: { l_DRAFT: true },
    keywords: { $seen: true, $draft: true },
    textBody: [{ partId: "t" }],
    bodyValues: { t: { value: "Hello è" } },
  };
}
it("builds MIME preserving text, HTML, Cc, Bcc and attachment bytes", async () => {
  const { mail, store, save, drafts } = await setup();
  const bytes = Buffer.from([0, 1, 2, 255]);
  const blob = await mail.upload(bytes, "application/octet-stream");
  await save({
    htmlBody: [{ partId: "h", type: "text/html" }],
    bodyValues: { t: { value: "Hello è" }, h: { value: "<b>Hello è</b>" } },
    attachments: [
      { blobId: blob, name: "file.bin", type: "application/octet-stream", disposition: "attachment" },
    ],
  });
  const d = [...drafts.values()][0];
  const raw = Buffer.from(d.message.raw, "base64url");
  const parsed = await simpleParser(raw);
  expect(parsed.text?.trim()).toBe("Hello è");
  expect(parsed.html).toContain("<b>Hello è</b>");
  expect((parsed.bcc as any).value[0].address).toBe("hidden@example.test");
  expect((parsed.cc as any).value[0].address).toBe("copy@example.test");
  expect(parsed.attachments[0]!.content).toEqual(bytes);
  expect(store.draft(email, d.message.id)?.draft).toBe(d.id);
});
it("saves a recipient-less draft and deletes it without allowing mail deletion", async () => {
  const { save, mail, messages, drafts } = await setup();
  const draft = await save({ to: [], cc: [], bcc: [] });
  expect(drafts.size).toBe(1);
  const r = (await mail.methods()["Email/set"]!({ accountId: mail.accountId, destroy: [draft.id] })) as any;
  expect(r.destroyed).toEqual([draft.id]);
  expect(drafts.size).toBe(0);
  messages.set("received", { id: "received", labelIds: ["INBOX"] });
  const refused = (await mail.methods()["Email/set"]!({
    accountId: mail.accountId,
    destroy: ["m_received"],
  })) as any;
  expect(refused.notDestroyed.m_received.type).toBe("forbidden");
});
it("keeps the old draft when its replacement references a missing attachment", async () => {
  const { save, mail, drafts } = await setup();
  await save();
  const r = (await mail.methods()["Email/set"]!({
    accountId: mail.accountId,
    create: {
      replacement: {
        ...draftInput(),
        attachments: [{ blobId: "gu_missing", type: "text/plain", name: "missing" }],
      },
    },
  })) as any;
  expect(r.notCreated.replacement.type).toBe("blobNotFound");
  expect(drafts.size).toBe(1);
});
it.each([
  { from: [{ email: "spoof@example.test" }] },
  { subject: "hello\r\nBcc: injected@example.test" },
  { bodyValues: { t: { value: 42 } } },
  { mailboxIds: { l_INBOX: true } },
])("rejects malformed or spoofed composition %j", async (extra) => {
  const { mail, mutate } = await setup();
  const r = (await mail.methods()["Email/set"]!({
    accountId: mail.accountId,
    create: { d: { ...draftInput(), ...extra } },
  })) as any;
  expect(r.notCreated.d.type).toBe("invalidProperties");
  expect(mutate).not.toHaveBeenCalled();
});
it("isolates uploaded blobs by account and expires them", async () => {
  const { mail, store } = await setup();
  const blob = await mail.upload(Buffer.from("secret"), "text/plain");
  expect(store.uploaded("other@example.test", blob)).toBeNull();
  expect((await mail.download(blob)).body.toString()).toBe("secret");
  const now = Date.now();
  const clock = vi.spyOn(Date, "now").mockReturnValue(now + 25 * 60 * 60_000);
  try {
    await expect(mail.download(blob)).rejects.toMatchObject({ type: "notFound" });
  } finally {
    clock.mockRestore();
  }
});
it("sends through the Bulwark creation-reference flow and keeps a stable email ID", async () => {
  const { mail, request, mutate, drafts } = await setup();
  const r = await request([
    ["Email/set", { accountId: mail.accountId, create: { draft: draftInput() } }, "0"],
    [
      "EmailSubmission/set",
      {
        accountId: mail.accountId,
        create: { send: { emailId: "#draft", identityId: "gi_" + mail.accountId } },
        onSuccessUpdateEmail: { "#send": { mailboxIds: { l_SENT: true }, "keywords/$draft": null } },
      },
      "1",
    ],
  ]);
  expect(r.methodResponses.map((x) => x[0])).toEqual(["Email/set", "EmailSubmission/set", "Email/set"]);
  const created = r.methodResponses[0]![1].created as any;
  const submission = (r.methodResponses[1]![1].created as any).send;
  expect(submission.emailId).toBe(created.draft.id);
  expect(submission.undoStatus).toBe("final");
  expect(submission.envelope.rcptTo).toHaveLength(3);
  expect(drafts.size).toBe(0);
  const got = (await mail.methods()["Email/get"]!({
    accountId: mail.accountId,
    ids: [created.draft.id],
    properties: ["id", "keywords"],
  })) as any;
  expect(got.list[0].id).toBe(created.draft.id);
  expect(got.list[0].keywords.$draft).toBeUndefined();
  const query = (await mail.methods()["Email/query"]!({ accountId: mail.accountId, limit: 10 })) as any;
  expect(query.ids).toEqual([created.draft.id]);
  expect(mutate.mock.calls.filter((c) => c[0] === "drafts/send")).toHaveLength(1);
});
it("does not send twice when the same draft is submitted again", async () => {
  const { save, mail, mutate } = await setup();
  const draft = await save();
  const args = {
    accountId: mail.accountId,
    create: { s: { emailId: draft.id, identityId: "gi_" + mail.accountId } },
  };
  const first = (await mail.methods()["EmailSubmission/set"]!(args)) as any;
  const second = (await mail.methods()["EmailSubmission/set"]!(args)) as any;
  expect(first.created.s.id).toBe(second.created.s.id);
  expect(mutate.mock.calls.filter((c) => c[0] === "drafts/send")).toHaveLength(1);
});
it("persists uncertain send intent across a restart and never replays it", async () => {
  const { save, mail, store, mutate, api } = await setup();
  const draft = await save();
  const implementation = mutate.getMockImplementation()!;
  mutate.mockImplementation(async (...args: any[]) => {
    if (args[0] === "drafts/send") throw new JmapError("serverFail", "Unknown outcome");
    return (implementation as any)(...args);
  });
  const args = {
    accountId: mail.accountId,
    create: { s: { emailId: draft.id, identityId: "gi_" + mail.accountId } },
  };
  const first = (await mail.methods()["EmailSubmission/set"]!(args)) as any;
  expect(first.notCreated.s.type).toBe("serverFail");
  const restarted = new GmailMail(email, api, store, true, true);
  const second = (await restarted.methods()["EmailSubmission/set"]!(args)) as any;
  expect(second.notCreated.s.description).toContain("uncertain");
  expect(mutate.mock.calls.filter((c) => c[0] === "drafts/send")).toHaveLength(1);
});
it("keeps a draft sendable when Google provably did not send it", async () => {
  const { save, mail, mutate } = await setup();
  const { GmailNotSent } = await import("../../src/gmail/api.js");
  const draft = await save();
  const implementation = mutate.getMockImplementation()!;
  let refuse = true;
  mutate.mockImplementation(async (...args: any[]) => {
    if (args[0] === "drafts/send" && refuse)
      throw new GmailNotSent("serverUnavailable", "Google authorization expired or was revoked.");
    return (implementation as any)(...args);
  });
  const args = {
    accountId: mail.accountId,
    create: { s: { emailId: draft.id, identityId: "gi_" + mail.accountId } },
  };
  const first = (await mail.methods()["EmailSubmission/set"]!(args)) as any;
  expect(first.notCreated.s.type).toBe("serverUnavailable");
  refuse = false;
  const second = (await mail.methods()["EmailSubmission/set"]!(args)) as any;
  expect(second.created.s.undoStatus).toBe("final");
  expect(mutate.mock.calls.filter((c) => c[0] === "drafts/send")).toHaveLength(2);
});
it("forgets the id mapping of a discarded draft", async () => {
  const { save, mail, store } = await setup();
  const draft = await save();
  expect(store.draft(email, draft.id.slice(2))).not.toBeNull();
  await mail.methods()["Email/set"]!({ accountId: mail.accountId, destroy: [draft.id] });
  expect(store.draft(email, draft.id.slice(2))).toBeNull();
});
it("lets the client discard a draft whose send outcome is uncertain", async () => {
  const { save, mail, mutate, drafts } = await setup();
  const draft = await save();
  const implementation = mutate.getMockImplementation()!;
  mutate.mockImplementation(async (...args: any[]) => {
    if (args[0] === "drafts/send") throw new JmapError("serverFail", "Unknown outcome");
    return (implementation as any)(...args);
  });
  await mail.methods()["EmailSubmission/set"]!({
    accountId: mail.accountId,
    create: { s: { emailId: draft.id, identityId: "gi_" + mail.accountId } },
  });
  const r = (await mail.methods()["Email/set"]!({ accountId: mail.accountId, destroy: [draft.id] })) as any;
  expect(r.destroyed).toEqual([draft.id]);
  expect(drafts.size).toBe(0);
});
it("rejects foreign identity, different SMTP envelope and delayed-send parameters before sending", async () => {
  const { save, mail, mutate } = await setup();
  const draft = await save();
  for (const extra of [
    { identityId: "other" },
    { envelope: { mailFrom: { email }, rcptTo: [{ email: "different@example.test" }] } },
    { envelope: { mailFrom: { email, parameters: { HOLDFOR: "10" } }, rcptTo: [] } },
  ]) {
    const r = (await mail.methods()["EmailSubmission/set"]!({
      accountId: mail.accountId,
      create: { s: { emailId: draft.id, identityId: "gi_" + mail.accountId, ...extra } },
    })) as any;
    expect(r.notCreated.s.type).toBe("invalidProperties");
  }
  expect(mutate.mock.calls.some((c) => c[0] === "drafts/send")).toBe(false);
});
it("imports an uploaded MIME draft and resolves its creation reference for submission", async () => {
  const { mail, request } = await setup();
  const raw = Buffer.from(
    "From: writer@example.test\r\nTo: recipient@example.test\r\nSubject: Import\r\n\r\nBody\r\n",
  );
  const blob = await mail.upload(raw, "message/rfc822");
  const r = await request([
    [
      "Email/import",
      {
        accountId: mail.accountId,
        emails: { d: { blobId: blob, mailboxIds: { l_DRAFT: true }, keywords: { $draft: true } } },
      },
      "0",
    ],
    [
      "EmailSubmission/set",
      { accountId: mail.accountId, create: { s: { emailId: "#d", identityId: "gi_" + mail.accountId } } },
      "1",
    ],
  ]);
  expect((r.methodResponses[1]![1].created as any).s).toBeTruthy();
});
it("preserves exact JSON upload bytes through Fastify and requires authentication", async () => {
  const { store, mail } = await setup();
  const password = store.issuePassword(email);
  const app = Fastify();
  registerGmailBackend(
    app,
    { publicUrl: "https://bridge.test", limits: { maxCallsInRequest: 20 } } as any,
    { allowedEmails: new Set([email]), writeEnabled: true, composeEnabled: true } as any,
    store,
    {} as any,
    () => mail,
  );
  app.addContentTypeParser("*", { parseAs: "buffer" }, (_r, b, done) => done(null, b));
  app.post("/jmap/upload/:accountId", async () => ({ legacy: true }));
  app.get("/jmap/session", async () => ({ legacy: true }));
  try {
    const bytes = '{ "x": 1 }\n';
    const headers = { authorization: "Bearer " + password, "content-type": "application/json" };
    const response = await app.inject({
      method: "POST",
      url: "/jmap/upload/" + mail.accountId,
      headers,
      payload: bytes,
    });
    expect(response.statusCode).toBe(200);
    expect(store.uploaded(email, response.json().blobId)!.body.toString()).toBe(bytes);
    const session = (await app.inject({ url: "/jmap/session", headers })).json();
    expect(session.capabilities[SUBMISSION_CAPABILITY].maxDelayedSend).toBe(0);
    const foreign = await app.inject({
      method: "POST",
      url: "/jmap/upload/foreign",
      headers,
      payload: bytes,
    });
    expect(foreign.statusCode).toBe(404);
  } finally {
    await app.close();
  }
});

it("does not send an empty draft and detects edits made outside the bridge", async () => {
  const { save, mail, drafts, mutate } = await setup();
  const saved = await save({ to: [], cc: [], bcc: [] });
  const args = {
    accountId: mail.accountId,
    create: { s: { emailId: saved.id, identityId: "gi_" + mail.accountId } },
  };
  let r = (await mail.methods()["EmailSubmission/set"]!(args)) as any;
  expect(r.notCreated.s.type).toBe("noRecipients");
  const d = [...drafts.values()][0];
  d.message.id = "changedExternally";
  r = (await mail.methods()["EmailSubmission/set"]!(args)) as any;
  expect(r.notCreated.s.type).toBe("notFound");
  expect(mutate.mock.calls.some((c) => c[0] === "drafts/send")).toBe(false);
});
it("allows only native draft routes when composition is enabled at the gateway", async () => {
  const { store } = await setup();
  const { GmailApi } = await import("../../src/gmail/api.js");
  const request = vi.fn(async () => ({ data: { id: "fake", message: { id: "m", threadId: "t" } } }));
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
    { config: { writeEnabled: true, composeEnabled: true }, createClient: () => client } as any,
    store,
  );
  await api.mutate("drafts", 10, "POST", { message: { raw: "test" } });
  expect(request).toHaveBeenCalledTimes(1);
  await expect(api.mutate("messages/a", 10, "DELETE")).rejects.toMatchObject({ type: "forbidden" });
  await expect(api.mutate("messages/send", 100, "POST", {})).rejects.toMatchObject({ type: "forbidden" });
  const disabled = new GmailApi(
    email,
    { config: { writeEnabled: true }, createClient: () => client } as any,
    store,
  );
  await expect(disabled.mutate("drafts/send", 100, "POST", { id: "fake" })).rejects.toMatchObject({
    type: "forbidden",
  });
});
it("attaches replies to the original Gmail thread after verifying Message-ID and subject", async () => {
  const { mail, get, mutate, save } = await setup();
  const implementation = get.getMockImplementation()!;
  get.mockImplementation(async (resource: string, cost: number, params: any = {}) => {
    if (resource === "messages") return { messages: [{ id: "parent", threadId: "original-thread" }] };
    if (resource === "messages/parent")
      return {
        id: "parent",
        threadId: "original-thread",
        payload: {
          headers: [
            { name: "Message-ID", value: "<parent@example.test>" },
            { name: "Subject", value: "Original" },
          ],
        },
      };
    return implementation(resource, cost, params);
  });
  await save({
    subject: "Re: Original",
    inReplyTo: ["parent@example.test"],
    references: ["parent@example.test"],
  });
  expect(mutate.mock.calls.find((c) => c[0] === "drafts")?.[3].message.threadId).toBe("original-thread");
  mutate.mockClear();
  await save({ subject: "Changed subject", inReplyTo: ["parent@example.test"] });
  expect(mutate.mock.calls.find((c) => c[0] === "drafts")?.[3].message.threadId).toBeUndefined();
});

it("imports foreign mail into a writable mailbox through messages.import, mapping keywords to labels", async () => {
  const { mail, request, mutate, messages, get } = await setup();
  const raw = Buffer.from(
    "From: someone-else@example.test\r\nTo: writer@example.test\r\nDate: Mon, 01 Sep 2026 10:00:00 +0000\r\nSubject: Moved\r\n\r\nBody\r\n",
  );
  const blob = await mail.upload(raw, "message/rfc822");
  const r = await request([
    [
      "Email/import",
      {
        accountId: mail.accountId,
        emails: {
          m: {
            blobId: blob,
            mailboxIds: { l_INBOX: true },
            keywords: { $flagged: true, $answered: true },
            receivedAt: "2026-09-01T10:00:00Z",
          },
        },
      },
      "0",
    ],
  ]);
  const created = (r.methodResponses[0]![1].created as any).m;
  expect(created).toMatchObject({
    id: "m_imsg1",
    threadId: "t_ithread1",
    size: 800,
    mailboxIds: { all: true, l_INBOX: true },
    keywords: { $flagged: true },
  });
  const call = mutate.mock.calls.find((c) => c[0] === "messages/import")!;
  expect(call[2]).toBe("POST");
  expect(call[3]).toEqual({ raw: raw.toString("base64url"), labelIds: ["INBOX", "UNREAD", "STARRED"] });
  expect(call[4]).toEqual({ internalDateSource: "dateHeader", neverMarkSpam: "true" });
  expect(messages.get("imsg1").labelIds).toEqual(["INBOX", "UNREAD", "STARRED"]);
  expect(get.mock.calls.some((c) => c[0] === "messages/imsg1" && c[2]?.format === "minimal")).toBe(true);
  expect(mutate.mock.calls.some((c) => c[0] === "drafts")).toBe(false);
});
it("imports seen mail into All mail alone as an archived message with no labels", async () => {
  const { mail, request, mutate } = await setup();
  const raw = Buffer.from("From: a@example.test\r\nTo: writer@example.test\r\nSubject: Old\r\n\r\nBody\r\n");
  const blob = await mail.upload(raw, "message/rfc822");
  const r = await request([
    [
      "Email/import",
      { accountId: mail.accountId, emails: { m: { blobId: blob, mailboxIds: { all: true }, keywords: { $seen: true } } } },
      "0",
    ],
  ]);
  expect((r.methodResponses[0]![1].created as any).m.keywords).toEqual({ $seen: true });
  expect(mutate.mock.calls.find((c) => c[0] === "messages/import")![3].labelIds).toEqual([]);
});
it("refuses imports into read-only mailboxes, unknown mailboxes and drafts outside the Drafts mailbox", async () => {
  const { mail, request, mutate } = await setup();
  const raw = Buffer.from("From: a@example.test\r\nTo: writer@example.test\r\nSubject: X\r\n\r\nBody\r\n");
  const blob = await mail.upload(raw, "message/rfc822");
  const r = await request([
    [
      "Email/import",
      {
        accountId: mail.accountId,
        emails: {
          sent: { blobId: blob, mailboxIds: { l_SENT: true } },
          unknown: { blobId: blob, mailboxIds: { l_NOPE: true } },
          draft: { blobId: blob, mailboxIds: { l_INBOX: true }, keywords: { $draft: true } },
          mixed: { blobId: blob, mailboxIds: { l_DRAFT: true, l_INBOX: true }, keywords: { $draft: true } },
        },
      },
      "0",
    ],
  ]);
  const notCreated = r.methodResponses[0]![1].notCreated as any;
  expect(r.methodResponses[0]![1].created).toBeNull();
  expect(notCreated.sent.description).toBe("Mailbox is read-only");
  expect(notCreated.unknown.description).toBe("Unknown mailbox");
  expect(notCreated.draft.description).toMatch(/Drafts mailbox/);
  expect(notCreated.mixed.description).toBe("New mail must be a draft");
  expect(mutate.mock.calls.some((c) => c[0] === "messages/import")).toBe(false);
});
