// A ContactCard id carries the address of its vCard resource. These tests
// check that the handlers only ever act on a card inside the address book the
// id names, that the CardDAV client only talks to the configured origin
// (including redirects and hrefs the DAV server sends), and that JMAP errors
// carry no part of the DAV server's answer.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { addressBookGet, contactCardGet, contactCardQuery, contactCardSet, type ContactCtx } from "../../src/jmap/methods/contacts.js";
import { CardDavClient, resetCardDavCaches } from "../../src/carddav/client.js";
import type { AccountRow } from "../../src/state/store.js";
import type { ProviderConfig } from "../../src/util/config.js";

const DAV_ORIGIN = "http://dav.test:5232";
const BOOK = "/books/u/contacts/";
const CARD = BOOK + "one.vcf";
const VCARD = "BEGIN:VCARD\r\nVERSION:3.0\r\nUID:one\r\nFN:One\r\nEND:VCARD\r\n";

const ms = (inner: string) =>
  new Response(
    `<?xml version="1.0"?><D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:carddav">${inner}</D:multistatus>`,
    { status: 207, headers: { "content-type": "application/xml" } },
  );
const ok = (href: string, props: string) =>
  `<D:response><D:href>${href}</D:href><D:propstat><D:prop>${props}</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`;

let calls: Array<{ method: string; url: string; authorization: string | null }>;

type Handler = (method: string, url: URL, body: string) => Response;

// Stands in for fetch: records every request and, as fetch does, follows
// redirects itself unless the caller passes redirect: "manual".
function stubFetch(handler: Handler): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown, init: RequestInit = {}) => {
      let url = String(input);
      let method = (init.method ?? "GET").toUpperCase();
      const authorization = new Headers(init.headers).get("authorization");
      for (let hop = 0; hop < 10; hop++) {
        calls.push({ method, url, authorization });
        const res = handler(method, new URL(url), String(init.body ?? ""));
        const location = res.headers.get("location");
        if (init.redirect === "manual" || res.status < 300 || res.status >= 400 || !location) return res;
        url = new URL(location, url).href;
        if (res.status === 303) method = "GET";
      }
      throw new TypeError("too many redirects");
    }),
  );
}

// The DAV server: one book with one card. Anything on another origin stands
// for a service the proxy can reach but must not use.
const dav: Handler = (method, u, body) => {
  if (u.origin !== DAV_ORIGIN) return new Response("INTERNAL-BANNER", { status: 418 });
  if (method === "PROPFIND") {
    if (u.pathname === BOOK)
      return ms(
        ok(BOOK, "<D:resourcetype><D:collection/><C:addressbook/></D:resourcetype>") +
          ok(CARD, '<D:getetag>"e1"</D:getetag><D:resourcetype/>'),
      );
    return ms(
      ok("/books/u/", "<D:resourcetype><D:collection/></D:resourcetype>") +
        ok(BOOK, "<D:resourcetype><D:collection/><C:addressbook/></D:resourcetype><D:displayname>Contacts</D:displayname>"),
    );
  }
  if (method === "REPORT")
    return ms(body.includes(CARD) ? ok(CARD, `<D:getetag>"e1"</D:getetag><C:address-data>${VCARD}</C:address-data>`) : "");
  return new Response(null, { status: 204 });
};

const provider = (carddav: NonNullable<ProviderConfig["carddav"]>): ProviderConfig =>
  ({
    imap: { host: "h", port: 993 },
    smtp: { host: "h", port: 587 },
    sieve: null,
    carddav,
    auth: { mech: ["PLAIN"] },
  }) as ProviderConfig;

const account = { id: 7, slug: "generic:u", kind: "generic", host: "h", username: "u", vault: Buffer.alloc(0), created_at: 0 } as AccountRow;
const creds = { mech: "PLAIN" as const, username: "u", password: "p" };

const ctx: ContactCtx = {
  account,
  provider: provider({ host: "dav.test", port: 5232, secure: false, principalPath: "/books/u/" }),
  creds,
};
const id = (book: string, resource: string) => Buffer.from(book + "\n" + resource, "utf8").toString("base64url");
const foreign = () => calls.filter((c) => new URL(c.url).origin !== DAV_ORIGIN);

beforeEach(() => {
  calls = [];
  resetCardDavCaches();
  stubFetch(dav);
});
afterEach(() => vi.unstubAllGlobals());

describe("ContactCard ids cannot point outside their address book", () => {
  it("does not send a request to another host named in the id", async () => {
    const evil = id(BOOK, "http://10.0.0.5:9200/customer-index");
    const res = await contactCardSet({ accountId: "7", destroy: [evil] }, ctx);
    expect(foreign()).toEqual([]);
    expect(res.destroyed ?? []).not.toContain(evil);
    expect(JSON.stringify(res)).not.toContain("INTERNAL-BANNER");
  });

  it("does not send the user's credentials to another host", async () => {
    await contactCardSet({ accountId: "7", destroy: [id(BOOK, "https://collector.example/x")] }, ctx);
    expect(calls.filter((c) => c.url.startsWith("https://collector.example")).map((c) => c.authorization)).toEqual([]);
  });

  it("does not DELETE a path outside the address book on the DAV server", async () => {
    const outside = id(BOOK, "/calendars/u/work/");
    const res = await contactCardSet({ accountId: "7", destroy: [outside] }, ctx);
    expect(calls.filter((c) => c.method === "DELETE").map((c) => new URL(c.url).pathname)).toEqual([]);
    expect(res.notDestroyed?.[outside]?.type).toBe("notFound");
  });

  it("does not ask the DAV server for a resource outside the address book", async () => {
    await contactCardGet({ accountId: "7", ids: [id(BOOK, "/books/someone-else/private/secret.vcf")] }, ctx);
    const reports = calls.filter((c) => c.method === "REPORT");
    expect(reports).toEqual([]);
  });

  it("still deletes a card that is in the book", async () => {
    const res = await contactCardSet({ accountId: "7", destroy: [id(BOOK, CARD)] }, ctx);
    expect(res.destroyed).toEqual([id(BOOK, CARD)]);
    expect(calls.filter((c) => c.method === "DELETE").map((c) => c.url)).toEqual([DAV_ORIGIN + CARD]);
  });

  it.each([
    ["a dot segment", `${BOOK}../../../calendars/u/work/x`],
    ["a percent-encoded dot segment", `${BOOK}%2e%2e/%2E%2E/%2e%2e/calendars/u/work/x`],
    ["a twice percent-encoded dot segment", `${BOOK}%252e%252e/%252e%252e/%252e%252e/calendars/u/work/x`],
    ["backslashes", `${BOOK}..\\..\\..\\calendars\\u\\work\\x`],
    ["an encoded slash inside a dot segment", `${BOOK}..%2F..%2F..%2Fcalendars%2Fu%2Fwork%2Fx`],
    ["a user name in front of another host", "http://dav.test:5232@other.example/books/u/contacts/one.vcf"],
    ["a scheme-relative address", "//other.example/books/u/contacts/one.vcf"],
    ["the book itself", BOOK],
    ["an empty segment", `${BOOK}/one.vcf`],
  ])("answers notFound and sends nothing for %s", async (_label, resource) => {
    const bad = id(BOOK, resource);
    const res = await contactCardSet(
      { accountId: "7", destroy: [bad], update: { [bad]: { name: { full: "X" } } } },
      ctx,
    );
    expect(res.notDestroyed?.[bad]?.type).toBe("notFound");
    expect(res.notUpdated?.[bad]?.type).toBe("notFound");
    expect(calls.filter((c) => c.method !== "PROPFIND")).toEqual([]);
    expect(foreign()).toEqual([]);

    const got = await contactCardGet({ accountId: "7", ids: [bad] }, ctx);
    expect(got.notFound).toEqual([bad]);
    expect(calls.filter((c) => c.method === "REPORT")).toEqual([]);
  });

  it("does not update a card outside the book", async () => {
    const outside = id(BOOK, "/books/u/other/one.vcf");
    const res = await contactCardSet({ accountId: "7", update: { [outside]: { name: { full: "X" } } } }, ctx);
    expect(res.notUpdated?.[outside]?.type).toBe("notFound");
    expect(calls.filter((c) => c.method === "REPORT" || c.method === "PUT")).toEqual([]);
  });

  it("still updates a card in the book", async () => {
    const res = await contactCardSet({ accountId: "7", update: { [id(BOOK, CARD)]: { name: { full: "Changed" } } } }, ctx);
    expect(res.updated).toEqual({ [id(BOOK, CARD)]: null });
    expect(calls.filter((c) => c.method === "PUT").map((c) => c.url)).toEqual([DAV_ORIGIN + CARD]);
  });

  it("accepts an absolute address on the DAV origin when it is in the book", async () => {
    // A server that writes absolute hrefs answers the multiget with them too.
    stubFetch((method, url, body) =>
      method === "REPORT" && body.includes(DAV_ORIGIN + CARD)
        ? ms(ok(DAV_ORIGIN + CARD, `<D:getetag>"e1"</D:getetag><C:address-data>${VCARD}</C:address-data>`))
        : dav(method, url, body),
    );
    const res = await contactCardGet({ accountId: "7", ids: [id(BOOK, DAV_ORIGIN + CARD)] }, ctx);
    expect(res.notFound).toEqual([]);
    expect(res.list).toHaveLength(1);
  });
});

describe("CardDavClient.isInBook", () => {
  const client = new CardDavClient({ host: "dav.test", port: 5232, secure: false, creds });

  it.each([
    ["/books/a/", "/books/a/card.vcf", true],
    ["/books/a", "/books/a/card.vcf", true],
    ["/books/a/", "/books/a/sub/card.vcf", true],
    ["/books/a/", "/books/a/100%25.vcf", true],
    ["/books/user%40x.io/a/", "/books/user@x.io/a/card.vcf", true],
    ["/books/a/", "http://dav.test:5232/books/a/card.vcf", true],
    ["http://dav.test:5232/books/a/", "/books/a/card.vcf", true],
    ["/books/a", "/books/ab/card.vcf", false],
    ["/books/a/", "/books/a%2Fcard.vcf", false],
    ["/books/a/", "https://dav.test:5232/books/a/card.vcf", false],
    ["/books/a/", "http://dav.test:5233/books/a/card.vcf", false],
    ["/books/a/", "http://u:p@dav.test:5232/books/a/card.vcf", false],
    ["/books/a/", "https://dav.example@other.example/books/a/card.vcf", false],
    ["/books/a/", "http:\\\\other.example\\books\\a\\card.vcf", false],
    ["/books/a/", "books/a/card.vcf", false],
    ["/books/a/", "/books/a/card.vcf?x=1", false],
    ["/books/a/", "/books/a/card.vcf#x", false],
    ["/books/a/", "/books/a/card\u0000.vcf", false],
    ["/books/a/", "/books/a/./card.vcf", false],
    ["/books/a/", "/books/a/%25252e%25252e/card.vcf", false],
    ["/books/a/", "/books/a/%252525252525252e/card.vcf", false],
  ])("book %s, resource %s: %s", (book, resource, expected) => {
    expect(client.isInBook(book, resource)).toBe(expected);
  });
});

describe("the CardDAV client stays on the configured origin", () => {
  it("does not follow a redirect to another host", async () => {
    stubFetch((method, url, body) =>
      url.origin === DAV_ORIGIN && method === "DELETE"
        ? new Response(null, { status: 307, headers: { location: "http://10.0.0.5:9200/x" } })
        : dav(method, url, body),
    );
    const res = await contactCardSet({ accountId: "7", destroy: [id(BOOK, CARD)] }, ctx);
    expect(foreign()).toEqual([]);
    expect(res.destroyed ?? []).toEqual([]);
    expect(res.notDestroyed?.[id(BOOK, CARD)]?.type).toBe("serverFail");
  });

  it("follows a redirect on the same origin", async () => {
    stubFetch((method, url, body) =>
      method === "DELETE" && url.pathname === CARD
        ? new Response(null, { status: 308, headers: { location: `${BOOK}moved.vcf` } })
        : dav(method, url, body),
    );
    const res = await contactCardSet({ accountId: "7", destroy: [id(BOOK, CARD)] }, ctx);
    expect(res.destroyed).toEqual([id(BOOK, CARD)]);
    expect(calls.filter((c) => c.method === "DELETE").map((c) => c.url)).toEqual([
      DAV_ORIGIN + CARD,
      `${DAV_ORIGIN}${BOOK}moved.vcf`,
    ]);
  });

  it("does not follow a redirect from https to http on the same host", async () => {
    const secure: ContactCtx = {
      ...ctx,
      provider: provider({ host: "dav.test", port: 443, secure: true, principalPath: "/books/u/" }),
    };
    stubFetch((method, url, body) => {
      if (url.protocol !== "https:") return new Response("INTERNAL-BANNER", { status: 418 });
      if (method === "DELETE") return new Response(null, { status: 301, headers: { location: `http://dav.test${CARD}` } });
      return dav(method, new URL(DAV_ORIGIN + url.pathname), body);
    });
    await contactCardSet({ accountId: "7", destroy: [id(BOOK, CARD)] }, secure);
    expect(calls.filter((c) => c.url.startsWith("http:"))).toEqual([]);
  });

  it("does not follow a discovery redirect that leaves the origin", async () => {
    const discovering: ContactCtx = { ...ctx, provider: provider({ host: "dav.test", port: 5232, secure: false }) };
    stubFetch((_method, url) =>
      url.origin !== DAV_ORIGIN
        ? new Response("INTERNAL-BANNER", { status: 418 })
        : new Response(null, { status: 301, headers: { location: "https://other.example/dav/" } }),
    );
    await expect(addressBookGet({ accountId: "7", ids: null }, discovering)).rejects.toThrow();
    expect(foreign()).toEqual([]);
  });

  it("does not send a request to an href on another host that the DAV server lists", async () => {
    const elsewhere = "http://10.0.0.5:9200/books/u/contacts/";
    stubFetch((method, url) => {
      if (url.origin !== DAV_ORIGIN) return new Response("INTERNAL-BANNER", { status: 418 });
      if (method === "PROPFIND") {
        return ms(ok(elsewhere, "<D:resourcetype><D:collection/><C:addressbook/></D:resourcetype><D:displayname>X</D:displayname>"));
      }
      return new Response(null, { status: 204 });
    });
    await expect(contactCardQuery({ accountId: "7" }, ctx)).rejects.toThrow();
    expect(foreign()).toEqual([]);
  });

  it("keeps the DAV server's answer out of JMAP errors", async () => {
    stubFetch((method, url, body) =>
      method === "DELETE"
        ? new Response("UPSTREAM-BODY-TEXT", { status: 500, statusText: "Upstream Reason Phrase" })
        : dav(method, url, body),
    );
    const res = await contactCardSet({ accountId: "7", destroy: [id(BOOK, CARD)] }, ctx);
    const err = res.notDestroyed?.[id(BOOK, CARD)];
    expect(err?.type).toBe("serverFail");
    expect(err?.description).toContain("500");
    expect(JSON.stringify(res)).not.toContain("UPSTREAM-BODY-TEXT");
    expect(JSON.stringify(res)).not.toContain("Upstream Reason Phrase");
  });
});
