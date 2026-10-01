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
