// A push URL is checked once, and the POST goes to the address that was
// checked: the dispatcher does not resolve the name a second time when it
// connects. Only https is accepted unless PUSH_ALLOW_PRIVATE_URLS=1, and the
// same check runs when a subscription is created. Every socket is watched (see
// push-sockets.ts): a connection to loopback goes through and is counted,
// anything else is stopped before a packet leaves.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Store, type AccountRow, type PushSubscriptionRow } from "../../src/state/store.js";
import { EventSourceHub } from "../../src/jmap/eventsource.js";
import { PushDispatcher } from "../../src/push/dispatcher.js";
import { pushSubscriptionSet } from "../../src/jmap/methods/push.js";
import { isPrivateAddress } from "../../src/util/pushTarget.js";
import { log } from "../../src/util/log.js";
import {
  PUBLIC,
  attempted,
  isLoopback,
  notFoundError,
  resolveTo,
  startLocalServer,
  watchSockets,
  type LocalServer,
} from "./push-sockets.js";

let internal: LocalServer;
let dir: string;
let store: Store;
let account: AccountRow;

beforeAll(async () => {
  delete process.env.PUSH_ALLOW_PRIVATE_URLS;
  internal = await startLocalServer();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "lproxy-push-"));
  store = new Store(dir);
  account = store.upsertAccount({ slug: "generic:u", kind: "generic", host: "h", username: "u", vault: Buffer.from("x") });
});

beforeEach(() => {
  internal.connections = 0;
  internal.requests.length = 0;
  attempted.length = 0;
});
afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.PUSH_ALLOW_PRIVATE_URLS;
});
afterAll(async () => {
  await internal.close();
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const sub = (url: string): PushSubscriptionRow => ({
  id: "sub-1",
  accountId: account.id,
  deviceClientId: null,
  url,
  types: null,
  expires: Date.now() + 60_000,
  verificationCode: "code",
  verified: false,
  createdAt: Date.now(),
  lastPushAt: null,
});

const settle = () => new Promise((r) => setTimeout(r, 300));
const dispatcher = () => new PushDispatcher(store, new EventSourceHub(), () => account);

describe("a push goes to the address that was checked", () => {
  for (const scheme of ["https", "http"] as const) {
    it(`${scheme}: a name that answers with a public address for the check and loopback for the connect reaches nothing local`, async () => {
      resolveTo(PUBLIC, "127.0.0.1");
      watchSockets();
      await dispatcher().sendVerification(sub(`${scheme}://rebind.attacker.example:${internal.port}/hook`)).catch(() => undefined);
      await settle();
      expect(internal.connections, "the internal service got a connection").toBe(0);
      expect(attempted.filter(isLoopback), "a socket was opened to loopback").toEqual([]);
      // If it tried at all, then only the address it had checked.
      expect(attempted.every((address) => address === PUBLIC), `connected to ${attempted.join(", ")}`).toBe(true);
    });
  }

  it("https: opens its connection to the checked address", async () => {
    resolveTo(PUBLIC, "127.0.0.1");
    watchSockets();
    await dispatcher().sendVerification(sub(`https://rebind.attacker.example:${internal.port}/hook`)).catch(() => undefined);
    await settle();
    expect(attempted).toEqual([PUBLIC]);
  });

  it("a name that does not resolve for the check is not posted to", async () => {
    resolveTo(notFoundError(), "127.0.0.1");
    watchSockets();
    await dispatcher().sendVerification(sub(`https://later.attacker.example:${internal.port}/hook`)).catch(() => undefined);
    await settle();
    expect(internal.connections).toBe(0);
    expect(attempted).toEqual([]);
  });

  it("a name whose checked address is private is not posted to", async () => {
    resolveTo("10.0.0.5", "10.0.0.5");
    watchSockets();
    await dispatcher().sendVerification(sub("https://intranet.attacker.example/hook")).catch(() => undefined);
    await settle();
    expect(attempted).toEqual([]);
  });

  it("a name with both a public and a private answer is not posted to", async () => {
    resolveTo([PUBLIC, "127.0.0.1"], "127.0.0.1");
    watchSockets();
    await dispatcher().sendVerification(sub(`https://mixed.attacker.example:${internal.port}/hook`)).catch(() => undefined);
    await settle();
    expect(internal.connections).toBe(0);
    expect(attempted).toEqual([]);
  });

  it("connects to the checked address and still sends the host name", async () => {
    // A test rig: private addresses and http allowed, so the checked address can be loopback.
    process.env.PUSH_ALLOW_PRIVATE_URLS = "1";
    resolveTo("127.0.0.1", "10.9.9.9");
    watchSockets();
    await dispatcher().sendVerification(sub(`http://relay.rig.test:${internal.port}/push/abc`));
    await settle();
    expect(attempted).toEqual(["127.0.0.1"]);
    expect(internal.requests).toHaveLength(1);
    expect(internal.requests[0]).toMatchObject({
      method: "POST",
      url: "/push/abc",
      host: `relay.rig.test:${internal.port}`,
      kind: "PushVerification",
    });
    expect(JSON.parse(internal.requests[0]!.body)).toMatchObject({ "@type": "PushVerification", verificationCode: "code" });
  });

  it("does not follow a redirect", async () => {
    process.env.PUSH_ALLOW_PRIVATE_URLS = "1";
    const redirecting = await startLocalServer((res) =>
      res.writeHead(307, { location: `http://127.0.0.1:${internal.port}/elsewhere` }).end(),
    );
    try {
      await dispatcher().sendVerification(sub(`http://127.0.0.1:${redirecting.port}/hook`));
      await settle();
      expect(redirecting.requests).toHaveLength(1);
      expect(internal.connections).toBe(0);
    } finally {
      await redirecting.close();
    }
  });

  it("logs the host of a failed delivery, not its URL", async () => {
    const warn = vi.spyOn(log, "warn");
    resolveTo(PUBLIC, PUBLIC);
    watchSockets();
    await dispatcher().sendVerification(sub("https://relay.example.org/api/push/jmap/SECRET-DEVICE-TOKEN")).catch(() => undefined);
    await settle();
    const logged = JSON.stringify(warn.mock.calls);
    expect(logged).not.toContain("SECRET-DEVICE-TOKEN");
    expect(logged).toContain("relay.example.org");
  });
});

describe("what a push subscription may point at when it is created", () => {
  const create = (url: string) =>
    pushSubscriptionSet(
      { create: { c: { deviceClientId: "d", url } } },
      {
        account,
        store,
        dispatcher: { sendVerification: async () => {}, notifySubscriberChange: () => {} } as never,
      },
    );

  it("refuses a plain http push URL", async () => {
    resolveTo(PUBLIC, PUBLIC);
    const res = await create("http://relay.example.org/push/abc");
    expect(res.created).toBeNull();
    expect(res.notCreated?.c?.type).toBe("invalidProperties");
  });

  it("refuses a loopback or private address, written as a literal", async () => {
    for (const url of [
      "https://127.0.0.1/x",
      "https://[::1]/x",
      "https://10.0.0.5/x",
      "https://169.254.169.254/latest/meta-data/",
      "https://[::ffff:10.0.0.5]/x",
      "https://[::ffff:a00:5]/x",
      "https://[64:ff9b::a00:5]/x",
      "https://0.0.0.0/x",
    ]) {
      const res = await create(url);
      expect(res.created, url).toBeNull();
      expect(res.notCreated?.c?.type, url).toBe("invalidProperties");
    }
  });

  it("refuses a name that resolves to a private address, and one that does not resolve", async () => {
    resolveTo("192.168.1.20", "192.168.1.20");
    expect((await create("https://printer.attacker.example/x")).created).toBeNull();
    vi.restoreAllMocks();
    resolveTo(notFoundError(), PUBLIC);
    expect((await create("https://nowhere.attacker.example/x")).created).toBeNull();
  });

  it("refuses a name with both a public and a private answer", async () => {
    resolveTo([PUBLIC, "10.0.0.5"], PUBLIC);
    const res = await create("https://mixed.attacker.example/x");
    expect(res.created).toBeNull();
    expect(res.notCreated?.c).toMatchObject({ type: "invalidProperties", properties: ["url"] });
  });

  it("refuses a URL with a user name in it", async () => {
    resolveTo(PUBLIC, PUBLIC);
    expect((await create("https://user:pass@relay.example.org/x")).created).toBeNull();
  });

  it("still takes an https URL on a public address", async () => {
    resolveTo(PUBLIC, PUBLIC);
    const res = await create("https://relay.example.org/api/push/jmap/abcdef0123456789");
    expect(res.notCreated ?? null).toBeNull();
    expect(Object.keys(res.created ?? {})).toEqual(["c"]);
  });

  it("takes an http URL on a private network with PUSH_ALLOW_PRIVATE_URLS=1", async () => {
    process.env.PUSH_ALLOW_PRIVATE_URLS = "1";
    const res = await create("http://10.0.0.5:8080/push/abc");
    expect(res.notCreated ?? null).toBeNull();
    expect(Object.keys(res.created ?? {})).toEqual(["c"]);
  });
});

describe("isPrivateAddress", () => {
  it.each([
    "192.0.2.1",
    "198.18.0.1",
    "203.0.113.9",
    "224.0.0.1",
    "255.255.255.255",
    "ff02::1",
    "2001:db8::1",
    "fec0::1",
    "::ffff:a00:5",
    "64:ff9b::a00:5",
    "64:ff9b::10.0.0.5",
    "not-an-address",
  ])("treats %s as not public", (a) => expect(isPrivateAddress(a)).toBe(true));

  it.each(["93.184.216.34", "2606:4700::1111", "::ffff:5db8:d822", "64:ff9b::5db8:d822"])("treats %s as public", (a) =>
    expect(isPrivateAddress(a)).toBe(false),
  );
});
