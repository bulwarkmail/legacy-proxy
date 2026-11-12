// Requests to the address book server have a deadline and a bound on the size
// of the answer. When either is hit the JMAP call is answered with
// serverUnavailable instead of waiting or reading without end. Runs against a
// real HTTP server on loopback; the limits are lowered for the test.

import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { addressBookGet, contactCardSet, type ContactCtx } from "../../src/jmap/methods/contacts.js";
import { cardDavLimits, resetCardDavCaches } from "../../src/carddav/client.js";
import type { AccountRow } from "../../src/state/store.js";
import type { ProviderConfig } from "../../src/util/config.js";

const BOOK = "/books/u/contacts/";
const CARD = BOOK + "one.vcf";
const ok = (href: string, props: string) =>
  `<D:response><D:href>${href}</D:href><D:propstat><D:prop>${props}</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`;
const BOOK_LIST =
  `<?xml version="1.0"?><D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:carddav">` +
  ok("/books/u/", "<D:resourcetype><D:collection/></D:resourcetype>") +
  ok(BOOK, "<D:resourcetype><D:collection/><C:addressbook/></D:resourcetype><D:displayname>Contacts</D:displayname>") +
  `</D:multistatus>`;

type Behaviour = (req: http.IncomingMessage, res: http.ServerResponse) => void;
let behave: Behaviour;
let server: http.Server;
let ctx: ContactCtx;
const saved = { ...cardDavLimits };

const answer = (res: http.ServerResponse, body: string) =>
  res.writeHead(207, { "content-type": "application/xml" }).end(body);

beforeAll(async () => {
  server = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => behave(req, res));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  ctx = {
    account: { id: 7, username: "u" } as AccountRow,
    provider: {
      imap: { host: "h", port: 993 },
      smtp: { host: "h", port: 587 },
      sieve: null,
      carddav: { host: "127.0.0.1", port, secure: false, principalPath: "/books/u/" },
      auth: { mech: ["PLAIN"] },
    } as ProviderConfig,
    creds: { mech: "PLAIN", username: "u", password: "p" },
  };
});
beforeEach(() => {
  resetCardDavCaches();
  cardDavLimits.timeoutMs = 300;
  cardDavLimits.maxResponseBytes = 64 * 1024;
});
afterEach(() => {
  Object.assign(cardDavLimits, saved);
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
});

const id = Buffer.from(BOOK + "\n" + CARD, "utf8").toString("base64url");

describe("the contacts server gets a deadline and a size bound", () => {
  it("reads an answer that is in time and small enough", async () => {
    behave = (_req, res) => answer(res, BOOK_LIST);
    const res = await addressBookGet({ accountId: "7", ids: null }, ctx);
    expect(res.list.map((b) => b.name)).toEqual(["Contacts"]);
  });

  it("answers serverUnavailable when the server does not answer in time", async () => {
    behave = () => {}; // never answers
    await expect(addressBookGet({ accountId: "7", ids: null }, ctx)).rejects.toMatchObject({ type: "serverUnavailable" });
  }, 3_000);

  it("answers serverUnavailable when the answer does not finish in time", async () => {
    behave = (_req, res) => {
      res.writeHead(207, { "content-type": "application/xml" });
      res.write(BOOK_LIST.slice(0, 40)); // and then nothing more
    };
    await expect(addressBookGet({ accountId: "7", ids: null }, ctx)).rejects.toMatchObject({ type: "serverUnavailable" });
  }, 3_000);

  it("answers serverUnavailable when the answer is larger than the bound", async () => {
    const padding = `<!-- ${"x".repeat(200 * 1024)} -->`;
    behave = (_req, res) => {
      res.writeHead(207, { "content-type": "application/xml" }); // chunked, no length given
      res.end(BOOK_LIST.replace("</D:multistatus>", padding + "</D:multistatus>"));
    };
    await expect(addressBookGet({ accountId: "7", ids: null }, ctx)).rejects.toMatchObject({ type: "serverUnavailable" });

    resetCardDavCaches();
    behave = (_req, res) => res.writeHead(207, { "content-length": String(10 * 1024 * 1024) }).write("<");
    await expect(addressBookGet({ accountId: "7", ids: null }, ctx)).rejects.toMatchObject({ type: "serverUnavailable" });
  }, 3_000);

  it("reports serverUnavailable for a write that does not get an answer in time", async () => {
    behave = (req, res) => {
      if (req.method === "PROPFIND") answer(res, BOOK_LIST);
      // DELETE: never answered
    };
    const res = await contactCardSet({ accountId: "7", destroy: [id] }, ctx);
    expect(res.notDestroyed?.[id]?.type).toBe("serverUnavailable");
  }, 3_000);
});
