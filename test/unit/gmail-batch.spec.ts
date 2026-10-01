import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { GmailStore } from "../../src/gmail/store.js";
import { GmailApi } from "../../src/gmail/api.js";
import { GmailMail } from "../../src/gmail/mail.js";
import { GmailConnection, type GoogleClient } from "../../src/gmail/connection.js";
import type { GmailConfig } from "../../src/gmail/config.js";

const email = "batch@gmail.com";
const config = {
  clientId: "id",
  clientSecret: "secret",
  origin: "https://bridge.example.com",
  redirectUri: "https://bridge.example.com/auth/google/callback",
  secureCookies: true,
  allowedEmails: new Set([email]),
} as GmailConfig;
const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const f of cleanup.splice(0)) f();
});
async function open() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gmail-batch-"));
  const store = new GmailStore(dir, crypto.randomBytes(32));
  cleanup.push(() => {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  await store.save(
    email,
    { mech: "XOAUTH2", username: email, accessToken: "token", refreshToken: "refresh", expiresAt: Date.now() + 3600_000 },
    { profile: { emailAddress: email, historyId: "1", messagesTotal: 1, threadsTotal: 1 }, labels: [] },
  );
  return store;
}
/** One `multipart/mixed` part, as Google writes them: CRLF throughout, blank line before the first boundary. */
function part(boundary: string, index: number, status: number, body: unknown): string {
  return (
    `--${boundary}\r\nContent-Type: application/http\r\nContent-ID: <response-item-${index}>\r\n\r\n` +
    `HTTP/1.1 ${status} ${status === 200 ? "OK" : "Error"}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n` +
    `${JSON.stringify(body)}\r\n\r\n`
  );
}
function google(answer: (body: string) => string): GoogleClient {
  return {
    credentials: { access_token: "token", expiry_date: Date.now() + 3600_000 },
    generateCodeVerifierAsync: vi.fn(),
    generateAuthUrl: vi.fn(),
    getToken: vi.fn(),
    setCredentials: vi.fn(),
    getAccessToken: vi.fn(async () => {}),
    request: vi.fn(async (options) => ({ data: answer(String(options.data)) })),
  } as unknown as GoogleClient;
}

it("reads several messages in one request and pairs answers with their own sub-request", async () => {
  const store = await open();
  let asked = "";
  const client = google((body) => {
    asked = body;
    const boundary = body.slice(2, body.indexOf("\r\n"));
    // Answered back to front: only the Content-ID says which read each part belongs to.
    return (
      "\r\n" +
      part(boundary, 2, 404, { error: { code: 404 } }) +
      part(boundary, 1, 200, { id: "b" }) +
      part(boundary, 0, 200, { id: "a" }) +
      `--${boundary}--\r\n`
    );
  });
  const api = new GmailApi(email, new GmailConnection(config, store, () => client), store);
  const answers = await api.batch<{ id: string }>(
    ["a", "b", "c"].map((id) => ({ resource: `messages/${id}`, params: { format: "metadata" } })),
    5,
  );
  expect(answers).toEqual([
    { status: 200, data: { id: "a" } },
    { status: 200, data: { id: "b" } },
    { status: 404 },
  ]);
  expect(client.request).toHaveBeenCalledTimes(1);
  expect(asked).toContain("GET /gmail/v1/users/me/messages/a?format=metadata");
  expect(asked).toContain("Content-ID: <item-2>");
});

it("fails fast when Google throttles every read in the batch", async () => {
  const store = await open();
  const client = google((body) => {
    const boundary = body.slice(2, body.indexOf("\r\n"));
    return (
      "\r\n" +
      part(boundary, 0, 403, { error: { code: 403, message: "Quota exceeded" } }) +
      part(boundary, 1, 403, { error: { code: 403, message: "Quota exceeded" } }) +
      `--${boundary}--\r\n`
    );
  });
  const api = new GmailApi(email, new GmailConnection(config, store, () => client), store);
  await expect(
    api.batch(["a", "b"].map((id) => ({ resource: `messages/${id}` })), 5),
  ).rejects.toThrow(/rate limit/i);
});

it("Email/get fetches a page through one batch rather than one read per message", async () => {
  const store = await open();
  const ids = Array.from({ length: 12 }, (_, i) => `m${i}`);
  const message = (id: string) => ({
    id,
    threadId: "t" + id,
    internalDate: "1700000000000",
    labelIds: ["INBOX"],
    snippet: "hi",
    sizeEstimate: 10,
    payload: { mimeType: "text/plain", headers: [{ name: "Subject", value: id }] },
  });
  const get = vi.fn(async (resource: string) => {
    if (resource === "profile") return { emailAddress: email, historyId: "5", messagesTotal: 12, threadsTotal: 12 };
    if (resource === "labels") return { labels: [] };
    throw Error("Unexpected per-message read: " + resource);
  });
  const batch = vi.fn(async (reads: { resource: string }[]) =>
    reads.map((read) => ({ status: 200, data: message(read.resource.replace("messages/", "")) })),
  );
  const mail = new GmailMail(email, { get, batch } as never, store);
  const result = (await mail.methods()["Email/get"]!({
    accountId: mail.accountId,
    ids: ids.map((id) => "m_" + id),
    properties: ["subject", "receivedAt"],
  })) as { list: { subject: string }[] };
  expect(result.list.map((m) => m.subject)).toEqual(ids);
  expect(batch).toHaveBeenCalledTimes(1);
  expect(batch.mock.calls[0]![0]).toHaveLength(12);
});
