// An event stream belongs to the session it was opened with: it ends when the
// session ends (sign-out, or the password behind it replaced) and gets no
// state changes after that. Streams of sessions that stay valid keep going.

import fs from "node:fs";
import http from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { bootProxy, startFakeImap, type FakeImap } from "./fake-imap.js";

let imap: FakeImap;
let app: FastifyInstance;
let dir: string;
let base = "";
beforeAll(async () => {
  imap = await startFakeImap({});
  ({ app, dir } = await bootProxy(imap));
  await app.listen({ port: 0, host: "127.0.0.1" }).catch(() => {});
  const addr = app.server.address() as { port: number };
  base = `http://127.0.0.1:${addr.port}`;
}, 60_000);
afterAll(async () => {
  await app.close();
  await imap.close();
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* left for the OS temp cleanup */
  }
});

const login = async (username: string, password: string) => {
  const res = await app.inject({ method: "POST", url: "/api/login", payload: { username, password } });
  expect(res.statusCode).toBe(200);
  return res.json() as { token: string; accountId: string };
};
const settle = (ms = 300) => new Promise((r) => setTimeout(r, ms));

/** An event stream over a real socket: what it received and whether the server ended it. */
function openStream(authorization: string) {
  const stream = { text: "", ended: false, close: () => {} };
  const req = http.get(`${base}/jmap/eventsource?types=*&ping=300`, { headers: { authorization } }, (res) => {
    res.on("data", (c) => (stream.text += c.toString()));
    res.on("end", () => (stream.ended = true));
  });
  req.on("error", () => {});
  stream.close = () => req.destroy();
  return stream;
}
async function changeIdentity(token: string, accountId: string, name: string) {
  const set = await app.inject({
    method: "POST",
    url: "/jmap",
    headers: { authorization: `Bearer ${token}` },
    payload: {
      using: ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail", "urn:ietf:params:jmap:submission"],
      methodCalls: [["Identity/set", { accountId, update: { [`i-${accountId}`]: { name } } }, "0"]],
    },
  });
  expect(set.statusCode).toBe(200);
  expect(set.body).toContain(`"updated":{"i-${accountId}"`);
}

describe("an event stream of a session that ends", () => {
  it("is closed, or at least gets no more state changes, once the owner signs in with a new password", async () => {
    imap.users["zoe@test.local"] = "old-password";
    const old = await login("zoe@test.local", "old-password");
    const stream = openStream(`Bearer ${old.token}`);
    await settle();
    expect(stream.text).toContain("connected");

    // The password changes at the server; the owner signs in with the new one.
    imap.users["zoe@test.local"] = "new-password";
    const mine = await login("zoe@test.local", "new-password");
    await settle();
    expect((await app.inject({ method: "GET", url: "/jmap/session", headers: { authorization: `Bearer ${old.token}` } })).statusCode).toBe(401);

    // Control: a stream of the owner's new session, which must get the change.
    const control = openStream(`Bearer ${mine.token}`);
    await settle();
    const before = stream.text.length;
    await changeIdentity(mine.token, mine.accountId, "After the change");
    await settle(1500);
    stream.close();
    control.close();
    expect(control.text).toContain("event: state");
    expect(stream.text.slice(before)).not.toContain("event: state");
    expect(stream.ended).toBe(true);
  }, 30_000);

  it("is closed by /api/logout with its token, and the account's other streams stay open", async () => {
    imap.users["yan@test.local"] = "pw";
    const a = await login("yan@test.local", "pw");
    const b = await login("yan@test.local", "pw");
    const streamA = openStream(`Bearer ${a.token}`);
    const streamB = openStream(`Bearer ${b.token}`);
    await settle();
    expect((await app.inject({ method: "POST", url: "/api/logout", headers: { authorization: `Bearer ${a.token}` } })).statusCode).toBe(204);
    await settle();
    await changeIdentity(b.token, b.accountId, "After the sign-out");
    await settle(1500);
    streamA.close();
    streamB.close();
    expect(streamA.ended).toBe(true);
    expect(streamA.text).not.toContain("event: state");
    expect(streamB.ended).toBe(false);
    expect(streamB.text).toContain("event: state");
  }, 30_000);

  it("is closed when the generation moves without a check, and a stream of the new password stays", async () => {
    imap.users["xia@test.local"] = ["pw-1", "pw-2"];
    const first = await login("xia@test.local", "pw-1");
    const streamFirst = openStream(`Bearer ${first.token}`);
    await settle();
    // The stored credentials can't be opened any more (another vault key wrote them): the next
    // sign-in replaces them at once, without a check, and the generation moves.
    const { Store } = await import("../../src/state/store.js");
    const other = new Store(dir);
    try {
      other.db.prepare("UPDATE account SET vault = ? WHERE slug = ?").run(Buffer.alloc(48, 1), "generic:xia@test.local");
    } finally {
      other.close();
    }
    const second = await login("xia@test.local", "pw-2");
    const streamSecond = openStream(`Bearer ${second.token}`);
    await settle();
    await changeIdentity(second.token, second.accountId, "After the replacement");
    await settle(1500);
    streamFirst.close();
    streamSecond.close();
    expect(streamFirst.ended).toBe(true);
    expect(streamFirst.text).not.toContain("event: state");
    expect(streamSecond.ended).toBe(false);
    expect(streamSecond.text).toContain("event: state");
  }, 30_000);
});
