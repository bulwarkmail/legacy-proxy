import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { GmailStore } from "../../src/gmail/store.js";
import { GmailMail } from "../../src/gmail/mail.js";

const email = "reader@example.test";
const profile = { emailAddress: email, historyId: "5", messagesTotal: 1, threadsTotal: 1 };
const message = {
  id: "a",
  threadId: "t1",
  internalDate: "1700000000000",
  labelIds: ["INBOX"],
  snippet: "hi",
  sizeEstimate: 42,
  payload: {
    mimeType: "text/plain",
    headers: [{ name: "Subject", value: "Hello" }],
    body: { data: Buffer.from("body").toString("base64url"), size: 4 },
  },
};
const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const f of cleanup.splice(0)) f();
});
function open() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gmail-get-"));
  const store = new GmailStore(dir, crypto.randomBytes(32));
  cleanup.push(() => {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return store;
}

it("reads list properties with the metadata format and bodies with the full format", async () => {
  const store = open();
  const formats: string[] = [];
  const get = vi.fn(async (resource: string, _cost: number, params: any = {}) => {
    if (resource === "profile") return profile;
    if (resource === "labels") return { labels: [] };
    if (resource === "messages/a") {
      formats.push(params.format);
      return params.format === "metadata"
        ? { ...message, payload: { headers: message.payload.headers } }
        : message;
    }
    throw Error("Unexpected fixture resource " + resource);
  });
  const mail = new GmailMail(email, { get } as any, store);
  const methods = mail.methods();
  const list = (await methods["Email/get"]!({
    accountId: mail.accountId,
    ids: ["m_a"],
    properties: ["subject", "preview", "keywords", "size", "header:Subject:asText"],
  })) as any;
  expect(list.list[0]).toMatchObject({
    subject: "Hello",
    preview: "hi",
    size: 42,
    keywords: { $seen: true },
  });
  expect(formats).toEqual(["metadata"]);
  const full = (await methods["Email/get"]!({
    accountId: mail.accountId,
    ids: ["m_a"],
    properties: ["bodyValues", "textBody"],
    fetchTextBodyValues: true,
  })) as any;
  expect((Object.values(full.list[0].bodyValues)[0] as any).value).toBe("body");
  expect(formats).toEqual(["metadata", "full"]);
  // The cached full message now answers metadata reads too.
  await methods["Email/get"]!({ accountId: mail.accountId, ids: ["m_a"], properties: ["subject"] });
  expect(formats).toEqual(["metadata", "full"]);
});

it("reads a list row that asks for hasAttachment as metadata, telling the flag from the Content-Type", async () => {
  const store = open();
  const formats: string[] = [];
  const whole = {
    ...message,
    payload: {
      mimeType: "multipart/mixed",
      headers: [
        { name: "Subject", value: "Hello" },
        { name: "Content-Type", value: 'multipart/mixed; boundary="x"' },
      ],
      parts: [
        { partId: "0", mimeType: "text/plain", headers: [], body: { data: Buffer.from("body").toString("base64url"), size: 4 } },
        { partId: "1", mimeType: "application/pdf", filename: "a.pdf", headers: [], body: { attachmentId: "att", size: 9 } },
      ],
    },
  };
  const plain = {
    ...message,
    id: "b",
    payload: { mimeType: "multipart/alternative", headers: [{ name: "Content-Type", value: "multipart/alternative; boundary=y" }] },
  };
  const get = vi.fn(async (resource: string, _cost: number, params: any = {}) => {
    if (resource === "profile") return profile;
    if (resource === "labels") return { labels: [] };
    if (resource === "messages/a") {
      formats.push(params.format);
      // Metadata: the headers, without the MIME tree.
      return params.format === "metadata"
        ? { ...whole, payload: { mimeType: whole.payload.mimeType, headers: whole.payload.headers } }
        : whole;
    }
    if (resource === "messages/b") return plain;
    throw Error("Unexpected fixture resource " + resource);
  });
  const mail = new GmailMail(email, { get } as any, store);
  const methods = mail.methods();
  const row = async (id: string) =>
    ((await methods["Email/get"]!({
      accountId: mail.accountId,
      ids: [id],
      properties: ["subject", "preview", "hasAttachment", "blobId", "header:Authentication-Results:all"],
    })) as any).list[0];
  // A mail that carries files says so in its own Content-Type; one that only
  // offers two renderings of its text does not.
  expect(await row("m_a")).toMatchObject({ subject: "Hello", hasAttachment: true });
  expect(await row("m_b")).toMatchObject({ hasAttachment: false });
  expect(formats).toEqual(["metadata"]);
  // Opening the message reads it whole, once; rows are exact from then on.
  const opened = (await methods["Email/get"]!({
    accountId: mail.accountId,
    ids: ["m_a"],
    properties: ["bodyValues", "textBody", "attachments"],
    fetchTextBodyValues: true,
  })) as any;
  expect(opened.list[0].attachments).toHaveLength(1);
  expect(await row("m_a")).toMatchObject({ hasAttachment: true });
  expect(formats).toEqual(["metadata", "full"]);
});

it("reads a listed page's rows and conversation sizes together, once, ahead of the calls that ask for them", async () => {
  const store = open();
  const ids = Array.from({ length: 6 }, (_, i) => "m" + i);
  const inbox = { id: "INBOX", name: "INBOX", type: "system", messagesTotal: 6, messagesUnread: 0 };
  const get = vi.fn(async (resource: string, _cost: number, _params: any = {}) => {
    if (resource === "profile") return { ...profile, messagesTotal: 6 };
    if (resource === "labels") return { labels: [inbox] };
    if (resource === "labels/INBOX") return inbox;
    if (resource === "messages") return { messages: ids.map((id) => ({ id, threadId: "t" + id })) };
    throw Error("Unexpected fixture resource " + resource);
  });
  const batches: { resource: string; format?: string; reads: number }[] = [];
  const batch = vi.fn(async (reads: { resource: string; params?: Record<string, string> }[]) => {
    batches.push({ resource: reads[0]!.resource.split("/")[0]!, format: reads[0]!.params?.format, reads: reads.length });
    return reads.map((read) => {
      const thread = read.resource.split("/")[1]!;
      const id = thread.slice(1);
      return { status: 200, data: { id: thread, messages: [{ ...message, id, threadId: thread }] } };
    });
  });
  const mail = new GmailMail(email, { get, batch } as any, store);
  const methods = mail.methods();
  const listed = (await methods["Email/query"]!({
    accountId: mail.accountId,
    filter: { inMailbox: "l_INBOX" },
    limit: 50,
  })) as any;
  const rows = (await methods["Email/get"]!({
    accountId: mail.accountId,
    ids: listed.ids,
    properties: ["threadId", "subject", "hasAttachment"],
  })) as any;
  const threads = (await methods["Thread/get"]!({
    accountId: mail.accountId,
    ids: rows.list.map((r: any) => r.threadId),
  })) as any;
  expect(rows.list.map((r: any) => r.subject)).toEqual(Array(6).fill("Hello"));
  expect(threads.list.map((t: any) => t.emailIds)).toEqual(ids.map((id) => ["m_" + id]));
  // One batch, of threads read with their messages' metadata, started by the
  // query: the two calls after it found everything there, and no message was
  // read on its own.
  expect(batches).toEqual([{ resource: "threads", format: "metadata", reads: 6 }]);
  expect(get.mock.calls.filter((c) => String(c[0]).startsWith("messages/") || String(c[0]).startsWith("threads/"))).toEqual([]);
  // A count warms nothing.
  await methods["Email/query"]!({ accountId: mail.accountId, filter: { inMailbox: "l_INBOX" }, limit: 1, position: 3 });
  expect(batch).toHaveBeenCalledTimes(1);
});

it("fetches threads concurrently, at most four at a time, in request order", async () => {
  const store = open();
  let active = 0;
  let peak = 0;
  const get = vi.fn(async (resource: string) => {
    if (resource === "profile") return profile;
    if (resource.startsWith("threads/")) {
      const id = resource.slice("threads/".length);
      active++;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active--;
      return { id, messages: [{ id: "m" + id, threadId: id, internalDate: "1" }] };
    }
    throw Error("Unexpected fixture resource " + resource);
  });
  const mail = new GmailMail(email, { get } as any, store);
  const ids = Array.from({ length: 10 }, (_, i) => "t_x" + i);
  const result = (await mail.methods()["Thread/get"]!({ accountId: mail.accountId, ids })) as any;
  expect(result.list.map((t: any) => t.id)).toEqual(ids);
  expect(result.list[0].emailIds).toEqual(["m_mx0"]);
  expect(peak).toBeGreaterThan(1);
  expect(peak).toBeLessThanOrEqual(4);
});

it("reads a page's threads in one minimal batch and keeps only their members", async () => {
  const store = open();
  const get = vi.fn(async (resource: string) => {
    if (resource === "profile") return profile;
    throw Error("Unexpected fixture resource " + resource);
  });
  const batch = vi.fn(async (reads: { resource: string; params?: Record<string, string> }[]) =>
    reads.map(({ resource, params }) => {
      expect(params).toEqual({ format: "minimal" });
      const id = resource.slice("threads/".length);
      return {
        status: 200,
        data: {
          id,
          messages: [
            { id: "late" + id, threadId: id, internalDate: "2", payload: { body: { data: "secret" } } },
            { id: "early" + id, threadId: id, internalDate: "1" },
          ],
        },
      };
    }),
  );
  const mail = new GmailMail(email, { get, batch } as any, store);
  const ids = Array.from({ length: 50 }, (_, i) => "t_x" + i);
  const read = async () => (await mail.methods()["Thread/get"]!({ accountId: mail.accountId, ids })) as any;

  const first = await read();
  expect(batch).toHaveBeenCalledTimes(1);
  expect(get.mock.calls.some((c) => String(c[0]).startsWith("threads/"))).toBe(false);
  expect(first.list.map((t: any) => t.id)).toEqual(ids);
  expect(first.list[0].emailIds).toEqual(["m_earlyx0", "m_latex0"]);
  // Nothing but ids and dates is cached, and no message is written from a thread.
  expect(JSON.stringify(store.cached(email, "thread:v3:t_x0"))).not.toContain("secret");
  expect(store.cached(email, "message:v2:latex0")).toBeNull();

  const again = await read();
  expect(batch).toHaveBeenCalledTimes(1);
  expect(again.list).toEqual(first.list);

  // A change Gmail reports for the thread drops it, and the next read asks again.
  store.checkpoint(email, "99", [], ["x0"]);
  await read();
  expect(batch).toHaveBeenCalledTimes(2);
  expect(batch.mock.calls[1]![0]).toHaveLength(1);
});
