import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import Fastify from "fastify";
import { afterEach, it, expect, vi } from "vitest";
import { GmailStore } from "../../src/gmail/store.js";
import { GmailMail } from "../../src/gmail/mail.js";
import { GmailPush } from "../../src/gmail/push.js";
import { GMAIL_MODIFY } from "../../src/gmail/config.js";
import { JmapError } from "../../src/jmap/errors.js";
import { registerGmailBackend } from "../../src/gmail/backend.js";
const email = "pushed@example.test";
const TOKEN = "a-very-long-shared-secret-token-123";
const PUSH = { topic: "projects/bridge-test/topics/gmail", token: TOKEN };
const labels = [
  { id: "INBOX", name: "INBOX", type: "system", messagesTotal: 1, messagesUnread: 1 },
  { id: "DRAFT", name: "DRAFT", type: "system" },
];
const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const f of cleanup.splice(0)) f();
  vi.useRealTimers();
});
async function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gmail-push-"));
  const store = new GmailStore(dir, crypto.randomBytes(32));
  cleanup.push(() => {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  await store.save(
    email,
    { mech: "XOAUTH2", username: email, refreshToken: "refresh", scopes: [GMAIL_MODIFY] },
    { profile: { emailAddress: email, historyId: "10", messagesTotal: 1, threadsTotal: 1 }, labels },
  );
  const state = { history: "10", records: [] as any[], watchError: null as Error | null };
  const get = vi.fn(async (resource: string, _c: number, params: any = {}) => {
    if (resource === "profile")
      return { emailAddress: email, historyId: state.history, messagesTotal: 1, threadsTotal: 1 };
    if (resource === "labels") return { labels };
    if (resource.startsWith("labels/")) return labels.find((l) => l.id === resource.slice(7));
    if (resource === "history")
      return {
        historyId: state.history,
        history: params.startHistoryId === state.history ? [] : state.records,
      };
    throw Error("Unexpected fixture resource " + resource);
  });
  const mutate = vi.fn(async (resource: string) => {
    if (resource === "watch") {
      if (state.watchError) throw state.watchError;
      return { historyId: state.history, expiration: String(Date.now() + 7 * 86400_000) };
    }
    throw Error("Unexpected mutation " + resource);
  });
  const mail = new GmailMail(email, { get, mutate } as any, store, true, true);
  const log = { warn: vi.fn(), error: vi.fn(), info: vi.fn() } as any;
  const push = new GmailPush(store, () => mail, new Set([email]), PUSH, log);
  cleanup.push(() => push.stop());
  const app = Fastify();
  cleanup.push(() => {
    void app.close();
  });
  app.post("/gmail/push", async (req, reply) => push.receive(req, reply));
  const notify = (address: string, history: string) =>
    app.inject({
      method: "POST",
      url: "/gmail/push?token=" + TOKEN,
      payload: {
        message: {
          data: Buffer.from(JSON.stringify({ emailAddress: address, historyId: history })).toString("base64"),
          messageId: "m",
        },
        subscription: "s",
      },
    });
  const fakeReply = () => {
    const written: string[] = [];
    const handlers: Record<string, (() => void)[]> = {};
    return {
      written,
      close: () => {
        for (const fn of handlers.close ?? []) fn();
      },
      reply: {
        raw: {
          setHeader() {},
          write(s: string) {
            written.push(s);
          },
          end() {},
          on(ev: string, fn: () => void) {
            (handlers[ev] ??= []).push(fn);
          },
        },
      } as any,
    };
  };
  const advance = (records: any[]) => {
    state.history = String(Number(state.history) + 1);
    state.records = records;
  };
  return { store, mail, push, app, get, mutate, state, log, notify, fakeReply, advance };
}
it("rejects a bad token, acknowledges garbage and unknown accounts, and persists valid hints before the ack", async () => {
  const { app, push, store, notify } = await setup();
  const bad = await app.inject({ method: "POST", url: "/gmail/push?token=wrong", payload: {} });
  expect(bad.statusCode).toBe(401);
  expect(push.counters.rejected).toBe(1);
  const garbage = await app.inject({
    method: "POST",
    url: "/gmail/push?token=" + TOKEN,
    payload: { message: { data: "not-base64-json" } },
  });
  expect(garbage.statusCode).toBe(204);
  const stranger = await notify("stranger@example.test", "5");
  expect(stranger.statusCode).toBe(204);
  expect(push.counters.ignored).toBe(2);
  expect(store.pushStats().notifications).toBe(0);
  const ok = await notify(email, "11");
  expect(ok.statusCode).toBe(204);
  expect(store.pushStats().notifications).toBe(1);
  expect(store.pushRecord(email, "11")).toBe(false);
  expect(store.pushRecord(email, "12")).toBe(true);
});
it("coalesces bursts into one sync and publishes a StateChange to open streams only when state moved", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
  const { mail, push, notify, get, fakeReply, advance, store } = await setup();
  await mail.profile();
  const reads = () => get.mock.calls.filter((c) => c[0] === "history").length;
  const initial = reads();
  const stream = fakeReply();
  push.addStream(email, stream.reply, null, { types: null });
  expect(stream.written[0]).toContain("connected");
  advance([{ id: "11", messagesAdded: [{ message: { id: "new1", threadId: "t1", labelIds: ["INBOX"] } }] }]);
  await notify(email, "11");
  await notify(email, "11");
  await notify(email, "11");
  expect(reads()).toBe(initial);
  await vi.advanceTimersByTimeAsync(2_000);
  expect(reads()).toBe(initial + 1); // one history read for three notifications
  expect(store.cursor(email)).toBe("11");
  const events = stream.written.filter((s) => s.startsWith("event: state"));
  expect(events).toHaveLength(1);
  const change = JSON.parse(events[0]!.split("data: ")[1]!);
  expect(change["@type"]).toBe("StateChange");
  expect(Object.keys(change.changed)).toEqual([mail.accountId]);
  expect(change.changed[mail.accountId].Email).toMatch(/^g11/);
  // Same history again: sync runs, nothing changed, nothing published.
  await notify(email, "11");
  await vi.advanceTimersByTimeAsync(2_000);
  expect(stream.written.filter((s) => s.startsWith("event: state"))).toHaveLength(1);
  expect(push.counters.changesPublished).toBe(1);
  stream.close();
  advance([]);
  await notify(email, "12");
  await vi.advanceTimersByTimeAsync(2_000);
  expect(store.cursor(email)).toBe("12");
  expect(push.counters.changesPublished).toBe(1);
});
it("configures authenticated push from an audience and service account", async () => {
  const { loadGmailConfig } = await import("../../src/gmail/config.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gmail-push-config-"));
  const file = path.join(dir, "oauth.json");
  fs.writeFileSync(file, JSON.stringify({ web: { client_id: "id", client_secret: "secret" } }));
  try {
    vi.stubEnv("GMAIL_OAUTH_CLIENT_FILE", file);
    vi.stubEnv("GMAIL_ALLOWED_EMAILS", email);
    vi.stubEnv("GMAIL_PUSH_TOPIC", PUSH.topic);
    vi.stubEnv("GMAIL_PUSH_TOKEN", "");
    vi.stubEnv("GMAIL_PUSH_AUDIENCE", "https://bridge.test/gmail/push");
    vi.stubEnv("GMAIL_PUSH_SERVICE_ACCOUNT", "");
    expect(() => loadGmailConfig("https://bridge.test")).toThrow("GMAIL_PUSH_SERVICE_ACCOUNT");
    vi.stubEnv("GMAIL_PUSH_SERVICE_ACCOUNT", "Push@Project.iam.gserviceaccount.com");
    expect(loadGmailConfig("https://bridge.test")?.push).toEqual({
      topic: PUSH.topic,
      audience: "https://bridge.test/gmail/push",
      serviceAccount: "push@project.iam.gserviceaccount.com",
    });
    vi.stubEnv("GMAIL_PUSH_AUDIENCE", "");
    expect(() => loadGmailConfig("https://bridge.test")).toThrow("GMAIL_PUSH_TOKEN");
  } finally {
    vi.unstubAllEnvs();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
it("accepts authenticated Pub/Sub push only from the configured service account", async () => {
  const { store, mail } = await setup();
  const audience = "https://bridge.test/gmail/push";
  const serviceAccount = "push@project.iam.gserviceaccount.com";
  const verifier = {
    verifyIdToken: vi.fn(async (options: { idToken: string; audience: string }) => {
      if (options.audience !== audience || !options.idToken.startsWith("signed-"))
        throw new Error("bad token");
      return {
        getPayload: () => ({
          email: options.idToken === "signed-by-pubsub" ? serviceAccount : "someone@else.test",
          email_verified: true,
        }),
      };
    }),
  };
  const log = { warn: vi.fn(), error: vi.fn(), info: vi.fn() } as any;
  const push = new GmailPush(
    store,
    () => mail,
    new Set([email]),
    { topic: PUSH.topic, audience, serviceAccount },
    log,
    verifier,
  );
  cleanup.push(() => push.stop());
  const app = Fastify();
  cleanup.push(() => {
    void app.close();
  });
  app.post("/gmail/push", async (req, reply) => push.receive(req, reply));
  const payload = {
    message: {
      data: Buffer.from(JSON.stringify({ emailAddress: email, historyId: "11" })).toString("base64"),
    },
  };
  const send = (headers: Record<string, string>, url = "/gmail/push") =>
    app.inject({ method: "POST", url, headers, payload });
  expect((await send({}, "/gmail/push?token=" + TOKEN)).statusCode).toBe(401);
  expect((await send({ authorization: "Bearer forged" })).statusCode).toBe(401);
  expect((await send({ authorization: "Bearer signed-by-someone-else" })).statusCode).toBe(401);
  expect(store.pushStats().notifications).toBe(0);
  expect((await send({ authorization: "Bearer signed-by-pubsub" })).statusCode).toBe(204);
  expect(store.pushStats().notifications).toBe(1);
  expect(push.counters.rejected).toBe(3);
});
it("renews the watch with a read-only grant", async () => {
  const { GmailApi } = await import("../../src/gmail/api.js");
  const { GMAIL_READONLY } = await import("../../src/gmail/config.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gmail-push-ro-"));
  const store = new GmailStore(dir, crypto.randomBytes(32));
  cleanup.push(() => {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  await store.save(
    email,
    { mech: "XOAUTH2", username: email, refreshToken: "refresh", scopes: [GMAIL_READONLY] },
    { profile: { emailAddress: email, historyId: "10", messagesTotal: 1, threadsTotal: 1 }, labels },
  );
  const request = vi.fn(async () => ({
    data: { historyId: "10", expiration: String(Date.now() + 7 * 86400_000) },
  }));
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
    { config: { writeEnabled: false }, createClient: () => client } as any,
    store,
  );
  const mail = new GmailMail(email, api, store);
  await expect(mail.watch(PUSH.topic)).resolves.toMatchObject({ history: "10" });
  expect(request).toHaveBeenCalledTimes(1);
  await expect(api.mutate("labels", 5, "POST", { name: "x" })).rejects.toMatchObject({
    type: "accountReadOnly",
  });
});
it("renews the watch daily, records failures and retries on the next check", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
  const { push, store, mutate, state, log } = await setup();
  push.start();
  await vi.advanceTimersByTimeAsync(10);
  expect(mutate.mock.calls.filter((c) => c[0] === "watch")).toHaveLength(1);
  expect(mutate.mock.calls[0]![3]).toEqual({ topicName: PUSH.topic, labelFilterBehavior: "INCLUDE" });
  const first = store.watch(email)!;
  expect(first.expiration).toBeGreaterThan(Date.now());
  expect(first.failures).toBe(0);
  await vi.advanceTimersByTimeAsync(6 * 60 * 60_000);
  expect(mutate.mock.calls.filter((c) => c[0] === "watch")).toHaveLength(1);
  state.watchError = new JmapError("serverUnavailable");
  await vi.advanceTimersByTimeAsync(18 * 60 * 60_000);
  // Renewal is due after 24 h; a failed attempt is retried at every hourly check until it succeeds.
  const failed = mutate.mock.calls.filter((c) => c[0] === "watch").length;
  expect(failed).toBe(2);
  expect(store.watch(email)!.failures).toBe(1);
  expect(log.warn).toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(60 * 60_000);
  expect(store.watch(email)!.failures).toBe(2);
  state.watchError = null;
  await vi.advanceTimersByTimeAsync(60 * 60_000);
  expect(mutate.mock.calls.filter((c) => c[0] === "watch")).toHaveLength(failed + 2);
  expect(store.watch(email)!.failures).toBe(0);
  await vi.advanceTimersByTimeAsync(60 * 60_000);
  expect(mutate.mock.calls.filter((c) => c[0] === "watch")).toHaveLength(failed + 2);
  expect(push.stats()).toMatchObject({ watches: 1, watchFailures: 0, openStreams: 0 });
});
it("advertises the event source and serves it only when push is configured", async () => {
  const { store, mail } = await setup();
  for (const configured of [true, false]) {
    const lines: string[] = [];
    const app = Fastify({
      logger: {
        level: "info",
        stream: {
          write: (l: string) => {
            lines.push(l);
          },
        },
      },
    });
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
        ...(configured ? { push: PUSH } : {}),
      } as any,
      store,
      {} as any,
      () => mail,
    );
    const auth = {
      authorization: "Basic " + Buffer.from(email + ":" + store.issuePassword(email)).toString("base64"),
    };
    const session = (await app.inject({ method: "GET", url: "/jmap/session", headers: auth })).json();
    expect(session.eventSourceUrl).toBe(
      configured
        ? "https://bridge.test/jmap/eventsource?types={types}&closeafter={closeafter}&ping={ping}"
        : undefined,
    );
    const unauth = await app.inject({ method: "POST", url: "/gmail/push?token=" + TOKEN, payload: {} });
    expect(unauth.statusCode).toBe(configured ? 204 : 404);
    expect(lines.join("")).not.toContain(TOKEN); // the token must never reach request logs
    if (!configured) {
      const es = await app.inject({ method: "GET", url: "/jmap/eventsource", headers: auth });
      expect(es.statusCode).toBe(404);
    }
    await app.close();
  }
});
