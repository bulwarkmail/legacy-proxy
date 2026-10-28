import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { OAuth2Client } from "google-auth-library";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import { GmailStore } from "../../src/gmail/store.js";
import { GmailApi, GmailNotSent, MAX_CONCURRENT, MAX_QUEUE_WAIT_MS } from "../../src/gmail/api.js";
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
