// TRUST_PROXY names the reverse proxy by address or range. Unset, `false`,
// `0`, `no` and `off` trust nobody. Values that would let a caller choose its
// own address (a hop count, `true`, a public range wider than a reverse
// proxy's network, an IPv4-mapped range, entries that together cover
// everything) or
// that the proxy can't check (a host name) stop the start with a message that
// names the setting, the value and what to write instead, without a stack.

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig, parseTrustProxy } from "../../src/util/config.js";

describe("parseTrustProxy", () => {
  it("trusts no one when unset, empty, false, 0, no or off", () => {
    for (const value of [undefined, "", "  ", "false", "FALSE", "0", "no", " off "]) {
      expect(parseTrustProxy(value), String(value)).toEqual([]);
    }
  });

  it("takes addresses and CIDR ranges, IPv4 and IPv6, up to /8 and /32 in public space and private ranges whole", () => {
    expect(parseTrustProxy("127.0.0.1")).toEqual(["127.0.0.1"]);
    expect(parseTrustProxy("127.0.0.1, ::1")).toEqual(["127.0.0.1", "::1"]);
    expect(parseTrustProxy("10.0.0.0/8,172.18.0.0/16, fd00::/8")).toEqual(["10.0.0.0/8", "172.18.0.0/16", "fd00::/8"]);
    expect(parseTrustProxy("fd00:1::/64")).toEqual(["fd00:1::/64"]);
    expect(parseTrustProxy("192.0.2.10/32")).toEqual(["192.0.2.10/32"]);
    expect(parseTrustProxy("2001:db8::/32")).toEqual(["2001:db8::/32"]);
  });

  const everyEight = Array.from({ length: 256 }, (_, i) => `${i}.0.0.0/8`).join(",");
  const refused: Array<[string, RegExp]> = [
    ["1", /hop count/],
    ["2", /hop count/],
    ["true", /every address/],
    ["TRUE", /every address/],
    ["yes", /every address/],
    ["proxy.internal", /host names/],
    ["localhost", /host names/],
    ["loopback", /host names/],
    ["127.0.0.1,", /empty entry/],
    ["127.0.0.1,,10.0.0.0/8", /empty entry/],
    ["127.0.0.1,false", /not an address/],
    ["10.0.0.0/33", /prefix length/],
    ["10.0.0.0/abc", /prefix length/],
    ["0.0.0.0/0", /wider than \/8/],
    ["::/0", /wider than \/32/],
    ["10.0.0.0/7", /wider than \/8/],
    ["0.0.0.0/1,128.0.0.0/1", /wider than \/8/],
    ["2001:db8::/31", /wider than \/32/],
    ["::ffff:0:0/96", /IPv4-mapped/],
    ["::ffff:10.0.0.1", /IPv4-mapped/],
    ["::ffff:7f00:1", /IPv4-mapped/],
    ["::/32", /IPv4-mapped/],
    [everyEight, /every IPv4 address/],
    ["fe80::1%eth0", /not an IP address/],
    ["127.0.0.1, 1", /hop count/],
  ];
  for (const [value, why] of refused) {
    it(`refuses ${JSON.stringify(value.length > 40 ? `${value.slice(0, 40)}...` : value)} with a message naming the setting, the value and an example`, () => {
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

  it("takes a list that covers most but not all of IPv4", () => {
    const allButOne = Array.from({ length: 255 }, (_, i) => `${i}.0.0.0/8`);
    expect(parseTrustProxy(allButOne.join(","))).toHaveLength(255);
  });

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

  it("stops at start when TRUST_PROXY is a hop count, and trusts nobody for false", () => {
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
      process.env.TRUST_PROXY = "false";
      expect(loadConfig().trustProxy).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("the proxy started with a TRUST_PROXY it can't use", () => {
  it("prints the message and exits 1, without a stack trace", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "legacy-proxy-test-"));
    try {
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        PORT: "0",
        LISTEN_HOST: "127.0.0.1",
        DATA_DIR: dir,
        PROVIDERS_FILE: path.join(dir, "none.json"),
        VAULT_KEY: crypto.randomBytes(32).toString("base64"),
        SESSION_HMAC_KEY: crypto.randomBytes(32).toString("base64"),
        LOG_LEVEL: "silent",
        TRUST_PROXY: "::ffff:0:0/96",
      };
      delete env.GMAIL_OAUTH_CLIENT_FILE;
      const server = fileURLToPath(new URL("../../src/server.ts", import.meta.url));
      const run = spawnSync(process.execPath, ["--import", "tsx", server], { env, encoding: "utf8", timeout: 60_000 });
      expect(run.status).toBe(1);
      expect(run.stderr).toContain('TRUST_PROXY="::ffff:0:0/96"');
      expect(run.stderr).toContain("IPv4-mapped");
      expect(run.stderr).not.toMatch(/^\s+at /m);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
