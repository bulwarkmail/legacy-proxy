import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import Fastify from "fastify";
import { afterEach, it, expect, vi } from "vitest";
import { GmailStore } from "../../src/gmail/store.js";
import { GmailMail } from "../../src/gmail/mail.js";
import { GMAIL_MODIFY } from "../../src/gmail/config.js";
import { JmapError } from "../../src/jmap/errors.js";
import { dispatch } from "../../src/jmap/router.js";
import { registerGmailBackend } from "../../src/gmail/backend.js";
import { CORE_CAPABILITY, MAIL_CAPABILITY, SUBMISSION_CAPABILITY } from "../../src/jmap/capabilities.js";
const email = "planner@example.test";
const caps = [CORE_CAPABILITY, MAIL_CAPABILITY, SUBMISSION_CAPABILITY];
const profile = { emailAddress: email, historyId: "1", messagesTotal: 0, threadsTotal: 0 };
const labels = ["INBOX", "SENT", "DRAFT"].map((id) => ({
  id,
  name: id,
  type: "system",
  messagesTotal: 0,
  messagesUnread: 0,
}));
const SCHEDULE = { maxDelayedSend: 7 * 86400, lateTolerance: 900 };
const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const f of cleanup.splice(0)) f();
});
async function setup(schedule: { maxDelayedSend: number; lateTolerance: number } | null = SCHEDULE) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gmail-schedule-"));
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
  const state = {
    sendAs: [
      { sendAsEmail: email, isPrimary: true },
      { sendAsEmail: "alias@example.test", verificationStatus: "accepted" },
    ] as any[] | Error,
    sendError: null as Error | null,
  };
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
      if (state.sendError) throw state.sendError;
      const d = drafts.get(data.id);
      if (!d) throw new JmapError("notFound");
      const m = { ...d.message, id: "sent" + next, labelIds: ["SENT"] };
      messages.delete(d.message.id);
      messages.set(m.id, m);
      drafts.delete(d.id);
      return structuredClone(m);
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
  const make = () => new GmailMail(email, api, store, true, true, true, schedule ?? undefined);
  const mail = make();
  const request = (calls: any[]) =>
    dispatch(
      { using: caps, methodCalls: calls },
      { methods: mail.methods(), maxCallsInRequest: 20, sessionState: "s" },
    );
  const save = async (from = email) => {
    const r = (await mail.methods()["Email/set"]!({
      accountId: mail.accountId,
      create: {
        d: {
          from: [{ email: from }],
          to: [{ email: "recipient@example.test" }],
          subject: "Scheduled",
          mailboxIds: { l_DRAFT: true },
          keywords: { $draft: true },
          textBody: [{ partId: "t" }],
          bodyValues: { t: { value: "Later" } },
        },
      },
    })) as any;
    if (!r.created?.d) throw Error(JSON.stringify(r.notCreated));
    return r.created.d;
  };
  const identity = "gi_" + mail.accountId;
  const submit = (emailId: string, params: Record<string, string> | null, extra: any = {}) =>
    mail.methods()["EmailSubmission/set"]!({
      accountId: mail.accountId,
      create: {
        s: {
          emailId,
          identityId: identity,
          ...(params
            ? {
                envelope: {
                  mailFrom: { email, parameters: params },
                  rcptTo: [{ email: "recipient@example.test" }],
                },
              }
            : {}),
        },
      },
      ...extra,
    }) as Promise<any>;
  const getSub = async (id: string) =>
    ((await mail.methods()["EmailSubmission/get"]!({ accountId: mail.accountId, ids: [id] })) as any).list[0];
  const cancel = (id: string) =>
    mail.methods()["EmailSubmission/set"]!({
      accountId: mail.accountId,
      update: { [id]: { undoStatus: "canceled" } },
    }) as Promise<any>;
  const sends = () => mutate.mock.calls.filter((c) => c[0] === "drafts/send").length;
  return {
    dir,
    store,
    mail,
    make,
    api,
    get,
    mutate,
    drafts,
    messages,
    state,
    request,
    save,
    submit,
    getSub,
    cancel,
    sends,
    identity,
  };
}
it("advertises FUTURERELEASE and maxDelayedSend only when scheduling is enabled", async () => {
  for (const [schedule, expectedMax, sessionState] of [
    [SCHEDULE, SCHEDULE.maxDelayedSend, "gmail-schedule-v1"],
    [null, 0, "gmail-compose-v1"],
  ] as const) {
    const { store, mail } = await setup(schedule);
    const app = Fastify();
    cleanup.push(() => {
      void app.close();
    });
    registerGmailBackend(
      app,
      { publicUrl: "https://bridge.test", limits: { maxCallsInRequest: 20 } } as any,
      {
        allowedEmails: new Set([email]),
        writeEnabled: true,
        composeEnabled: true,
        ...(schedule ? { schedule } : {}),
      } as any,
      store,
      {} as any,
      () => mail,
    );
    const password = store.issuePassword(email);
    const res = await app.inject({
      method: "GET",
      url: "/jmap/session",
      headers: { authorization: "Basic " + Buffer.from(email + ":" + password).toString("base64") },
    });
    const session = res.json();
    const props = session.capabilities[SUBMISSION_CAPABILITY];
    expect(props.maxDelayedSend).toBe(expectedMax);
    expect(session.state).toBe(sessionState);
    if (schedule) expect(props.submissionExtensions.FUTURERELEASE).toEqual(["HOLDFOR", "HOLDUNTIL"]);
    else expect(props.submissionExtensions).toEqual({});
  }
});
it("queues a HOLDFOR submission without contacting Google and keeps the draft", async () => {
  const { save, submit, sends, drafts, getSub, request, mail, identity } = await setup();
  const draft = await save();
  const before = Date.now();
  const r = await submit(draft.id, { HOLDFOR: "3600" });
  const s = r.created.s;
  expect(s.id).toMatch(/^gq_/);
  expect(s.undoStatus).toBe("pending");
  expect(s.emailId).toBe(draft.id);
  expect(s.threadId).toBe(draft.threadId);
  expect(Date.parse(s.sendAt)).toBeGreaterThanOrEqual(before + 3600_000);
  expect(Date.parse(s.sendAt)).toBeLessThan(before + 3601_000);
  expect(sends()).toBe(0);
  expect(drafts.size).toBe(1);
  expect((await getSub(s.id)).undoStatus).toBe("pending");
  // Filing patches cannot apply yet: Gmail moves the draft to Sent when it is actually sent.
  const with_patch = (
    (await request([
      [
        "EmailSubmission/set",
        {
          accountId: mail.accountId,
          create: {
            s: {
              emailId: draft.id,
              identityId: identity,
              envelope: {
                mailFrom: { email, parameters: { HOLDFOR: "60" } },
                rcptTo: [{ email: "recipient@example.test" }],
              },
            },
          },
          onSuccessUpdateEmail: { "#s": { mailboxIds: { l_SENT: true }, "keywords/$draft": null } },
        },
        "1",
      ],
    ])) as any
  ).methodResponses;
  expect(with_patch[0][1].created.s.undoStatus).toBe("pending");
  expect(with_patch[1][0]).toBe("Email/set");
  expect(with_patch[1][1].notUpdated[draft.id].type).toBe("forbidden");
});
it("accepts HOLDUNTIL and rejects invalid, excessive or disabled holds", async () => {
  const { save, submit } = await setup();
  const draft = await save();
  const until = await submit(draft.id, { HOLDUNTIL: new Date(Date.now() + 120_000).toISOString() });
  expect(until.created.s.undoStatus).toBe("pending");
  for (const params of [
    { HOLDFOR: "-5" },
    { HOLDFOR: "abc" },
    { HOLDFOR: String(SCHEDULE.maxDelayedSend + 1) },
    { HOLDFOR: "10", HOLDUNTIL: "2030-01-01T00:00:00Z" },
    { HOLDUNTIL: "never" },
  ]) {
    const r = await submit(draft.id, params);
    expect(r.notCreated?.s?.type, JSON.stringify(params) + JSON.stringify(r)).toBe("invalidProperties");
  }
  const off = await setup(null);
  const d2 = await off.save();
  const r = await off.submit(d2.id, { HOLDFOR: "10" });
  expect(r.notCreated.s.type).toBe("invalidProperties");
  expect(r.notCreated.s.description).toContain("not enabled");
});
it("lists, cancels and refuses to cancel twice", async () => {
  const { save, submit, cancel, getSub, mail, drafts, sends } = await setup();
  const draft = await save();
  const s = (await submit(draft.id, { HOLDFOR: "30" })).created.s;
  const q = (await mail.methods()["EmailSubmission/query"]!({
    accountId: mail.accountId,
    position: 0,
    limit: 10,
  })) as any;
  expect(q.ids).toEqual([s.id]);
  expect(q.total).toBe(1);
  const c = await cancel(s.id);
  expect(c.updated).toEqual({ [s.id]: null });
  expect((await getSub(s.id)).undoStatus).toBe("canceled");
  expect(drafts.size).toBe(1);
  const again = await cancel(s.id);
  expect(again.notUpdated[s.id].type).toBe("cannotUnsend");
  const unknown = await cancel("gq_missing");
  expect(unknown.notUpdated.gq_missing.type).toBe("notFound");
  await mail.runScheduled(Date.now() + 60_000);
  expect(sends()).toBe(0);
  // Immediate sends are untouched by the queue.
  const now = await submit(draft.id, null);
  expect(now.created.s.undoStatus).toBe("final");
  expect(sends()).toBe(1);
});
it("sends a due entry once, files it as final and blocks a later immediate resend", async () => {
  const { save, submit, getSub, mail, sends, drafts, store, get } = await setup();
  const draft = await save();
  const s = (await submit(draft.id, { HOLDFOR: "10" })).created.s;
  await mail.runScheduled(Date.now());
  expect(sends()).toBe(0);
  const settingsReads = get.mock.calls.filter((c) => c[0] === "settings/sendAs").length;
  await mail.runScheduled(Date.now() + 11_000);
  expect(sends()).toBe(1);
  expect(drafts.size).toBe(0);
  expect(get.mock.calls.filter((c) => c[0] === "settings/sendAs").length).toBe(settingsReads + 1);
  const sent = await getSub(s.id);
  expect(sent.undoStatus).toBe("final");
  expect(sent.deliveryStatus).toBeNull();
  expect(sent.threadId).toBe(draft.threadId);
  expect(store.submission(email, draft.id.slice(2))?.result).toBeTruthy();
  const all = (await mail.methods()["EmailSubmission/get"]!({ accountId: mail.accountId })) as any;
  expect(all.list.map((x: any) => x.id)).toEqual([s.id]);
  expect(all.list[0].fingerprint).toBeUndefined();
  await mail.runScheduled(Date.now() + 20_000);
  expect(sends()).toBe(1);
  const resend = await submit(draft.id, null);
  expect(resend.notCreated.s.type).toBe("invalidProperties");
});
it("suspends instead of sending when the draft changed, vanished, or the identity is gone", async () => {
  const { save, submit, getSub, mail, sends, drafts, state, cancel } = await setup();
  const a = await save();
  const sa = (await submit(a.id, { HOLDFOR: "1" })).created.s;
  for (const d of drafts.values())
    if (d.message.id === a.id.slice(2))
      d.message.raw = Buffer.from(
        "From: " + email + "\r\nTo: recipient@example.test\r\nSubject: edited\r\n\r\nChanged",
      ).toString("base64url");
  const b = await save();
  const sb = (await submit(b.id, { HOLDFOR: "1" })).created.s;
  for (const [k, d] of drafts) if (d.message.id === b.id.slice(2)) drafts.delete(k);
  const c = await save("alias@example.test");
  const idAlias = ((await mail.methods()["Identity/get"]!({ accountId: mail.accountId })) as any).list[1].id;
  const sc = (
    (await mail.methods()["EmailSubmission/set"]!({
      accountId: mail.accountId,
      create: {
        s: {
          emailId: c.id,
          identityId: idAlias,
          envelope: {
            mailFrom: { email: "alias@example.test", parameters: { HOLDFOR: "1" } },
            rcptTo: [{ email: "recipient@example.test" }],
          },
        },
      },
    })) as any
  ).created.s;
  state.sendAs = [{ sendAsEmail: email, isPrimary: true }];
  await mail.runScheduled(Date.now() + 5_000);
  expect(sends()).toBe(0);
  for (const [id, reason] of [
    [sa.id, "edited"],
    [sb.id, "deleted"],
    [sc.id, "identity"],
  ]) {
    const s = await getSub(id);
    expect(s.undoStatus).toBe("final");
    expect(s.deliveryStatus["recipient@example.test"].delivered).toBe("no");
    expect(s.deliveryStatus["recipient@example.test"].smtpReply).toContain(reason);
  }
  expect((await cancel(sa.id)).notUpdated[sa.id].type).toBe("cannotUnsend");
});
it("retries after transient settings errors and suspends entries that are too late", async () => {
  const { save, submit, getSub, mail, sends, state } = await setup();
  const draft = await save();
  const s = (await submit(draft.id, { HOLDFOR: "1" })).created.s;
  state.sendAs = new JmapError("serverUnavailable");
  await mail.runScheduled(Date.now() + 2_000);
  expect(sends()).toBe(0);
  expect((await getSub(s.id)).undoStatus).toBe("pending");
  state.sendAs = [{ sendAsEmail: email, isPrimary: true }];
  await mail.runScheduled(Date.now() + 3_000);
  expect(sends()).toBe(1);
  expect((await getSub(s.id)).undoStatus).toBe("final");
  const late = await save();
  const sl = (await submit(late.id, { HOLDFOR: "1" })).created.s;
  await mail.runScheduled(Date.now() + SCHEDULE.lateTolerance * 1000 + 5_000);
  expect(sends()).toBe(1);
  const r = await getSub(sl.id);
  expect(r.undoStatus).toBe("final");
  expect(r.deliveryStatus["recipient@example.test"].smtpReply).toContain("unavailable at the scheduled time");
});
it("marks an unconfirmed Google send as uncertain and never replays it", async () => {
  const { save, submit, getSub, mail, sends, state, store } = await setup();
  const draft = await save();
  const s = (await submit(draft.id, { HOLDFOR: "1" })).created.s;
  state.sendError = new Error("socket hang up");
  await mail.runScheduled(Date.now() + 2_000);
  expect(sends()).toBe(1);
  const r = await getSub(s.id);
  expect(r.undoStatus).toBe("final");
  expect(r.deliveryStatus["recipient@example.test"].delivered).toBe("unknown");
  state.sendError = null;
  await mail.runScheduled(Date.now() + 10_000);
  expect(sends()).toBe(1);
  expect(store.submission(email, draft.id.slice(2))?.result).toBeNull();
  const again = await submit(draft.id, null);
  expect(again.notCreated.s.description).toContain("uncertain");
});
it("retries a scheduled send Google never received and suspends one Google refused", async () => {
  const { save, submit, getSub, mail, sends, state, store } = await setup();
  const { GmailNotSent } = await import("../../src/gmail/api.js");
  const draft = await save();
  const s = (await submit(draft.id, { HOLDFOR: "1" })).created.s;
  state.sendError = new GmailNotSent("serverUnavailable", "Google authorization expired or was revoked.");
  await mail.runScheduled(Date.now() + 2_000);
  expect((await getSub(s.id)).undoStatus).toBe("pending");
  expect(store.submission(email, draft.id.slice(2))).toBeNull();
  state.sendError = null;
  await mail.runScheduled(Date.now() + 3_000);
  expect((await getSub(s.id)).undoStatus).toBe("final");
  expect(sends()).toBe(2);
  const other = await save();
  const o = (await submit(other.id, { HOLDFOR: "1" })).created.s;
  state.sendError = new GmailNotSent("invalidProperties", "Google rejected the update");
  await mail.runScheduled(Date.now() + 2_000);
  expect((await getSub(o.id)).deliveryStatus["recipient@example.test"].delivered).toBe("no");
  state.sendError = null;
  expect((await submit(other.id, null)).created.s.undoStatus).toBe("final");
});
it("supports the client reschedule flow: replacement first, then cancel, and supersedes duplicates", async () => {
  const { save, submit, cancel, getSub, mail, sends } = await setup();
  const draft = await save();
  const first = (await submit(draft.id, { HOLDFOR: "3600" })).created.s;
  const replacement = (await submit(draft.id, { HOLDFOR: "1" })).created.s;
  expect((await cancel(first.id)).updated).toEqual({ [first.id]: null });
  await mail.runScheduled(Date.now() + 2_000);
  expect(sends()).toBe(1);
  expect((await getSub(replacement.id)).undoStatus).toBe("final");
  const other = await save();
  const x = (await submit(other.id, { HOLDFOR: "1" })).created.s;
  const y = (await submit(other.id, { HOLDFOR: "1" })).created.s;
  await mail.runScheduled(Date.now() + 2_000);
  expect(sends()).toBe(2);
  expect((await getSub(x.id)).undoStatus).toBe("final");
  expect((await getSub(y.id)).undoStatus).toBe("canceled");
});
it("reconciles entries interrupted mid-send on restart", async () => {
  const { save, submit, store, make } = await setup();
  const a = await save();
  const b = await save();
  const c = await save();
  const sa = (await submit(a.id, { HOLDFOR: "1" })).created.s;
  const sb = (await submit(b.id, { HOLDFOR: "1" })).created.s;
  const sc = (await submit(c.id, { HOLDFOR: "1" })).created.s;
  for (const s of [sa, sb, sc]) expect(store.scheduleLease(s.id)).toBe(true);
  // a stopped before drafts.send, b was sent, c stopped while drafts.send was in flight.
  store.beginSubmission(email, b.id.slice(2), sb.id);
  store.finishSubmission(email, b.id.slice(2), { id: sb.id, undoStatus: "final" }, "sentX");
  store.beginSubmission(email, c.id.slice(2), sc.id);
  expect(store.scheduleRecover()).toBe(3);
  const restarted = make();
  const list = (
    (await restarted.methods()["EmailSubmission/get"]!({
      accountId: restarted.accountId,
      ids: [sa.id, sb.id, sc.id],
    })) as any
  ).list;
  const find = (id: string) => list.find((x: any) => x.id === id);
  expect(find(sa.id).undoStatus).toBe("pending");
  expect(find(sb.id).undoStatus).toBe("final");
  expect(find(sb.id).deliveryStatus).toBeNull();
  expect(find(sc.id).deliveryStatus["recipient@example.test"].delivered).toBe("unknown");
  expect(store.scheduleStats()).toMatchObject({ sent: 1, uncertain: 1, pending: 1, sending: 0 });
});
