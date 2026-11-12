// The push IDLE worker and open event streams (#41): an account with no push
// subscription gets its INBOX watched while a client has /jmap/eventsource open,
// so new mail reaches the stream. The worker stays for a grace period after the
// last stream closes, and a reconnect within it reuses the same IMAP login.

import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/imap/client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/imap/client.js")>()),
  openImap: vi.fn(),
}));

import { openImap } from "../../src/imap/client.js";
import { Store, type AccountRow } from "../../src/state/store.js";
import { PushIdleManager } from "../../src/push/idle.js";
import { EventSourceHub } from "../../src/jmap/eventsource.js";
import { sealCredentials, sealPlace } from "../../src/auth/credentials.js";
import type { AppConfig } from "../../src/util/config.js";

const vaultKey = crypto.randomBytes(32);
const cfg = {
  vaultKey,
  defaultProvider: "generic",
  providers: {
    generic: {
      imap: { host: "imap.test", port: 993 },
      smtp: { host: "smtp.test", port: 587 },
      sieve: null,
      carddav: null,
      auth: { mech: ["PLAIN"] },
    },
  },
} as unknown as AppConfig;

const GRACE_MS = 60_000;

/** Enough of a Fastify reply for the hub. */
function fakeReply() {
  const raw = Object.assign(new EventEmitter(), {
    setHeader() {},
    write() {
      return true;
    },
    end() {
      this.emit("close");
    },
  });
  return { raw } as unknown as import("fastify").FastifyReply & { raw: typeof raw };
}

/** An ImapFlow stand-in that records its `exists` handler and its logout. */
function imapClient() {
  const handlers = new Map<string, (ev: unknown) => void>();
  return {
    handlers,
    on: vi.fn((event: string, fn: (ev: unknown) => void) => handlers.set(event, fn)),
    mailboxOpen: vi.fn(async () => ({})),
    noop: vi.fn(async () => {}),
    logout: vi.fn(async () => {}),
  };
}

let dir: string;
let store: Store;
let account: AccountRow;
const dirs: string[] = [];

beforeEach(async () => {
  vi.useFakeTimers();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "legacy-proxy-idle-streams-"));
  dirs.push(dir);
  store = new Store(dir);
  const username = "u@test.local";
  account = store.upsertAccount({
    slug: `generic:${username}`,
    kind: "generic",
    host: "imap.test",
    username,
    vault: await sealCredentials(vaultKey, sealPlace.account(`generic:${username}`), { mech: "PLAIN", username, password: "pw" }),
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.mocked(openImap).mockReset();
  store.close();
});
afterAll(() => {
  for (const each of dirs) {
    try {
      fs.rmSync(each, { recursive: true, force: true });
    } catch {
      /* left for the OS temp cleanup */
    }
  }
});

function setup() {
  const clients: ReturnType<typeof imapClient>[] = [];
  vi.mocked(openImap).mockImplementation(async () => {
    const c = imapClient();
    clients.push(c);
    return c as never;
  });
  const hub = new EventSourceHub();
  const idle = new PushIdleManager(cfg, store, hub, GRACE_MS);
  hub.setStreamsListener(idle.onStreamsChange);
  return { hub, idle, clients };
}

describe("the IDLE worker of an account without a push subscription", () => {
  it("starts while an event stream is open and turns new mail into a state change on it", async () => {
    const { hub, idle, clients } = setup();
    await idle.sync();
    await vi.advanceTimersByTimeAsync(10);
    expect(openImap).not.toHaveBeenCalled();

    const reply = fakeReply();
    const written: string[] = [];
    reply.raw.write = (chunk: string) => {
      written.push(chunk);
      return true;
    };
    hub.add(account, reply, null, { pingSec: 300 });
    store.setStateListener((id, kind) => {
      if (id === account.id && kind === "email") {
        hub.publish(account, { "@type": "StateChange", changed: { [String(id)]: { Email: "s" } } });
      }
    });
    await vi.advanceTimersByTimeAsync(10);
    expect(openImap).toHaveBeenCalledTimes(1);
    expect(clients[0].mailboxOpen).toHaveBeenCalledWith("INBOX");

    clients[0].handlers.get("exists")!({ count: 2, prevCount: 1 });
    expect(written.some((w) => w.startsWith("event: state"))).toBe(true);

    reply.raw.end();
    await idle.closeAll();
  });

  it("stops after the grace period once the last stream closed", async () => {
    const { hub, idle, clients } = setup();
    const a = fakeReply();
    const b = fakeReply();
    hub.add(account, a, null, { pingSec: 300 });
    hub.add(account, b, null, { pingSec: 300 });
    await vi.advanceTimersByTimeAsync(10);
    expect(openImap).toHaveBeenCalledTimes(1);

    a.raw.end();
    b.raw.end();
    await vi.advanceTimersByTimeAsync(GRACE_MS - 1_000);
    expect(clients[0].logout).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(2_000);
    expect(clients[0].logout).toHaveBeenCalledTimes(1);
    await idle.closeAll();
  });

  it("keeps the same IMAP login when the client reconnects within the grace period", async () => {
    const { hub, idle, clients } = setup();
    // closeafter=state: the stream ends after every event and the client opens a new one.
    for (let i = 0; i < 5; i++) {
      const r = fakeReply();
      hub.add(account, r, null, { pingSec: 300, closeAfter: true });
      await vi.advanceTimersByTimeAsync(10);
      r.raw.end();
      await vi.advanceTimersByTimeAsync(GRACE_MS / 2);
    }
    expect(openImap).toHaveBeenCalledTimes(1);
    expect(clients[0].logout).not.toHaveBeenCalled();
    await idle.closeAll();
  });
});
