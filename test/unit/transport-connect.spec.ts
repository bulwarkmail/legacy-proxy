// Where a connection is made, each client applies the provider entry's
// transport rule again: a plain connection only to loopback or with
// "allowPlaintext", and STARTTLS as a requirement when the entry asks for it.
// No test here reaches the network: imapflow and nodemailer are replaced by
// recorders, and net.connect only lets loopback through.

import net from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const imapOptions: Record<string, unknown>[] = [];
vi.mock("imapflow", () => ({
  ImapFlow: class {
    constructor(opts: Record<string, unknown>) {
      imapOptions.push(opts);
    }
    on() {}
    async connect() {}
  },
}));

const smtpOptions: Record<string, unknown>[] = [];
vi.mock("nodemailer", () => ({
  default: {
    createTransport: (opts: Record<string, unknown>) => {
      smtpOptions.push(opts);
      return { sendMail: async () => ({ messageId: "<m@x>", accepted: [], rejected: [], response: "250 ok" }) };
    },
  },
}));

const connects: string[] = [];
vi.mock("node:net", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:net")>();
  const connect = (...args: unknown[]) => {
    const opts = args[0] as { host?: string };
    connects.push(String(opts?.host));
    if (opts?.host !== "127.0.0.1") throw new Error(`test: no connection to ${opts?.host}`);
    return (real.connect as (...a: unknown[]) => net.Socket)(...args);
  };
  return { ...real, default: { ...real, connect }, connect };
});

const { openImap } = await import("../../src/imap/client.js");
const { submit } = await import("../../src/smtp/submit.js");
const { SieveClient } = await import("../../src/sieve/client.js");
import type { ProviderConfig } from "../../src/util/config.js";

const creds = { mech: "PLAIN" as const, username: "u@test.local", password: "fake-password" };
const provider = (over: Partial<ProviderConfig>): ProviderConfig => ({
  imap: { host: "imap.example", port: 993, secure: true },
  smtp: { host: "smtp.example", port: 465, secure: true },
  sieve: null,
  carddav: null,
  auth: { mech: ["PLAIN"] },
  ...over,
});

beforeEach(() => {
  imapOptions.length = 0;
  smtpOptions.length = 0;
  connects.length = 0;
});

describe("IMAP", () => {
  it("requires STARTTLS when the entry asks for it", async () => {
    await openImap({ provider: provider({ imap: { host: "imap.example", port: 143, starttls: true } }), creds });
    expect(imapOptions[0]).toMatchObject({ secure: false, doSTARTTLS: true });
  });

  it("refuses a plain connection to a remote host before connecting", async () => {
    await expect(
      openImap({ provider: provider({ imap: { host: "imap.example", port: 143, secure: false } }), creds }),
    ).rejects.toThrow(/in clear/);
    expect(imapOptions).toHaveLength(0);
  });

  it("allows a plain connection the entry allows", async () => {
    await openImap({
      provider: provider({ imap: { host: "imap.example", port: 143, secure: false, allowPlaintext: true } }),
      creds,
    });
    expect(imapOptions[0]).toMatchObject({ secure: false });
  });
});

describe("SMTP", () => {
  const send = (smtp: ProviderConfig["smtp"]) =>
    submit({ provider: provider({ smtp }), creds, envelopeFrom: "u@test.local", rcptTo: ["v@test.local"], raw: Buffer.from("x") });

  it("refuses port 587 with neither flag before creating a transport", async () => {
    await expect(send({ host: "smtp.example", port: 587 })).rejects.toThrow(/in clear/);
    expect(smtpOptions).toHaveLength(0);
  });

  it("requires STARTTLS when the entry asks for it", async () => {
    await send({ host: "smtp.example", port: 587, starttls: true });
    expect(smtpOptions[0]).toMatchObject({ secure: false, requireTLS: true });
  });

  it("keeps implicit TLS on 465 and allows plain on loopback", async () => {
    await send({ host: "smtp.example", port: 465 });
    await send({ host: "localhost", port: 25 });
    expect(smtpOptions.map((o) => [o.secure, o.requireTLS])).toEqual([
      [true, false],
      [false, false],
    ]);
  });
});

describe("ManageSieve", () => {
  let server: net.Server;
  let port = 0;
  const received: string[] = [];
  beforeAll(async () => {
    // Greets without STARTTLS and refuses it.
    server = net.createServer((sock) => {
      sock.on("error", () => {});
      sock.write('"IMPLEMENTATION" "fake"\r\n"SASL" "PLAIN"\r\nOK ready\r\n');
      sock.on("data", (chunk) => {
        for (const line of chunk.toString("latin1").split("\r\n").filter(Boolean)) {
          received.push(line);
          if (/^STARTTLS/i.test(line)) sock.write("NO not offered\r\n");
          else if (/^AUTHENTICATE/i.test(line)) sock.write("OK\r\n");
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as net.AddressInfo).port;
  });
  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  it("refuses a plain connection to a remote host before connecting", async () => {
    const c = new SieveClient({ host: "192.0.2.1", port: 4190, creds });
    await expect(c.connect()).rejects.toThrow(/in clear/);
    expect(connects).toEqual([]);
  });

  it("sends no credentials when STARTTLS is required and refused", async () => {
    received.length = 0;
    const c = new SieveClient({ host: "127.0.0.1", port, starttls: true, creds });
    await expect(c.connect()).rejects.toThrow();
    await c.logout();
    expect(received.some((l) => /^AUTHENTICATE/i.test(l))).toBe(false);
  });

  it("logs in over plain loopback", async () => {
    received.length = 0;
    const c = new SieveClient({ host: "127.0.0.1", port, creds });
    await c.connect();
    await c.logout();
    expect(received.some((l) => /^AUTHENTICATE/i.test(l))).toBe(true);
  });
});
