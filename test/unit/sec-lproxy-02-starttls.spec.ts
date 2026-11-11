// LPROXY-02: "starttls": true on a provider's imap entry is never read, and
// with "secure": false the client logs in on the plain socket when the server
// (or someone on the path) offers no STARTTLS. Belongs in test/unit/.
//
// Fails on fe595e1: the login succeeds and the password crosses in clear.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openImap } from "../../src/imap/client.js";
import type { ProviderConfig } from "../../src/util/config.js";
import { startFakeImap, type FakeImap } from "./sec-fake-imap.js";

let imap: FakeImap;
beforeAll(async () => {
  imap = await startFakeImap({ "bob@test.local": "fake-password-1" });
});
afterAll(() => imap.close());

const provider = (imapOpts: Partial<ProviderConfig["imap"]>): ProviderConfig => ({
  imap: { host: "127.0.0.1", port: imap.port, ...imapOpts },
  smtp: { host: "127.0.0.1", port: 1 },
  sieve: null,
  carddav: null,
  auth: { mech: ["PLAIN"] },
});
const creds = { mech: "PLAIN" as const, username: "bob@test.local", password: "fake-password-1" };
const sawCredentials = () =>
  imap.lines.some((l) => l.includes(Buffer.from("\0bob@test.local\0fake-password-1").toString("base64")) || /LOGIN/i.test(l));

describe("IMAP STARTTLS is required when the provider asks for it (LPROXY-02)", () => {
  it("refuses to log in when starttls is set and the server offers no STARTTLS", async () => {
    imap.lines.length = 0;
    let client: Awaited<ReturnType<typeof openImap>> | undefined;
    const outcome = await openImap({ provider: provider({ secure: false, starttls: true }), creds }).then(
      (c) => {
        client = c;
        return "connected";
      },
      () => "refused",
    );
    client?.close();
    expect(sawCredentials()).toBe(false);
    expect(outcome).toBe("refused");
  });
});
