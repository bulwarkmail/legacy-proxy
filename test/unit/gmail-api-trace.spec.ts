import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { GmailStore } from "../../src/gmail/store.js";
import { GmailApi, MAX_CONCURRENT, MAX_QUEUE_WAIT_MS } from "../../src/gmail/api.js";
import { GmailConnection, type GoogleClient } from "../../src/gmail/connection.js";
import type { GmailConfig } from "../../src/gmail/config.js";
import { newTrace, runTraced } from "../../src/jmap/trace.js";

const email = "trace@gmail.com";
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
async function api(request: (options: { url: string }) => Promise<unknown>) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gmail-trace-"));
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
  const client = {
    credentials: { access_token: "token", expiry_date: Date.now() + 3600_000 },
    generateCodeVerifierAsync: vi.fn(),
    generateAuthUrl: vi.fn(),
    getToken: vi.fn(),
    setCredentials: vi.fn(),
    getAccessToken: vi.fn(async () => {}),
    request: vi.fn(request),
  } as unknown as GoogleClient;
  return new GmailApi(email, new GmailConnection(config, store, () => client), store);
}

it("books every time a request is sent, not once for all its retries", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  let failures = 2;
  const gmail = await api(async () => {
    if (failures-- > 0) throw { response: { status: 503 } };
    return { data: { ok: true } };
  });
  const trace = newTrace();
  const read = runTraced(trace, () => gmail.get("labels", 1));
  await vi.advanceTimersByTimeAsync(10_000);
  await read;
  // Sent three times: three calls Google counted, three times the price.
  expect(trace).toMatchObject({ calls: 3, reads: 3, units: 3 });
});

it("books the wait of a request that never got a slot", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
  const gmail = await api(() => new Promise(() => {}));
  for (let i = 0; i < MAX_CONCURRENT; i++) void gmail.get("labels", 1).catch(() => {});
  await vi.advanceTimersByTimeAsync(100);
  const trace = newTrace();
  const refused = runTraced(trace, () => gmail.get("profile", 1)).catch((error: unknown) => error);
  await vi.advanceTimersByTimeAsync(MAX_QUEUE_WAIT_MS);
  expect(await refused).toMatchObject({ type: "serverUnavailable" });
  // Nothing was sent, and the ten seconds in the queue are on the record.
  expect(trace.calls).toBe(0);
  expect(trace.waitMs).toBeGreaterThanOrEqual(MAX_QUEUE_WAIT_MS);
});

it("counts every read of a batch Google refused as a whole", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  const gmail = await api(async () => {
    throw { response: { status: 429, data: { error: { message: "Quota exceeded", errors: [{ reason: "rateLimitExceeded" }] } } } };
  });
  const trace = newTrace();
  const batch = runTraced(trace, () =>
    gmail.batch(Array.from({ length: 7 }, (_, i) => ({ resource: `messages/${i}` })), 5),
  ).catch((error: unknown) => error);
  await vi.advanceTimersByTimeAsync(20_000);
  await batch;
  expect(trace.refused % 7).toBe(0);
  expect(trace.refused).toBeGreaterThanOrEqual(7);
});
