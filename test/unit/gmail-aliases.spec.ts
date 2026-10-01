import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { simpleParser } from "mailparser";
import { afterEach, it, expect, vi } from "vitest";
import { GmailStore } from "../../src/gmail/store.js";
import { GmailMail } from "../../src/gmail/mail.js";
import { GMAIL_MODIFY } from "../../src/gmail/config.js";
import { JmapError } from "../../src/jmap/errors.js";
const email = "owner@example.test";
const alias = "sales@example.test";
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
function settings() {
  return [
    {
      sendAsEmail: "Owner@Example.test",
      displayName: "Owner Name",
      replyToAddress: "replies@example.test",
      isPrimary: true,
    },
    { sendAsEmail: alias, displayName: "Sales Desk", verificationStatus: "accepted", treatAsAlias: true },
    { sendAsEmail: "pending@example.test", displayName: "Pending", verificationStatus: "pending" },
    { sendAsEmail: "bad address", verificationStatus: "accepted" },
    { sendAsEmail: alias.toUpperCase(), displayName: "Duplicate", verificationStatus: "accepted" },
  ];
}
async function setup(aliases = true) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gmail-alias-"));
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
  const state = { sendAs: settings() as any[] | Error };
  const get = vi.fn(async (resource: string) => {
    if (resource === "profile") return { ...profile, messagesTotal: messages.size };
    if (resource === "labels") return { labels };
    if (resource === "settings/sendAs") {
      if (state.sendAs instanceof Error) throw state.sendAs;
      return { sendAs: structuredClone(state.sendAs) };
    }
    if (resource === "drafts") return { drafts: [...drafts.values()] };
    if (resource.startsWith("drafts/")) {
      const d = drafts.get(resource.slice(7));
      if (!d) throw new JmapError("notFound");
      return structuredClone(d);
    }
    if (resource === "messages") return { messages: [] };
    if (resource.startsWith("messages/")) {
      const m = messages.get(resource.slice(9));
      if (!m) throw new JmapError("notFound");
      return structuredClone(m);
    }
    throw Error("Unexpected fixture resource " + resource);
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
    throw Error("Unexpected fixture mutation");
  });
  const mail = new GmailMail(email, { get, mutate } as any, store, true, true, aliases);
  const identities = async () =>
    (await mail.methods()["Identity/get"]!({ accountId: mail.accountId })) as any;
  const save = async (from: string, extra: any = {}) =>
    mail.methods()["Email/set"]!({
      accountId: mail.accountId,
      create: {
        d: {
          from: [{ email: from }],
          to: [{ email: "recipient@example.test" }],
          subject: "Alias test",
          mailboxIds: { l_DRAFT: true },
          keywords: { $draft: true },
          textBody: [{ partId: "t" }],
          bodyValues: { t: { value: "Hi" } },
          ...extra,
        },
      },
    }) as Promise<any>;
  const send = async (emailId: string, identityId: string, extra: any = {}) =>
    mail.methods()["EmailSubmission/set"]!({
      accountId: mail.accountId,
      create: { s: { emailId, identityId, ...extra } },
    }) as Promise<any>;
  return { mail, store, get, mutate, drafts, state, identities, save, send };
}
it("lists the primary address and verified aliases as identities with stable ids", async () => {
  const { mail, identities, get } = await setup();
  const r = await identities();
  expect(r.list.map((i: any) => i.email)).toEqual([email, alias]);
  expect(r.list[0]).toMatchObject({
    id: "gi_" + mail.accountId,
    name: "Owner Name",
    replyTo: [{ email: "replies@example.test" }],
    mayDelete: false,
    textSignature: "",
    htmlSignature: "",
  });
  expect(r.list[1]).toMatchObject({ name: "Sales Desk", replyTo: null });
  expect(r.list[1].id).toMatch(new RegExp("^gi_" + mail.accountId + "_[0-9a-f]{16}$"));
  const again = await identities();
  expect(again.list[1].id).toBe(r.list[1].id);
  expect(again.state).toBe(r.state);
  expect(get.mock.calls.filter((c) => c[0] === "settings/sendAs")).toHaveLength(1);
  const some = (await mail.methods()["Identity/get"]!({
    accountId: mail.accountId,
    ids: [r.list[1].id, "missing"],
  })) as any;
  expect(some.list.map((i: any) => i.id)).toEqual([r.list[1].id]);
  expect(some.notFound).toEqual(["missing"]);
});
it("keeps the single identity when aliases are disabled and never reads settings", async () => {
  const { mail, identities, get } = await setup(false);
  const r = await identities();
  expect(r.list).toHaveLength(1);
  expect(r.list[0]).toMatchObject({ id: "gi_" + mail.accountId, name: email, email, replyTo: null });
  expect(get.mock.calls.some((c) => c[0] === "settings/sendAs")).toBe(false);
  const refused = await (mail.methods()["Email/set"]!({
    accountId: mail.accountId,
    create: {
      d: {
        from: [{ email: alias }],
        to: [],
        subject: "x",
        mailboxIds: { l_DRAFT: true },
        keywords: { $draft: true },
        textBody: [{ partId: "t" }],
        bodyValues: { t: { value: "" } },
      },
    },
  }) as Promise<any>);
  expect(refused.notCreated.d.type).toBe("invalidProperties");
});
it("falls back to the primary identity when Gmail settings are unavailable", async () => {
  const { mail, identities, state } = await setup();
  state.sendAs = new JmapError("serverUnavailable");
  const r = await identities();
  expect(r.list.map((i: any) => i.email)).toEqual([email]);
  const saved = (await mail.methods()["Email/set"]!({
    accountId: mail.accountId,
    create: {
      d: {
        from: [{ email }],
        to: [],
        subject: "x",
        mailboxIds: { l_DRAFT: true },
        keywords: { $draft: true },
        textBody: [{ partId: "t" }],
        bodyValues: { t: { value: "" } },
      },
    },
  })) as any;
  expect(saved.created.d).toBeTruthy();
});
it("accepts drafts from a verified alias and refuses pending or unknown senders", async () => {
  const { save, drafts } = await setup();
  const ok = await save("Sales@example.test", { sender: [{ email: alias }] });
  expect(ok.created.d).toBeTruthy();
  const raw = Buffer.from([...drafts.values()][0].message.raw, "base64url");
  const parsed = await simpleParser(raw);
  expect((parsed.from as any).value[0].address).toBe("Sales@example.test");
  for (const from of ["pending@example.test", "stranger@example.test"])
    expect((await save(from)).notCreated.d.type).toBe("invalidProperties");
  const mismatch = await save(alias, { sender: [{ email }] });
  expect(mismatch.notCreated.d.type).toBe("invalidProperties");
});
it("sends from an alias with a matching envelope and re-validates the identity against Gmail", async () => {
  const { identities, save, send, get, drafts, mutate } = await setup();
  const aliasId = (await identities()).list[1].id;
  const draft = (await save(alias)).created.d;
  const before = get.mock.calls.filter((c) => c[0] === "settings/sendAs").length;
  const r = await send(draft.id, aliasId, {
    envelope: { mailFrom: { email: alias.toUpperCase() }, rcptTo: [{ email: "recipient@example.test" }] },
  });
  expect(r.created.s.envelope.mailFrom).toEqual({ email: alias });
  expect(r.created.s.identityId).toBe(aliasId);
  expect(get.mock.calls.filter((c) => c[0] === "settings/sendAs").length).toBe(before + 1);
  expect(mutate.mock.calls.some((c) => c[0] === "drafts/send")).toBe(true);
  expect(drafts.size).toBe(0);
});
it("refuses to send when the draft From does not match the chosen identity", async () => {
  const { mail, identities, save, send, drafts, mutate } = await setup();
  const aliasId = (await identities()).list[1].id;
  const draft = (await save(email)).created.d;
  const r = await send(draft.id, aliasId);
  expect(r.notCreated.s.type).toBe("invalidEmail");
  const wrongEnvelope = await send(draft.id, "gi_" + mail.accountId, {
    envelope: { mailFrom: { email: alias }, rcptTo: [{ email: "recipient@example.test" }] },
  });
  expect(wrongEnvelope.notCreated.s.type).toBe("invalidProperties");
  expect(mutate.mock.calls.some((c) => c[0] === "drafts/send")).toBe(false);
  expect(drafts.size).toBe(1);
});
it("keeps the draft and reports forbiddenFrom when the alias was removed in Gmail meanwhile", async () => {
  const { identities, save, send, state, drafts, mutate, store } = await setup();
  const aliasId = (await identities()).list[1].id;
  const draft = (await save(alias)).created.d;
  state.sendAs = settings().filter((s) => s.sendAsEmail.toLowerCase() !== alias);
  const r = await send(draft.id, aliasId);
  expect(r.notCreated.s.type).toBe("forbiddenFrom");
  expect(r.notCreated.s.description).toContain("retained");
  expect(mutate.mock.calls.some((c) => c[0] === "drafts/send")).toBe(false);
  expect(drafts.size).toBe(1);
  expect(store.submission(email, draft.id.slice(2))).toBeFalsy();
  state.sendAs = new Error("network");
  const outage = await send(draft.id, aliasId);
  expect(outage.notCreated.s.type).toBe("serverUnavailable");
  expect(drafts.size).toBe(1);
  state.sendAs = settings();
  const later = await send(draft.id, aliasId);
  expect(later.created.s).toBeTruthy();
});
it("imports MIME whose From is a verified alias", async () => {
  const { mail, drafts } = await setup();
  const mime = Buffer.from(
    `From: Sales <${alias}>\r\nTo: recipient@example.test\r\nSubject: import\r\nMIME-Version: 1.0\r\nContent-Type: text/plain\r\n\r\nHello\r\n`,
  );
  const blob = await mail.upload(mime, "message/rfc822");
  const r = (await mail.methods()["Email/import"]!({
    accountId: mail.accountId,
    emails: { d: { blobId: blob, mailboxIds: { l_DRAFT: true }, keywords: { $draft: true } } },
  })) as any;
  expect(r.created.d).toBeTruthy();
  expect(drafts.size).toBe(1);
  const other = Buffer.from(
    `From: pending@example.test\r\nTo: recipient@example.test\r\nSubject: import\r\n\r\nHello\r\n`,
  );
  const refused = (await mail.methods()["Email/import"]!({
    accountId: mail.accountId,
    emails: {
      d: {
        blobId: await mail.upload(other, "message/rfc822"),
        mailboxIds: { l_DRAFT: true },
        keywords: { $draft: true },
      },
    },
  })) as any;
  expect(refused.notCreated.d.type).toBe("invalidEmail");
});
