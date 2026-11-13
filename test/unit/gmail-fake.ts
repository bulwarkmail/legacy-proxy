import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { afterEach, vi } from "vitest";
import { GmailStore } from "../../src/gmail/store.js";
import { GmailMail } from "../../src/gmail/mail.js";
import { GMAIL_MODIFY } from "../../src/gmail/config.js";
import { JmapError } from "../../src/jmap/errors.js";

export const email = "index@gmail.com";
const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const f of cleanup.splice(0)) f();
});

interface Fake {
  id: string;
  threadId: string;
  labelIds: string[];
}
/** A small Gmail: messages newest first, a history log, and a count of what each call cost in round trips. */
export async function fakeGmail(opts: { pageSize?: number; older?: number } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gmail-index-"));
  const store = new GmailStore(dir, crypto.randomBytes(32));
  cleanup.push(() => {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const labels = ["INBOX", "UNREAD", "STARRED", "SENT", "TRASH", "SPAM", "DRAFT", "IMPORTANT"].map((id) => ({
    id,
    name: id,
    type: "system",
    messagesTotal: 0,
    messagesUnread: 0,
  }));
  await store.save(
    email,
    { mech: "XOAUTH2", username: email, refreshToken: "refresh", scopes: [GMAIL_MODIFY] },
    { profile: { emailAddress: email, historyId: "100", messagesTotal: 0, threadsTotal: 0 }, labels },
  );
  // Newest first, as Gmail lists them. m1..m3 are one conversation.
  const messages: Fake[] = [
    { id: "m5", threadId: "t5", labelIds: ["INBOX", "UNREAD"] },
    { id: "m4", threadId: "t4", labelIds: ["INBOX"] },
    { id: "m3", threadId: "t1", labelIds: ["INBOX", "UNREAD"] },
    { id: "m2", threadId: "t1", labelIds: ["SENT"] },
    { id: "m1", threadId: "t1", labelIds: ["INBOX"] },
    // Older mail, one conversation each, for tests that need whole pages.
    ...Array.from({ length: opts.older ?? 0 }, (_, i) => ({
      id: "o" + (100 - i),
      threadId: "to" + (100 - i),
      labelIds: ["INBOX"],
    })),
  ];
  let historyId = 100;
  const history: Record<string, unknown>[] = [];
  const whole = (m: Fake) => ({
    ...m,
    internalDate: String(1000 + Number(m.id.slice(1))),
    snippet: "hi",
    sizeEstimate: 10,
    payload: { mimeType: "text/plain", headers: [{ name: "Subject", value: "S " + m.id }] },
  });
  const find = (id: string) => {
    const m = messages.find((m) => m.id === id);
    if (!m) throw new JmapError("notFound");
    return m;
  };
  let beforePage: ((page: number) => void | Promise<void>) | undefined;
  const get = vi.fn(async (resource: string, _cost: number, params: any = {}) => {
    if (resource === "profile")
      return { emailAddress: email, historyId: String(historyId), messagesTotal: messages.length, threadsTotal: 3 };
    if (resource === "history")
      return {
        historyId: String(historyId),
        history: history.filter((h) => Number(h.id) > Number(params.startHistoryId)),
      };
    if (resource === "labels") return { labels };
    if (resource.startsWith("labels/")) {
      const id = resource.slice(7);
      return {
        ...labels.find((l) => l.id === id)!,
        messagesTotal: messages.filter((m) => m.labelIds.includes(id)).length,
        messagesUnread: messages.filter((m) => m.labelIds.includes(id) && m.labelIds.includes("UNREAD")).length,
      };
    }
    if (resource === "messages") {
      const wanted: string[] = params.labelIds ? [params.labelIds].flat() : [];
      const all = messages.filter((m) => wanted.every((l) => m.labelIds.includes(l)));
      const size = Math.min(Number(params.maxResults ?? 100), opts.pageSize ?? 500);
      const start = Number(params.pageToken ?? 0);
      await beforePage?.(start / size);
      const page = all.slice(start, start + size);
      return {
        messages: page.map(({ id, threadId }) => ({ id, threadId })),
        ...(start + size < all.length ? { nextPageToken: String(start + size) } : {}),
      };
    }
    if (resource.startsWith("messages/")) return whole(find(resource.slice(9)));
    if (resource.startsWith("threads/")) {
      const members = messages.filter((m) => m.threadId === resource.slice(8));
      if (!members.length) throw new JmapError("notFound");
      return { id: resource.slice(8), messages: members.map(whole) };
    }
    throw Error("Unexpected resource " + resource);
  });
  const batch = vi.fn(async (reads: { resource: string; params?: Record<string, string> }[]) =>
    Promise.all(
      reads.map(async (read) => {
        try {
          return { status: 200, data: (await get(read.resource, 0, read.params)) as any };
        } catch {
          return { status: 404 };
        }
      }),
    ),
  );
  const mutate = vi.fn(async (resource: string, _cost: number, _method: string, data: any) => {
    const m = find(resource.split("/")[1]!);
    m.labelIds = [...new Set([...m.labelIds.filter((l) => !data.removeLabelIds.includes(l)), ...data.addLabelIds])];
    return { id: m.id, threadId: m.threadId, labelIds: m.labelIds };
  });
  const mail = new GmailMail(
    email,
    { get, batch, mutate } as any,
    store,
    true,
    false,
    false,
    undefined,
    false,
    true,
  );
  const methods = mail.methods();
  /** Lets the next read see the account as Gmail has it now. */
  const sync = () => store.forget(email, [], []);
  return {
    store,
    mail,
    methods,
    get,
    batch,
    mutate,
    messages,
    sync,
    /** Appends a history record and moves Gmail's cursor. */
    record: (entry: Record<string, unknown>) => {
      history.push({ id: String(++historyId), ...entry });
      sync();
    },
    onPage: (hook: (page: number) => void | Promise<void>) => {
      beforePage = hook;
    },
    calls: (prefix: string) => get.mock.calls.filter((c) => String(c[0]).startsWith(prefix)),
    threads: async (...ids: string[]) =>
      ((await methods["Thread/get"]!({ accountId: mail.accountId, ids })) as any) as {
        list: { id: string; emailIds: string[] }[];
        notFound: string[];
      },
  };
}
