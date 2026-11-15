import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { OAuth2Client } from "google-auth-library";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import { GmailStore } from "../../src/gmail/store.js";
import { GmailApi, GmailNotSent, MAX_CONCURRENT, MAX_QUEUE_WAIT_MS, quotaCost } from "../../src/gmail/api.js";
import { GmailConnection, type GoogleClient } from "../../src/gmail/connection.js";
import type { GmailConfig } from "../../src/gmail/config.js";
import { JmapError } from "../../src/jmap/errors.js";

const email = "queue@gmail.com";
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
  vi.useRealTimers();
  for (const f of cleanup.splice(0)) f();
});
async function open() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gmail-queue-"));
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
function google(request: (options: { url: string }) => Promise<unknown>): GoogleClient {
  return {
    credentials: { access_token: "token", expiry_date: Date.now() + 3600_000 },
    generateCodeVerifierAsync: vi.fn(),
    generateAuthUrl: vi.fn(),
    getToken: vi.fn(),
    setCredentials: vi.fn(),
    getAccessToken: vi.fn(async () => {}),
    request: vi.fn(request),
  } as unknown as GoogleClient;
}

/**
 * The error a request that outlives its `timeout` really throws, through the
 * same OAuth2Client (and gaxios underneath) the bridge uses, from a server
 * that never answers.
 */
let timeout: unknown;
beforeAll(async () => {
  const server = http.createServer(() => {}).listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const { port } = server.address() as { port: number };
  try {
    const client = new OAuth2Client();
    client.setCredentials({ access_token: "token", expiry_date: Date.now() + 3600_000 });
    await client.request({ url: `http://127.0.0.1:${port}/`, timeout: 50, retry: false });
  } catch (error) {
    timeout = error;
  }
  server.closeAllConnections();
  server.close();
  expect(timeout).toBeDefined();
});

it("retries a request Google did not answer in time, then says so", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  const store = await open();
  const client = google(async () => {
    throw timeout;
  });
  const api = new GmailApi(email, new GmailConnection(config, store, () => client), store);
  const result = api.get("labels", 1).catch((error: unknown) => error);
  await vi.advanceTimersByTimeAsync(10_000);
  const error = await result;
  expect(error).toBeInstanceOf(JmapError);
  expect(error).toMatchObject({ type: "serverUnavailable" });
  expect((error as Error).message).toMatch(/did not answer in time/);
  expect((error as Error).message).not.toMatch(/authori[sz]ation|reconnect/i);
  // Retried like any other network failure.
  expect(client.request).toHaveBeenCalledTimes(3);
});

it("refuses a request that waited too long for a slot, and keeps serving the others", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  const store = await open();
  const pending: (() => void)[] = [];
  const client = google(
    (options) =>
      new Promise((resolve) => {
        if (options.url.endsWith("/profile")) resolve({ data: { ok: true } });
        else pending.push(() => resolve({ data: { ok: true } }));
      }),
  );
  const api = new GmailApi(email, new GmailConnection(config, store, () => client), store);
  const busy = Array.from({ length: MAX_CONCURRENT }, () => api.get("labels", 1));
  await vi.advanceTimersByTimeAsync(1_000);
  expect(pending).toHaveLength(MAX_CONCURRENT);

  const read = api.get("profile", 1).catch((error: unknown) => error);
  const write = api.mutate("labels", 5, "POST", { name: "x" }).catch((error: unknown) => error);
  await vi.advanceTimersByTimeAsync(MAX_QUEUE_WAIT_MS);
  expect(await read).toMatchObject({ type: "serverUnavailable", message: expect.stringMatching(/backed up/) });
  // A write refused in the queue never reached Google: safe to retry.
  expect(await write).toBeInstanceOf(GmailNotSent);

  // The refused requests left the queue: every freed slot goes to a new request.
  for (const done of pending.splice(0)) done();
  await Promise.all(busy);
  const again = Array.from({ length: MAX_CONCURRENT }, () => api.get("labels", 1));
  await vi.advanceTimersByTimeAsync(1_000);
  expect(pending).toHaveLength(MAX_CONCURRENT);
  for (const done of pending.splice(0)) done();
  await Promise.all(again);
});

it("prices calls as Google does", () => {
  expect(quotaCost("messages", undefined, { labelIds: "INBOX" })).toBe(5);
  expect(quotaCost("messages/abc", undefined, { format: "metadata" })).toBe(20);
  expect(quotaCost("messages/abc", undefined, { format: "minimal" })).toBe(20);
  expect(quotaCost("messages/abc", undefined, { format: "full" })).toBe(60);
  // Gmail's default format is the whole message.
  expect(quotaCost("messages/abc")).toBe(60);
  expect(quotaCost("messages/abc", undefined, { format: "raw" })).toBe(60);
  expect(quotaCost("messages/abc/attachments/x")).toBe(20);
  expect(quotaCost("threads/abc", undefined, { format: "minimal" })).toBe(40);
  expect(quotaCost("threads/abc", undefined, { format: "metadata" })).toBe(40);
  expect(quotaCost("threads/abc", undefined, { format: "full" })).toBe(120);
  expect(quotaCost("labels/INBOX")).toBe(1);
  expect(quotaCost("history")).toBe(2);
  expect(quotaCost("profile")).toBe(1);
  expect(quotaCost("settings/sendAs")).toBe(1);
  expect(quotaCost("messages/abc/modify", "POST")).toBe(5);
  expect(quotaCost("drafts/send", "POST")).toBe(100);
  expect(quotaCost("drafts", "POST")).toBe(10);
  expect(quotaCost("watch", "POST")).toBe(100);
  expect(quotaCost("something/else")).toBeUndefined();
});

it("spends a rested account's minute at once, then waits for it to come back or says when it will", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  const store = await open();
  const sent: { at: number; url: string }[] = [];
  const start = Date.now();
  const client = google(async (options) => {
    sent.push({ at: Date.now() - start, url: options.url.replace(/^.*\/(v1\/users\/me\/|batch\/)/, "") });
    return { data: { ok: true } };
  });
  const api = new GmailApi(email, new GmailConnection(config, store, () => client), store);
  const threads = (n: number) =>
    api.batch(Array.from({ length: n }, (_, i) => ({ resource: `threads/${i}`, params: { format: "metadata" } })), 0).catch((e) => e);
  // Two cold folder pages, 2,000 units each, and a counter read: no waiting.
  const pages = [threads(50), threads(50), api.get("labels/INBOX", 0)];
  await vi.advanceTimersByTimeAsync(0);
  await Promise.all(pages);
  expect(sent.map((s) => s.at)).toEqual([0, 0, 0]);
  // A third page does not fit in what is left of the 5,400, and the minute
  // gives nothing back for sixty seconds: refused at once, with the delay.
  const refused = await threads(50);
  expect(refused).toMatchObject({ type: "serverUnavailable", message: expect.stringMatching(/retry in 60 s/) });
  // What does fit still goes, at once.
  await api.get("messages", 0, { labelIds: "INBOX" });
  expect(sent.at(-1)).toEqual({ at: 0, url: expect.stringContaining("messages?labelIds=INBOX") });
  // Close enough to the minute's end, the page waits for it instead.
  await vi.advanceTimersByTimeAsync(45_000);
  const third = threads(50);
  await vi.advanceTimersByTimeAsync(20_000);
  await third;
  expect(sent.at(-1)!.at).toBeGreaterThanOrEqual(60_000);
  expect(sent.at(-1)!.at).toBeLessThan(60_100);
});

it("asks again, together and after a pause, for the batch parts Google refused over quota", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  const store = await open();
  const sent: { at: number; ids: string[] }[] = [];
  const start = Date.now();
  const client = google(async (options: any) => {
    const ids = [...String(options.data).matchAll(/messages\/(\w+)/g)].map((m) => m[1]!);
    sent.push({ at: Date.now() - start, ids });
    const first = sent.length === 1;
    const boundary = "--batch_x";
    const parts = ids.map((id, index) => {
      const refused = first && (id === "c" || id === "d");
      const payload = refused
        ? JSON.stringify({ error: { code: 403, message: "Quota exceeded for quota metric 'Total Query Cost'" } })
        : JSON.stringify({ id });
      return (
        `${boundary}\r\nContent-Type: application/http\r\nContent-ID: <response-item-${index}>\r\n\r\n` +
        `HTTP/1.1 ${refused ? "403 Forbidden" : "200 OK"}\r\nContent-Type: application/json\r\n\r\n${payload}\r\n`
      );
    });
    return { data: parts.join("") + boundary + "--\r\n" };
  });
  const api = new GmailApi(email, new GmailConnection(config, store, () => client), store);
  const result = api.batch<{ id: string }>(
    ["a", "b", "c", "d"].map((id) => ({ resource: `messages/${id}` })),
    5,
  );
  await vi.advanceTimersByTimeAsync(5_000);
  // Every message arrives, in the order asked for.
  expect((await result).map((r) => r.data?.id)).toEqual(["a", "b", "c", "d"]);
  // The two refused went out again in one request, a second later.
  expect(sent).toEqual([
    { at: 0, ids: ["a", "b", "c", "d"] },
    { at: 1000, ids: ["c", "d"] },
  ]);
});

it("sends straight back the batch parts Google refused for being too many at once", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  const store = await open();
  const sent: { at: number; ids: string[] }[] = [];
  const start = Date.now();
  const client = google(async (options: any) => {
    const ids = [...String(options.data).matchAll(/threads\/(\w+)/g)].map((m) => m[1]!);
    sent.push({ at: Date.now() - start, ids });
    const first = sent.length === 1;
    const boundary = "--batch_x";
    const parts = ids.map((id, index) => {
      const refused = first && id === "b";
      const payload = refused
        ? JSON.stringify({ error: { code: 429, message: "Too many concurrent requests for user." } })
        : JSON.stringify({ id });
      return (
        `${boundary}\r\nContent-Type: application/http\r\nContent-ID: <response-item-${index}>\r\n\r\n` +
        `HTTP/1.1 ${refused ? "429 Too Many Requests" : "200 OK"}\r\nContent-Type: application/json\r\n\r\n${payload}\r\n`
      );
    });
    return { data: parts.join("") + boundary + "--\r\n" };
  });
  const api = new GmailApi(email, new GmailConnection(config, store, () => client), store);
  const result = api.batch<{ id: string }>(
    ["a", "b", "c"].map((id) => ({ resource: `threads/${id}`, params: { format: "metadata" } })),
    0,
  );
  await vi.advanceTimersByTimeAsync(100);
  expect((await result).map((r) => r.data?.id)).toEqual(["a", "b", "c"]);
  // No pause: the crowd it was refused for was its own batch.
  expect(sent).toEqual([
    { at: 0, ids: ["a", "b", "c"] },
    { at: 0, ids: ["b"] },
  ]);
});

it("retries a single request, a write too, that Google refused for crowding, without holding the account", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  const store = await open();
  const sent: { at: number; url: string }[] = [];
  const start = Date.now();
  let refusals = 2;
  const client = google(async (options) => {
    sent.push({ at: Date.now() - start, url: options.url.replace(/^.*\/users\/me\//, "") });
    if (options.url.endsWith("/modify") && refusals-- > 0)
      throw {
        response: {
          status: 429,
          data: { error: { message: "Too many concurrent requests for user.", errors: [{ reason: "rateLimitExceeded" }] } },
        },
      };
    return { data: { id: "a", labelIds: ["INBOX"] } };
  });
  const api = new GmailApi(
    email,
    new GmailConnection({ ...config, writeEnabled: true } as GmailConfig, store, () => client),
    store,
  );
  await store.save(
    email,
    {
      mech: "XOAUTH2",
      username: email,
      accessToken: "token",
      refreshToken: "refresh",
      expiresAt: Date.now() + 3600_000,
      scopes: ["https://www.googleapis.com/auth/gmail.modify"],
    },
    { profile: { emailAddress: email, historyId: "1", messagesTotal: 1, threadsTotal: 1 }, labels: [] },
  );
  const write = api.mutate("messages/a/modify", 5, "POST", { addLabelIds: [], removeLabelIds: ["UNREAD"] });
  // Another request of the same account is not made to wait for it.
  const read = api.get("labels/INBOX", 1);
  await vi.advanceTimersByTimeAsync(1_000);
  expect(await write).toMatchObject({ id: "a" });
  await read;
  expect(sent).toEqual([
    { at: 0, url: "messages/a/modify" },
    { at: 0, url: "labels/INBOX" },
    { at: 150, url: "messages/a/modify" },
    { at: 450, url: "messages/a/modify" },
  ]);
  // The refusals cost nothing: Google never ran them. One modify and a label read.
  expect(api.spare()).toBe(5400 - 5 - 1);
});

it("makes two page-sized batches of one account take turns at Google", async () => {
  const store = await open();
  let running = 0;
  let most = 0;
  const order: number[] = [];
  const client = google(async (options: any) => {
    const reads = (String(options.data).match(/^GET /gm) ?? []).length;
    order.push(reads);
    running += reads;
    most = Math.max(most, running);
    await new Promise((resolve) => setTimeout(resolve, 15));
    running -= reads;
    return { data: "" };
  });
  const api = new GmailApi(email, new GmailConnection(config, store, () => client), store);
  const rows = (n: number) =>
    api.batch(Array.from({ length: n }, (_, i) => ({ resource: `messages/${i}`, params: { format: "metadata" } })), 0);
  // A page, the unread section above it, and a few rows more.
  await Promise.all([rows(50), rows(25), rows(20)]);
  // The page went alone; the two smaller ones fit together after it.
  expect(order).toEqual([50, 25, 20]);
  expect(most).toBe(50);
});

it("spends nine tenths of whatever the project's per-user quota is", async () => {
  const store = await open();
  const client = google(async () => ({ data: { ok: true } }));
  const standard = new GmailApi(email, new GmailConnection(config, store, () => client), store);
  expect(standard.spare()).toBe(5400);
  const raised = new GmailApi(
    email,
    new GmailConnection({ ...config, quotaPerMinute: 15000 } as GmailConfig, store, () => client),
    store,
  );
  expect(raised.spare()).toBe(13500);
  await raised.get("messages/a", 0, { format: "full" });
  expect(raised.spare()).toBe(13440);
});

it("keeps a write Google refused for crowding 'not sent' if it then gives up before sending again", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  const store = await open();
  await store.save(
    email,
    {
      mech: "XOAUTH2",
      username: email,
      accessToken: "token",
      refreshToken: "refresh",
      expiresAt: Date.now() + 3600_000,
      scopes: ["https://www.googleapis.com/auth/gmail.modify"],
    },
    { profile: { emailAddress: email, historyId: "1", messagesTotal: 1, threadsTotal: 1 }, labels: [] },
  );
  const client = google(async (options) => {
    if (options.url.endsWith("/drafts/send"))
      throw {
        response: {
          status: 429,
          data: { error: { message: "Too many concurrent requests for user.", errors: [{ reason: "rateLimitExceeded" }] } },
        },
      };
    // A sibling read that Google holds off for a minute.
    throw { response: { status: 429, headers: new Headers({ "retry-after": "60" }) } };
  });
  const api = new GmailApi(
    email,
    new GmailConnection({ ...config, writeEnabled: true, composeEnabled: true } as GmailConfig, store, () => client),
    store,
  );
  const send = api.mutate("drafts/send", 100, "POST", { id: "d" }).catch((error: unknown) => error);
  const read = api.get("labels/INBOX", 1).catch((error: unknown) => error);
  await vi.advanceTimersByTimeAsync(2_000);
  await read;
  // Google never ran the send: the caller may safely try again.
  expect(await send).toBeInstanceOf(GmailNotSent);
});

it("keeps the reads a batch already answered when the minute has no room to ask again for the rest", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  const store = await open();
  let calls = 0;
  const client = google(async (options: any) => {
    calls++;
    const ids = [...String(options.data).matchAll(/threads\/(\w+)/g)].map((m) => m[1]!);
    const boundary = "--batch_x";
    const parts = ids.map((id, index) => {
      const refused = Number(id) >= 40;
      const payload = refused
        ? JSON.stringify({ error: { code: 403, message: "Quota exceeded for quota metric 'Total Query Cost'" } })
        : JSON.stringify({ id });
      return (
        `${boundary}\r\nContent-Type: application/http\r\nContent-ID: <response-item-${index}>\r\n\r\n` +
        `HTTP/1.1 ${refused ? "403 Forbidden" : "200 OK"}\r\nContent-Type: application/json\r\n\r\n${payload}\r\n`
      );
    });
    return { data: parts.join("") + boundary + "--\r\n" };
  });
  const api = new GmailApi(email, new GmailConnection(config, store, () => client), store);
  const threads = (from: number) =>
    api.batch<{ id: string }>(
      Array.from({ length: 50 }, (_, i) => ({ resource: `threads/${from + i}`, params: { format: "metadata" } })),
      0,
    );
  // Two pages, 4,000 units, of which Google refuses the last ten reads of the
  // first. Asking again for those ten (400 units, after the tenth of a minute
  // the refusal wrote off) no longer fits in what is left of the 5,400.
  const second = threads(100).catch((error: unknown) => error);
  const first = threads(0);
  await vi.advanceTimersByTimeAsync(5_000);
  await second;
  const answers = await first;
  // The forty that arrived are kept; the ten are reported refused.
  expect(answers.filter((a) => a.data).map((a) => Number(a.data!.id))).toEqual(Array.from({ length: 40 }, (_, i) => i));
  expect(answers.slice(40).every((a) => a.status === 403)).toBe(true);
  expect(calls).toBeLessThanOrEqual(3);
});

it("sends a large account's label reads fifty at a time", async () => {
  const store = await open();
  const sizes: number[] = [];
  const client = google(async (options: any) => {
    sizes.push((String(options.data).match(/^GET /gm) ?? []).length);
    return { data: "" };
  });
  const api = new GmailApi(email, new GmailConnection(config, store, () => client), store);
  await api.batch(Array.from({ length: 100 }, (_, i) => ({ resource: `labels/Label_${i}` })), 1);
  expect(sizes).toEqual([50, 50]);
});
