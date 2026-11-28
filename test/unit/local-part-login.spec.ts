// `localPartLogin` on a provider's sieve, carddav or caldav entry logs in
// there with the part of the mail login before the `@`, as it does on IMAP
// and SMTP.

import net from "node:net";
import { afterEach, expect, it } from "vitest";
import { SieveClient } from "../../src/sieve/client.js";
import { davOptions } from "../../src/carddav/client.js";

const creds = { mech: "PLAIN" as const, username: "alice@example.org", password: "fake-password" };
const servers: net.Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await new Promise<void>((resolve) => s.close(() => resolve()));
});

/** A ManageSieve server that records the user name of each SASL PLAIN login. */
async function sieveServer(logins: string[]): Promise<number> {
  const s = net.createServer((sock) => {
    sock.on("error", () => {});
    sock.write('"IMPLEMENTATION" "fake"\r\n"SASL" "PLAIN"\r\nOK ready\r\n');
    let buf = "";
    let blobNext = false;
    sock.on("data", (chunk) => {
      buf += chunk.toString("latin1");
      for (let nl = buf.indexOf("\r\n"); nl >= 0; nl = buf.indexOf("\r\n")) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 2);
        if (blobNext) {
          blobNext = false;
          logins.push(Buffer.from(line, "base64").toString("utf8").split("\x00")[1]!);
          sock.write("OK\r\n");
        } else if (/^AUTHENTICATE/i.test(line)) blobNext = true;
        else if (/^LOGOUT/i.test(line)) sock.end("OK\r\n");
      }
    });
  });
  servers.push(s);
  await new Promise<void>((resolve) => s.listen(0, "127.0.0.1", resolve));
  return (s.address() as net.AddressInfo).port;
}

it("logs in to ManageSieve with the local part when the sieve entry asks for it", async () => {
  const logins: string[] = [];
  const port = await sieveServer(logins);
  for (const localPartLogin of [true, false]) {
    const c = new SieveClient({ host: "127.0.0.1", port, creds, localPartLogin, timeoutMs: 1000 });
    await c.connect();
    await c.logout();
  }
  expect(logins).toEqual(["alice", "alice@example.org"]);
}, 5000);

it("logs in to DAV with the local part when the DAV entry asks for it", () => {
  const dav = { host: "dav.example", port: 443, secure: true };
  expect(davOptions({ ...dav, localPartLogin: true }, creds).creds).toEqual({ ...creds, username: "alice" });
  expect(davOptions(dav, creds).creds).toBe(creds);
  expect(davOptions({ ...dav, localPartLogin: true }, creds)).not.toHaveProperty("localPartLogin");
  // A separate DAV login is used as written.
  const own = { ...dav, localPartLogin: true, username: "dav-user", password: "pw", forUser: "alice@example.org" };
  expect(davOptions(own, creds).creds).toEqual({ mech: "PLAIN", username: "dav-user", password: "pw" });
  expect(davOptions(own, { ...creds, username: "bob@example.org" }).creds.username).toBe("bob");
});
