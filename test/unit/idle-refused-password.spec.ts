// The push IDLE worker and a mail server that refuses the stored password: after the server says
// the credentials are wrong, the worker makes at most 3 attempts in all, however long it waits,
// and comes back after the next successful login. A server that can't be reached, or asks to try
// again later, is still retried with backoff.
//
// The real IMAP client module is kept; only openImap is replaced.

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
import { Store } from "../../src/state/store.js";
import { PushIdleManager } from "../../src/push/idle.js";
import { sealCredentials } from "../../src/auth/credentials.js";
import type { AppConfig } from "../../src/util/config.js";

/** What imapflow throws for a tagged NO [AUTHENTICATIONFAILED]. */
function refused(): never {
  const err = new Error("Command failed") as Error & Record<string, unknown>;
  err.authenticationFailed = true;
  err.serverResponseCode = "AUTHENTICATIONFAILED";
  err.responseStatus = "NO";
  throw err;
}

/** What a server that is down looks like. */
function unreachable(): never {
  const err = new Error("connect ECONNREFUSED 192.0.2.1:993") as Error & Record<string, unknown>;
  err.code = "ECONNREFUSED";
  throw err;
}

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

// A store of its own per test: one account with one verified push subscription.
let dir: string;
let store: Store;
const dirs: string[] = [];

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "legacy-proxy-idle-"));
  dirs.push(dir);
  store = new Store(dir);
  const username = "u@test.local";
  const account = store.upsertAccount({
    slug: `generic:${username}`,
    kind: "generic",
    host: "imap.test",
    username,
    vault: await sealCredentials(vaultKey, { mech: "PLAIN", username, password: "replaced-long-ago" }),
  });
  store.insertPushSubscription({
    id: "s1",
    accountId: account.id,
    deviceClientId: null,
    url: "https://relay.example/x",
    types: null,
    expires: Date.now() + 365 * 86400_000,
    verificationCode: null,
    verified: true,
    createdAt: Date.now(),
    lastPushAt: null,
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

async function attemptsOver(hours: number): Promise<number> {
  vi.useFakeTimers();
  const idle = new PushIdleManager(cfg, store);
  await idle.sync();
  await vi.advanceTimersByTimeAsync(hours * 3600_000);
  const attempts = vi.mocked(openImap).mock.calls.length;
  await idle.closeAll();
  return attempts;
}

describe("the IDLE worker and a mail server that refuses the stored password", () => {
  it("stops logging in once the server says the credentials are wrong", async () => {
    vi.mocked(openImap).mockImplementation(async () => refused());
    expect(await attemptsOver(6)).toBeLessThanOrEqual(3);
  });

  it("keeps trying a server it can't reach", async () => {
    vi.mocked(openImap).mockImplementation(async () => unreachable());
    // One a minute once the backoff is at its ceiling: an hour is dozens of attempts.
    expect(await attemptsOver(1)).toBeGreaterThanOrEqual(20);
  });
});

/** What imapflow throws for a tagged NO [UNAVAILABLE]: the server asks to try again later. */
function tryLater(): never {
  const err = new Error("Command failed") as Error & Record<string, unknown>;
  err.authenticationFailed = true;
  err.serverResponseCode = "UNAVAILABLE";
  err.responseStatus = "NO";
  throw err;
}

/** Enough of an ImapFlow client for the worker to hold INBOX open. */
function connected() {
  return {
    on: vi.fn(),
    mailboxOpen: vi.fn(async () => ({})),
    noop: vi.fn(async () => {}),
    logout: vi.fn(async () => {}),
  } as never;
}

const accountId = () => store.getAccount("generic:u@test.local")!.id;

describe("what the refused mark keeps and what clears it", () => {
  it("treats 'try again later' like a server it can't reach", async () => {
    vi.mocked(openImap).mockImplementation(async () => tryLater());
    expect(await attemptsOver(1)).toBeGreaterThanOrEqual(20);
  });

  it("counts one worker for an account with two subscriptions", async () => {
    store.insertPushSubscription({
      id: "s2",
      accountId: accountId(),
      deviceClientId: null,
      url: "https://relay.example/y",
      types: null,
      expires: Date.now() + 365 * 86400_000,
      verificationCode: null,
      verified: true,
      createdAt: Date.now(),
      lastPushAt: null,
    });
    vi.mocked(openImap).mockImplementation(async () => refused());
    expect(await attemptsOver(6)).toBeLessThanOrEqual(3);
  });

  it("spreads its three tries over five minutes before the mark is set", async () => {
    vi.mocked(openImap).mockImplementation(async () => refused());
    vi.useFakeTimers();
    const idle = new PushIdleManager(cfg, store);
    await idle.sync();
    await vi.advanceTimersByTimeAsync(4 * 60_000);
    // A refusal that lasts a few minutes is not enough.
    expect(vi.mocked(openImap).mock.calls.length).toBe(2);
    expect(store.getAccountById(accountId())!.cred_refused).toBe(0);
    await vi.advanceTimersByTimeAsync(2 * 60_000);
    expect(vi.mocked(openImap).mock.calls.length).toBe(3);
    expect(store.getAccountById(accountId())!.cred_refused).toBe(1);
    await idle.closeAll();
  });

  it("does not count Stalwart's answer to a store error", async () => {
    vi.mocked(openImap).mockImplementation(async () => {
      const err = new Error("Command failed") as Error & Record<string, unknown>;
      err.authenticationFailed = true;
      err.serverResponseCode = "CONTACTADMIN";
      throw err;
    });
    expect(await attemptsOver(1)).toBeGreaterThanOrEqual(20);
    expect(store.getAccountById(accountId())!).toMatchObject({ cred_refused: 0, cred_refusals: 0 });
  });

  it("keeps the mark across a restart of the proxy", async () => {
    vi.mocked(openImap).mockImplementation(async () => refused());
    await attemptsOver(1);
    vi.mocked(openImap).mockClear();
    store.close();
    store = new Store(dir);
    expect(store.getAccountById(accountId())!.cred_refused).toBe(1);
    // Even a subscription of the account gets no worker while the mark stands.
    subscribeAgain("s4");
    expect(await attemptsOver(6)).toBe(0);
  });

  it("brings the worker back after a successful login, without a restart", async () => {
    vi.mocked(openImap).mockImplementation(async () => refused());
    vi.useFakeTimers();
    const idle = new PushIdleManager(cfg, store);
    store.setCredentialListener((id) => idle.onCredentialsChanged(id));
    await idle.sync();
    await vi.advanceTimersByTimeAsync(3600_000);
    expect(vi.mocked(openImap).mock.calls.length).toBe(3);

    // The mark moved the credential generation, which ended the subscription.
    expect(store.listPushSubscriptions(accountId())).toEqual([]);

    // The user signs in with the password the server accepts now, and the
    // client subscribes again.
    vi.mocked(openImap).mockImplementation(async () => connected());
    store.upsertAccount({
      slug: "generic:u@test.local",
      kind: "generic",
      host: "imap.test",
      username: "u@test.local",
      vault: await sealCredentials(vaultKey, { mech: "PLAIN", username: "u@test.local", password: "the-new-one" }),
      rotate: true,
    });
    subscribeAgain("s3");
    idle.onSubscriberChange(accountId());
    await vi.advanceTimersByTimeAsync(1_000);
    expect(vi.mocked(openImap).mock.calls.length).toBe(4);
    expect(vi.mocked(openImap).mock.calls[3]![0].creds.password).toBe("the-new-one");
    await idle.closeAll();
  });

  it("stops the worker of a subscription made before the password was replaced", async () => {
    vi.mocked(openImap).mockImplementation(async () => connected());
    vi.useFakeTimers();
    const idle = new PushIdleManager(cfg, store);
    store.setCredentialListener((id) => idle.onCredentialsChanged(id));
    await idle.sync();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(vi.mocked(openImap).mock.calls.length).toBe(1);

    // A sign-in replaces the stored password.
    store.upsertAccount({
      slug: "generic:u@test.local",
      kind: "generic",
      host: "imap.test",
      username: "u@test.local",
      vault: await sealCredentials(vaultKey, { mech: "PLAIN", username: "u@test.local", password: "the-new-one" }),
      rotate: true,
    });
    await vi.advanceTimersByTimeAsync(3600_000);
    expect(store.listPushSubscriptions(accountId())).toEqual([]);
    expect(store.accountsWithActivePushSubs()).toEqual([]);
    expect(vi.mocked(openImap).mock.calls.length).toBe(1);
    await idle.closeAll();
  });
});

function subscribeAgain(id: string) {
  store.insertPushSubscription({
    id,
    accountId: accountId(),
    deviceClientId: null,
    url: "https://relay.example/" + id,
    types: null,
    expires: Date.now() + 365 * 86400_000,
    verificationCode: null,
    verified: true,
    createdAt: Date.now(),
    lastPushAt: null,
  });
}
