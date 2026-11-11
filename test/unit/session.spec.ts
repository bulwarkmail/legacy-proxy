import { describe, expect, it } from "vitest";
import crypto from "node:crypto";
import { signSession, verifySession, makeSession, sessionGeneration } from "../../src/auth/session.js";

const KEY = crypto.randomBytes(32);

describe("session token", () => {
  it("roundtrips", () => {
    const t = makeSession({ accountSlug: "gmail:bob@x.io", username: "bob@x.io" });
    const tok = signSession(KEY, t);
    const back = verifySession(KEY, tok);
    expect(back?.accountSlug).toBe("gmail:bob@x.io");
  });
  it("rejects tampered tokens", () => {
    const t = makeSession({ accountSlug: "x", username: "x" });
    const tok = signSession(KEY, t);
    const tampered = tok.slice(0, -2) + "ab";
    expect(verifySession(KEY, tampered)).toBeNull();
  });
  it("rejects expired tokens", () => {
    const tok = signSession(KEY, {
      accountSlug: "x",
      username: "x",
      iat: 1,
      exp: 2,
    });
    expect(verifySession(KEY, tok)).toBeNull();
  });
  it("carries the credential generation it was issued under", () => {
    const tok = signSession(KEY, makeSession({ accountSlug: "x", username: "x", gen: 3 }));
    expect(sessionGeneration(verifySession(KEY, tok)!)).toBe(3);
  });
  it("reads a token from before generations existed as generation 0", () => {
    const now = Math.floor(Date.now() / 1000);
    const tok = signSession(KEY, { accountSlug: "x", username: "x", iat: now, exp: now + 60 });
    expect(sessionGeneration(verifySession(KEY, tok)!)).toBe(0);
  });
  it("gives two sign-ins in the same second different tokens", () => {
    const a = signSession(KEY, makeSession({ accountSlug: "x", username: "x" }));
    const b = signSession(KEY, makeSession({ accountSlug: "x", username: "x" }));
    expect(a).not.toBe(b);
  });
});
