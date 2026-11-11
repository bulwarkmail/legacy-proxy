// A /jmap body that is not a JMAP Request object (RFC 8620 §3.3) is answered
// with the notRequest problem, not with a server error.

import fs from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { dispatch, isRequestEnvelope } from "../../src/jmap/router.js";
import { bootProxy, startFakeImap, type FakeImap } from "./sec-fake-imap.js";

const CORE = "urn:ietf:params:jmap:core";
const MALFORMED: unknown[] = [
  { using: [CORE], methodCalls: [[1, null, "x"]] },
  { using: [CORE], methodCalls: [["Core/echo", {}, "0"], "x"] },
  { using: [CORE], methodCalls: [["Core/echo", [], "0"]] },
  { using: [CORE], methodCalls: [["Core/echo", null, "0"]] },
  { using: [CORE], methodCalls: [["Core/echo", {}, 0]] },
  { using: [CORE], methodCalls: [["Core/echo", {}]] },
  { using: [CORE], methodCalls: [["Core/echo", {}, "0", "extra"]] },
  { using: [CORE], methodCalls: {} },
  { using: CORE, methodCalls: [] },
  { using: [CORE, 7], methodCalls: [] },
  { using: [CORE], methodCalls: [], createdIds: "x" },
  [CORE],
];

describe("isRequestEnvelope", () => {
  it("accepts a Request object and refuses everything else", () => {
    expect(isRequestEnvelope({ using: [CORE], methodCalls: [["Core/echo", {}, "0"]] })).toBe(true);
    expect(isRequestEnvelope({ using: [], methodCalls: [], createdIds: { a: "b" } })).toBe(true);
    for (const body of MALFORMED) expect(isRequestEnvelope(body), JSON.stringify(body)).toBe(false);
  });

  it("makes dispatch refuse a malformed call with a JMAP error, not a TypeError", async () => {
    const ctx = { methods: {}, maxCallsInRequest: 16, sessionState: "s" };
    await expect(dispatch(MALFORMED[0] as never, ctx)).rejects.toMatchObject({ type: "notRequest" });
  });
});

let imap: FakeImap;
let app: FastifyInstance;
let dir: string;
let token = "";
beforeAll(async () => {
  imap = await startFakeImap({ "oli@test.local": "right-password" });
  ({ app, dir } = await bootProxy(imap));
  const login = await app.inject({ method: "POST", url: "/api/login", payload: { username: "oli@test.local", password: "right-password" } });
  token = (login.json() as { token: string }).token;
}, 60_000);
afterAll(async () => {
  await app?.close();
  await imap?.close();
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* left for the OS temp cleanup */
  }
});

describe("POST /jmap with a body that is not a Request object", () => {
  it("is answered 400 notRequest", async () => {
    for (const body of MALFORMED) {
      const res = await app.inject({
        method: "POST",
        url: "/jmap",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        payload: JSON.stringify(body),
      });
      expect(res.statusCode, JSON.stringify(body)).toBe(400);
      expect(res.json(), JSON.stringify(body)).toMatchObject({ type: "urn:ietf:params:jmap:error:notRequest", status: 400 });
    }
  });

  it("still answers a valid request", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/jmap",
      headers: { authorization: `Bearer ${token}` },
      payload: { using: [CORE], methodCalls: [["Core/echo", { hello: true }, "0"]] },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().methodResponses).toEqual([["Core/echo", { hello: true }, "0"]]);
  });
});
