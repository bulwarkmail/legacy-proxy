// Which answers to a login count as "the credentials were refused"
// (isCredentialRefusal), with the error objects imapflow really produces.
// Small IMAP servers on 127.0.0.1.
//
// Stalwart (0.16 and 1.0) answers a store error during AUTHENTICATE with
// NO [CONTACTADMIN]: a server-side failure, not a wrong password.

import net from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { isCredentialRefusal, openImap } from "../../src/imap/client.js";
import type { ProviderConfig } from "../../src/util/config.js";

process.env.LOG_LEVEL = "silent";

const servers: net.Server[] = [];
const sockets = new Set<net.Socket>();
afterEach(async () => {
  for (const s of sockets) s.destroy();
  sockets.clear();
  for (const s of servers.splice(0)) await new Promise<void>((r) => s.close(() => r()));
});

/** A server that answers the login with `answer` (or does `answer(sock, tag)`). */
async function serverAnswering(answer: string | ((sock: net.Socket, tag: string) => void), greeting = "* OK [CAPABILITY IMAP4rev1 AUTH=PLAIN] hi\r\n") {
  const server = net.createServer((sock) => {
    sockets.add(sock);
    sock.on("error", () => {});
    if (greeting.startsWith("* BYE")) {
      sock.end(greeting);
      return;
    }
    sock.write(greeting);
    let buf = "";
    sock.on("data", (c) => {
      buf += c.toString("latin1");
      for (let nl = buf.indexOf("\r\n"); nl >= 0; nl = buf.indexOf("\r\n")) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 2);
        const [tag, cmd] = line.split(" ");
        if (/^(AUTHENTICATE|LOGIN)$/i.test(cmd ?? "")) {
          if (typeof answer === "string") sock.write(`${tag} ${answer}\r\n`);
          else answer(sock, tag!);
        } else if (/^CAPABILITY$/i.test(cmd ?? "")) sock.write(`* CAPABILITY IMAP4rev1 AUTH=PLAIN\r\n${tag} OK\r\n`);
        else if (tag) sock.write(`${tag} OK\r\n`);
      }
    });
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return (server.address() as net.AddressInfo).port;
}

async function errorFrom(port: number): Promise<unknown> {
  const provider = {
    imap: { host: "127.0.0.1", port, secure: false },
    smtp: { host: "127.0.0.1", port: 1, secure: true },
    sieve: null,
    carddav: null,
  } as unknown as ProviderConfig;
  try {
    const c = await openImap({ provider, creds: { mech: "PLAIN", username: "u@test.local", password: "pw" } });
    await c.logout().catch(() => {});
    return null;
  } catch (e) {
    return e;
  }
}

describe("what counts as a refusal of the credentials", () => {
  it.each([
    ["NO [AUTHENTICATIONFAILED]", "NO [AUTHENTICATIONFAILED] Authentication failed", true],
    ["NO [AUTHORIZATIONFAILED] (Stalwart: no permission, or banned)", "NO [AUTHORIZATIONFAILED] nope", true],
    ["NO [EXPIRED]", "NO [EXPIRED] password expired", true],
    ["NO without a code, rate-limit text", "NO Too many login failures, try again later", true],
    ["NO [UNAVAILABLE]", "NO [UNAVAILABLE] try later", false],
    ["NO [LIMIT] (Stalwart: concurrency or rate limit)", "NO [LIMIT] too many", false],
    ["NO [INUSE]", "NO [INUSE] busy", false],
    ["NO [SERVERBUG]", "NO [SERVERBUG] oops", false],
  ])("%s", async (_label, answer, refusal) => {
    const err = await errorFrom(await serverAnswering(answer as string));
    expect(err).not.toBeNull();
    expect(isCredentialRefusal(err)).toBe(refusal);
  });

  it("does not count a connection dropped in the middle of the login", async () => {
    const err = await errorFrom(await serverAnswering((sock) => sock.destroy()));
    expect(err).not.toBeNull();
    expect(isCredentialRefusal(err)).toBe(false);
  });

  it("does not count a server that says BYE in its greeting", async () => {
    const err = await errorFrom(await serverAnswering("NO x", "* BYE [UNAVAILABLE] shutting down\r\n"));
    expect(err).not.toBeNull();
    expect(isCredentialRefusal(err)).toBe(false);
  });

  it("does not count Stalwart's answer to a store error during the login", async () => {
    const err = await errorFrom(await serverAnswering("NO [CONTACTADMIN] Database error"));
    expect(err).not.toBeNull();
    expect(isCredentialRefusal(err)).toBe(false);
  });
});
