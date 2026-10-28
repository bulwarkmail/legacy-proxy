import { describe, it, expect } from "vitest";
import { assertPublicPushTarget, isPrivateAddress } from "../../src/util/pushTarget.js";

describe("push target check", () => {
  it("flags loopback, private, link-local and mapped addresses", () => {
    for (const a of ["127.0.0.1", "10.1.2.3", "172.20.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "::1", "fd00::1", "fe80::1", "::ffff:10.0.0.1"])
      expect(isPrivateAddress(a), a).toBe(true);
    for (const a of ["1.1.1.1", "2606:4700::1111", "::ffff:8.8.8.8"])
      expect(isPrivateAddress(a), a).toBe(false);
  });

  it("rejects URLs that resolve to private hosts", async () => {
    await expect(assertPublicPushTarget("https://127.0.0.1/x")).rejects.toThrow();
    await expect(assertPublicPushTarget("https://[::1]:8443/x")).rejects.toThrow();
    await expect(assertPublicPushTarget("https://localhost/x")).rejects.toThrow();
    await expect(assertPublicPushTarget("https://1.1.1.1/x")).resolves.toBeUndefined();
  });
});
