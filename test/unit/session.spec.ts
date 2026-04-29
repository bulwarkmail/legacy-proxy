import { describe, expect, it } from "vitest";
import crypto from "node:crypto";
import { signSession, verifySession, makeSession } from "../../src/auth/session.js";

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
});
