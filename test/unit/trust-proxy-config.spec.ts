// TRUST_PROXY names the reverse proxy by address or range. Values that would
// let a caller choose its own address (a hop count, `true`, a /0 range) or
// that the proxy can't check (a host name) stop the start with a message that
// names the setting, the value and what to write instead.

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig, parseTrustProxy } from "../../src/util/config.js";

describe("parseTrustProxy", () => {
  it("trusts no one when unset or empty", () => {
    expect(parseTrustProxy(undefined)).toEqual([]);
    expect(parseTrustProxy("")).toEqual([]);
    expect(parseTrustProxy("  ")).toEqual([]);
  });

  it("takes addresses and CIDR ranges, IPv4 and IPv6", () => {
    expect(parseTrustProxy("127.0.0.1")).toEqual(["127.0.0.1"]);
    expect(parseTrustProxy("127.0.0.1, ::1")).toEqual(["127.0.0.1", "::1"]);
    expect(parseTrustProxy("10.0.0.0/8,172.18.0.0/16, fd00::/8")).toEqual(["10.0.0.0/8", "172.18.0.0/16", "fd00::/8"]);
    expect(parseTrustProxy("192.0.2.10/32")).toEqual(["192.0.2.10/32"]);
  });

  const refused: Array<[string, RegExp]> = [
    ["1", /hop count/],
    ["2", /hop count/],
    ["true", /every address/],
    ["TRUE", /every address/],
    ["false", /not an address/],
    ["proxy.internal", /host names/],
    ["localhost", /host names/],
    ["127.0.0.1,", /empty entry/],
    ["127.0.0.1,,10.0.0.0/8", /empty entry/],
    ["10.0.0.0/33", /prefix length/],
    ["10.0.0.0/abc", /prefix length/],
    ["0.0.0.0/0", /every address/],
    ["::/0", /every address/],
    ["fe80::1%eth0", /not an IP address/],
    ["127.0.0.1, 1", /hop count/],
  ];
  for (const [value, why] of refused) {
    it(`refuses ${JSON.stringify(value)} with a message naming the setting, the value and an example`, () => {
      let message = "";
      try {
        parseTrustProxy(value);
      } catch (e) {
        message = (e as Error).message;
      }
      expect(message).toMatch(why);
      expect(message).toContain(`TRUST_PROXY=${JSON.stringify(value)}`);
      expect(message).toContain("TRUST_PROXY=127.0.0.1");
    });
  }

  it("hands Fastify a list that takes the forwarded address only from the named proxy", async () => {
    const app = Fastify({ trustProxy: parseTrustProxy("127.0.0.1, 10.4.0.0/16") });
    app.get("/ip", async (req) => req.ip);
    await app.ready();
    const ip = async (remoteAddress: string, forwarded: string) =>
      (await app.inject({ method: "GET", url: "/ip", remoteAddress, headers: { "x-forwarded-for": forwarded } })).body;
    try {
      expect(await ip("127.0.0.1", "203.0.113.5")).toBe("203.0.113.5");
      expect(await ip("10.4.7.9", "198.51.100.1, 203.0.113.6")).toBe("203.0.113.6");
      // Not the reverse proxy: the header is ignored.
      expect(await ip("198.51.100.9", "203.0.113.7")).toBe("198.51.100.9");
    } finally {
      await app.close();
    }
  });
});

describe("loadConfig", () => {
  const saved = { ...process.env };
  afterEach(() => {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  });

  it("stops at start when TRUST_PROXY is a hop count", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "legacy-proxy-test-"));
    Object.assign(process.env, {
      DATA_DIR: dir,
      PROVIDERS_FILE: path.join(dir, "none.json"),
      VAULT_KEY: crypto.randomBytes(32).toString("base64"),
      SESSION_HMAC_KEY: crypto.randomBytes(32).toString("base64"),
      TRUST_PROXY: "1",
    });
    try {
      expect(() => loadConfig()).toThrow(/TRUST_PROXY="1".*hop count/);
      process.env.TRUST_PROXY = "127.0.0.1";
      expect(loadConfig().trustProxy).toEqual(["127.0.0.1"]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
