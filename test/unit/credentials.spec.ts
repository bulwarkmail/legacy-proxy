import { describe, expect, it } from "vitest";
import crypto from "node:crypto";
import { sealCredentials, openCredentials } from "../../src/auth/credentials.js";

describe("credential vault", () => {
  it("roundtrips a PLAIN credential", async () => {
    const key = crypto.randomBytes(32);
    const sealed = await sealCredentials(key, { mech: "PLAIN", username: "a@b", password: "hunter2" });
    const back = await openCredentials(key, sealed);
    expect(back).toEqual({ mech: "PLAIN", username: "a@b", password: "hunter2" });
  });
  it("rejects ciphertext with wrong key", async () => {
    const k1 = crypto.randomBytes(32);
    const k2 = crypto.randomBytes(32);
    const sealed = await sealCredentials(k1, { mech: "PLAIN", username: "a", password: "p" });
    await expect(openCredentials(k2, sealed)).rejects.toBeTruthy();
  });
  it("rejects truncated vault", async () => {
    const key = crypto.randomBytes(32);
    await expect(openCredentials(key, Buffer.alloc(4))).rejects.toBeTruthy();
  });
});
