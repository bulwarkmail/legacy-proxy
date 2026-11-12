// Result references, Request objects and ManageSieve bounds, in more shapes.
// A result reference's JSON pointer reads only an array's elements and an
// object's own properties, never what they inherit ("/__proto__",
// "/constructor"): such a path does not resolve.

import net from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { dispatch, isRequestEnvelope } from "../../src/jmap/router.js";
import { resolveArgs } from "../../src/jmap/refs.js";
import { SieveClient } from "../../src/sieve/client.js";

describe("result references", () => {
  it("do not resolve a pointer into an object's prototype", () => {
    const prior = { c0: { name: "Core/echo", result: { list: [] } } };
    for (const path of ["/__proto__", "/constructor", "/list/constructor", "/__proto__/constructor"]) {
      expect(() => resolveArgs({ "#ids": { resultOf: "c0", name: "Core/echo", path } }, prior), path).toThrow(/did not resolve/);
    }
  });
});

describe("Request objects", () => {
  it("are refused with notRequest in every malformed shape, by the dispatcher too", async () => {
    const bad: unknown[] = [
      "x",
      [],
      { using: "urn:ietf:params:jmap:core", methodCalls: [] },
      { using: [], methodCalls: {} },
      { using: [], methodCalls: [["Core/echo", {}, "0", "extra"]] },
      { using: [], methodCalls: [["Core/echo", null, "0"]] },
      { using: [], methodCalls: [["Core/echo", [], "0"]] },
      { using: [], methodCalls: [[null, {}, "0"]] },
      { using: [], methodCalls: [["Core/echo", {}, 0]] },
      { using: [], methodCalls: [], createdIds: [] },
      { using: [], methodCalls: [], createdIds: "x" },
    ];
    for (const env of bad) {
      expect(isRequestEnvelope(env), JSON.stringify(env)).toBe(false);
      await expect(
        dispatch(env as never, { methods: {}, maxCallsInRequest: 16, sessionState: "s" }),
        JSON.stringify(env),
      ).rejects.toMatchObject({ type: "notRequest" });
    }
    expect(isRequestEnvelope({ using: [], methodCalls: [] })).toBe(true);
  });
});

const servers: net.Server[] = [];
const sockets = new Set<net.Socket>();
afterEach(async () => {
  for (const s of sockets) s.destroy();
  sockets.clear();
  for (const s of servers.splice(0)) await new Promise<void>((r) => s.close(() => r()));
});
async function sieveServer(onLine: (line: string, sock: net.Socket) => void) {
  const server = net.createServer((sock) => {
    sockets.add(sock);
    sock.on("error", () => {});
    sock.write('"IMPLEMENTATION" "fake"\r\n"SASL" "PLAIN"\r\nOK\r\n');
    let buf = "";
    sock.on("data", (c) => {
      buf += c.toString("latin1");
      for (let nl = buf.indexOf("\r\n"); nl >= 0; nl = buf.indexOf("\r\n")) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 2);
        onLine(line, sock);
      }
    });
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return (server.address() as net.AddressInfo).port;
}
const creds = { mech: "PLAIN" as const, username: "u", password: "p" };

describe("ManageSieve bounds", () => {
  it("refuses a literal one byte over the script limit and an absurd one, before reading", async () => {
    for (const size of ["1048577", "99999999999999999999"]) {
      const port = await sieveServer((line, sock) => {
        if (line.startsWith("AUTHENTICATE")) sock.write("OK\r\n");
        else if (line.startsWith("GETSCRIPT")) sock.write(`{${size}}\r\n`);
      });
      const c = new SieveClient({ host: "127.0.0.1", port, creds, timeoutMs: 2000 });
      await c.connect();
      await expect(c.getScript("x"), size).rejects.toThrow(/larger than/);
    }
  });

  it("gives up when the server accepts STARTTLS and then says nothing", async () => {
    const port = await sieveServer(() => {
      /* never answers STARTTLS */
    });
    const c = new SieveClient({ host: "127.0.0.1", port, starttls: true, creds, timeoutMs: 1000 });
    await expect(c.connect()).rejects.toThrow(/no answer/);
  });

  it("gives up on a server that trickles an endless list, within the size limit or the deadline", async () => {
    const port = await sieveServer((line, sock) => {
      if (line.startsWith("AUTHENTICATE")) sock.write("OK\r\n");
      else if (line === "LISTSCRIPTS") {
        const t = setInterval(() => {
          if (sock.destroyed) return clearInterval(t);
          sock.write(`"${"s".repeat(60_000)}"\r\n`);
        }, 5);
      }
    });
    const c = new SieveClient({ host: "127.0.0.1", port, creds, timeoutMs: 5000 });
    await c.connect();
    await expect(c.listScripts()).rejects.toThrow(/larger than|no answer/);
  });
});
