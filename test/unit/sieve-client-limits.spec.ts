// The ManageSieve client bounds what a server may make it wait for and hold:
// every command's answer must come within the deadline, a script may be at
// most 1 MB, and a connection that goes away fails the command instead of
// leaving it waiting. Each case runs a small server on loopback.

import net from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { MAX_SCRIPT_BYTES, SieveClient } from "../../src/sieve/client.js";

const creds = { mech: "PLAIN" as const, username: "u@test.local", password: "fake-password" };
const GREETING = '"IMPLEMENTATION" "fake"\r\n"SASL" "PLAIN"\r\nOK ready\r\n';
const servers: net.Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await new Promise<void>((resolve) => s.close(() => resolve()));
});

/** A server that greets, accepts any login, and answers other commands with `onCommand`. */
async function server(onCommand: (line: string, sock: net.Socket) => void, greet = true): Promise<number> {
  const s = net.createServer((sock) => {
    sock.on("error", () => {});
    if (greet) sock.write(GREETING);
    let buf = "";
    let saslBlobNext = false;
    sock.on("data", (chunk) => {
      buf += chunk.toString("latin1");
      for (let nl = buf.indexOf("\r\n"); nl >= 0; nl = buf.indexOf("\r\n")) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 2);
        if (saslBlobNext) {
          // The literal that carries the SASL PLAIN blob.
          saslBlobNext = false;
          sock.write("OK\r\n");
        } else if (/^AUTHENTICATE/i.test(line)) saslBlobNext = true;
        else onCommand(line, sock);
      }
    });
  });
  servers.push(s);
  await new Promise<void>((resolve) => s.listen(0, "127.0.0.1", resolve));
  return (s.address() as net.AddressInfo).port;
}

const client = (port: number) => new SieveClient({ host: "127.0.0.1", port, creds, timeoutMs: 300 });

describe("ManageSieve answers the client will not wait for or hold", () => {
  it("gives up on a server that never greets", async () => {
    const port = await server(() => {}, false);
    await expect(client(port).connect()).rejects.toThrow(/no answer to connect/);
  }, 3000);

  it("gives up on a command the server never answers", async () => {
    const port = await server(() => {});
    const c = client(port);
    await c.connect();
    await expect(c.getScript("vacation")).rejects.toThrow(/no answer to GETSCRIPT/);
  }, 3000);

  it("refuses a script larger than 1 MB before reading it", async () => {
    const port = await server((line, sock) => {
      if (/^GETSCRIPT/i.test(line)) sock.write(`{${MAX_SCRIPT_BYTES + 1}}\r\n`);
    });
    const c = client(port);
    await c.connect();
    await expect(c.getScript("vacation")).rejects.toThrow(/larger than/);
  }, 3000);

  it("refuses an answer that grows past the limit without ending", async () => {
    const port = await server((line, sock) => {
      if (/^LISTSCRIPTS/i.test(line)) sock.write(Buffer.alloc(2 * 1024 * 1024, 0x61));
    });
    const c = client(port);
    await c.connect();
    await expect(c.listScripts()).rejects.toThrow(/larger than/);
  }, 3000);

  it("fails a command when the server hangs up in the middle of the answer", async () => {
    const port = await server((line, sock) => {
      if (/^GETSCRIPT/i.test(line)) {
        sock.write("{100}\r\nrequire");
        sock.end();
      }
    });
    const c = client(port);
    await c.connect();
    await expect(c.getScript("vacation")).rejects.toThrow(/closed/);
  }, 3000);

  it("still talks to a server that answers", async () => {
    const script = 'require "vacation";\r\nvacation "away";\r\n';
    const port = await server((line, sock) => {
      if (/^LISTSCRIPTS/i.test(line)) sock.write('"vacation" ACTIVE\r\nOK\r\n');
      else if (/^GETSCRIPT/i.test(line)) sock.write(`{${Buffer.byteLength(script)}}\r\n${script}\r\nOK\r\n`);
      else if (/^SETACTIVE/i.test(line)) sock.write("OK\r\n");
    });
    const c = client(port);
    await c.connect();
    expect(await c.listScripts()).toEqual([{ name: "vacation", active: true }]);
    expect(await c.getScript("vacation")).toBe(script);
    await c.setActive("vacation");
    await c.logout();
  }, 3000);
});
