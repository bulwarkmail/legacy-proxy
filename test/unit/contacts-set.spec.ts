// End-to-end tests for the CardDAV write path (ContactCard/set and
// AddressBook/set) against an in-memory fake DAV server bolted onto
// globalThis.fetch. The fake speaks just enough PROPFIND / REPORT / PUT /
// DELETE / MKCOL / PROPPATCH to exercise the real client + handlers.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  addressBookGet,
  addressBookSet,
  contactCardGet,
  contactCardSet,
  contactCardQuery,
  applyPatch,
  type ContactCtx,
} from "../../src/jmap/methods/contacts.js";
import type { AccountRow } from "../../src/state/store.js";
import type { ProviderConfig } from "../../src/util/config.js";

// -- fake CardDAV server ------------------------------------------------------

interface Resource {
  data: string;
  etag: string;
}
interface Book {
  displayName: string;
  description: string | null;
  resources: Map<string, Resource>;
}

const HOME = "/books/u/";
const PRINCIPAL = "/principals/u/";

class FakeDav {
  books = new Map<string, Book>();
  calls: Array<{ method: string; path: string; headers: Record<string, string>; body: string }> = [];
  private etagSeq = 0;

  addBook(slug: string, displayName: string, cards: Array<[string, string]> = []): string {
    const href = `${HOME}${slug}/`;
    const book: Book = { displayName, description: null, resources: new Map() };
    for (const [file, data] of cards) book.resources.set(href + file, { data, etag: this.nextEtag() });
    this.books.set(href, book);
    return href;
  }

  nextEtag(): string {
    return `"e${++this.etagSeq}"`;
  }

  handle(method: string, url: string, headers: Record<string, string>, body: string): Response {
    const path = decodeURIComponent(new URL(url).pathname);
    this.calls.push({ method, path, headers, body });
    if (headers["authorization"] !== "Basic " + Buffer.from("u:p").toString("base64")) {
      return new Response("nope", { status: 401 });
    }
    // Strict servers (Radicale) reject XML with a namespace-prefixed name
    // inside the local name — the client once emitted `<D:DAV:resourcetype/>`.
    if (/<[A-Za-z]+:[A-Za-z]+:/.test(body)) return new Response("malformed XML", { status: 400 });
    switch (method) {
      case "PROPFIND":
        return this.propfind(path, headers["depth"] ?? "0", body);
      case "REPORT":
        return this.report(path, body);
      case "PUT":
        return this.put(path, headers, body);
      case "DELETE":
        return this.delete(path, headers);
      case "MKCOL":
        return this.mkcol(path, body);
      case "PROPPATCH":
        return this.proppatch(path, body);
    }
    return new Response("method", { status: 405 });
  }

  private ms(responses: string): Response {
    const xml = `<?xml version="1.0"?><D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:carddav" xmlns:CS="http://calendarserver.org/ns/">${responses}</D:multistatus>`;
    return new Response(xml, { status: 207, headers: { "content-type": "application/xml" } });
  }

  private bookResponse(href: string, b: Book): string {
    const ctag = Array.from(b.resources.values()).map((r) => r.etag).join("");
    return `<D:response><D:href>${href}</D:href><D:propstat><D:prop>
      <D:resourcetype><D:collection/><C:addressbook/></D:resourcetype>
      <D:displayname>${esc(b.displayName)}</D:displayname>
      ${b.description ? `<C:addressbook-description>${esc(b.description)}</C:addressbook-description>` : ""}
      <CS:getctag>"${esc(ctag)}"</CS:getctag>
    </D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`;
  }

  private propfind(path: string, depth: string, body: string): Response {
    if (path === "/") {
      return this.ms(`<D:response><D:href>/</D:href><D:propstat><D:prop>
        <D:resourcetype><D:collection/></D:resourcetype>
        <D:current-user-principal><D:href>${PRINCIPAL}</D:href></D:current-user-principal>
      </D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`);
    }
    if (path === PRINCIPAL) {
      return this.ms(`<D:response><D:href>${PRINCIPAL}</D:href><D:propstat><D:prop>
        <C:addressbook-home-set><D:href>${HOME}</D:href></C:addressbook-home-set>
      </D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`);
    }
    if (path === HOME) {
      const self = `<D:response><D:href>${HOME}</D:href><D:propstat><D:prop><D:resourcetype><D:collection/></D:resourcetype></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`;
      if (depth === "0") return this.ms(self);
      return this.ms(self + Array.from(this.books.entries()).map(([h, b]) => this.bookResponse(h, b)).join(""));
    }
    const book = this.books.get(path);
    if (book) {
      let out = this.bookResponse(path, book);
      if (depth === "1") {
        for (const [h, r] of book.resources) {
          out += `<D:response><D:href>${h}</D:href><D:propstat><D:prop><D:resourcetype/><D:getetag>${esc(r.etag)}</D:getetag></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`;
        }
      }
      return this.ms(out);
    }
    void body;
    return new Response("not found", { status: 404 });
  }

  private report(path: string, body: string): Response {
    const book = this.books.get(path);
    if (!book) return new Response("not found", { status: 404 });
    const hrefs = Array.from(body.matchAll(/<D:href>([^<]+)<\/D:href>/g)).map((m) => m[1]!);
    let out = "";
    for (const h of hrefs) {
      const r = book.resources.get(h);
      if (!r) {
        out += `<D:response><D:href>${h}</D:href><D:status>HTTP/1.1 404 Not Found</D:status></D:response>`;
        continue;
      }
      out += `<D:response><D:href>${h}</D:href><D:propstat><D:prop><D:getetag>${esc(r.etag)}</D:getetag><C:address-data>${esc(r.data)}</C:address-data></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`;
    }
    return this.ms(out);
  }

  private bookFor(resourcePath: string): [string, Book] | null {
    for (const [h, b] of this.books) if (resourcePath.startsWith(h)) return [h, b];
    return null;
  }

  private put(path: string, headers: Record<string, string>, body: string): Response {
    const hit = this.bookFor(path);
    if (!hit) return new Response("no such collection", { status: 409 });
    const [, book] = hit;
    const existing = book.resources.get(path);
    if (headers["if-none-match"] === "*" && existing) return new Response("exists", { status: 412 });
    if (headers["if-match"] && (!existing || existing.etag !== headers["if-match"])) {
      return new Response("etag mismatch", { status: 412 });
    }
    if (!/^text\/vcard/.test(headers["content-type"] ?? "")) return new Response("type", { status: 415 });
    if (!/BEGIN:VCARD/.test(body) || !/\r\nUID:/.test(body)) return new Response("bad vcard", { status: 400 });
    const etag = this.nextEtag();
    book.resources.set(path, { data: body, etag });
    return new Response(null, { status: existing ? 204 : 201, headers: { etag } });
  }

  private delete(path: string, headers: Record<string, string>): Response {
    if (this.books.has(path)) {
      this.books.delete(path);
      return new Response(null, { status: 204 });
    }
    const hit = this.bookFor(path);
    if (!hit) return new Response("not found", { status: 404 });
    const [, book] = hit;
    const existing = book.resources.get(path);
    if (!existing) return new Response("not found", { status: 404 });
    if (headers["if-match"] && existing.etag !== headers["if-match"]) return new Response("etag", { status: 412 });
    book.resources.delete(path);
    return new Response(null, { status: 204 });
  }

  private mkcol(path: string, body: string): Response {
    if (this.books.has(path)) return new Response("exists", { status: 405 });
    if (!path.startsWith(HOME)) return new Response("conflict", { status: 409 });
    if (!/<C:addressbook\/>/.test(body)) return new Response("not an addressbook", { status: 403 });
    const name = /<D:displayname>([^<]*)<\/D:displayname>/.exec(body)?.[1] ?? "";
    const desc = /<C:addressbook-description>([^<]*)<\/C:addressbook-description>/.exec(body)?.[1] ?? null;
    this.books.set(path, { displayName: unesc(name), description: desc ? unesc(desc) : null, resources: new Map() });
    return new Response(null, { status: 201 });
  }

  private proppatch(path: string, body: string): Response {
    const book = this.books.get(path);
    if (!book) return new Response("not found", { status: 404 });
    const name = /<D:displayname>([^<]*)<\/D:displayname>/.exec(body)?.[1];
    if (name !== undefined) book.displayName = unesc(name);
    const desc = /<C:addressbook-description>([^<]*)<\/C:addressbook-description>/.exec(body)?.[1];
    if (desc !== undefined) book.description = unesc(desc);
    if (/<D:remove>[\s\S]*addressbook-description/.test(body)) book.description = null;
    return this.ms(`<D:response><D:href>${path}</D:href><D:propstat><D:prop><D:displayname/></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`);
  }
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function unesc(s: string): string {
  return s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&amp;/g, "&");
}

// -- fixtures -----------------------------------------------------------------

const provider: ProviderConfig = {
  imap: { host: "imap.test", port: 993 },
  smtp: { host: "smtp.test", port: 465 },
  sieve: null,
  carddav: { host: "dav.test", port: 443, secure: true, basePath: "/" },
  auth: { mech: ["PLAIN"] },
};

const ctx: ContactCtx = {
  account: { id: 7, username: "u" } as AccountRow,
  provider,
  creds: { mech: "PLAIN", username: "u", password: "p" },
};

const ALICE = [
  "BEGIN:VCARD",
  "VERSION:4.0",
  "UID:alice-uid",
  "FN:Alice Example",
  "N:Example;Alice;;;",
  "EMAIL;TYPE=work:alice@example.test",
  "PHOTO;ENCODING=b;TYPE=JPEG:/9j/4AAQSkZJRg==",
  "X-CUSTOM-THING:keep me",
  "END:VCARD",
  "",
].join("\r\n");

let dav: FakeDav;

beforeEach(() => {
  dav = new FakeDav();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries((init?.headers ?? {}) as Record<string, string>)) headers[k.toLowerCase()] = v;
      return dav.handle(init?.method ?? "GET", url, headers, typeof init?.body === "string" ? init.body : "");
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function ids(): Promise<{ bookId: string; cardIds: string[] }> {
  const books = await addressBookGet({ accountId: "7", ids: null }, ctx);
  const q = await contactCardQuery({ accountId: "7" }, ctx);
  return { bookId: books.list[0]!.id, cardIds: q.ids };
}

// -- ContactCard/set ------------------------------------------------------------

describe("ContactCard/set", () => {
  it("creates a card with PUT + If-None-Match and returns a fetchable id", async () => {
    dav.addBook("personal", "Personal");
    const { bookId } = await ids();

    const res = await contactCardSet(
      {
        accountId: "7",
        create: {
          "new-contact": {
            "@type": "Card",
            uid: "urn:uuid:new-1",
            addressBookIds: { [bookId]: true },
            name: { components: [{ kind: "given", value: "Bob" }, { kind: "surname", value: "Builder" }] },
            emails: { e1: { address: "bob@example.test", contexts: { work: true } } },
            phones: { p1: { number: "+1 555 0100", features: { mobile: true } } },
          },
        },
      },
      ctx,
    );

    expect(res.notCreated).toBeNull();
    const created = res.created?.["new-contact"];
    expect(created?.id).toBeTruthy();
    expect(res.newState).not.toBe(res.oldState);

    const put = dav.calls.find((c) => c.method === "PUT");
    expect(put?.headers["if-none-match"]).toBe("*");
    expect(put?.headers["content-type"]).toMatch(/^text\/vcard/);
    expect(put?.body).toContain("UID:urn:uuid:new-1");
    expect(put?.body).toContain("FN:Bob Builder");
    expect(put?.body).toContain("N:Builder;Bob;;;");
    expect(put?.body).toContain("EMAIL;TYPE=work:bob@example.test");
    expect(put?.body).toContain("TEL;TYPE=cell:+1 555 0100");

    // The id round-trips through ContactCard/get (what webmail does next).
    const got = await contactCardGet({ accountId: "7", ids: [created!.id] }, ctx);
    expect(got.notFound).toEqual([]);
    expect(got.list[0]).toMatchObject({
      id: created!.id,
      uid: "urn:uuid:new-1",
      name: { full: "Bob Builder" },
      addressBookIds: { [bookId]: true },
    });
  });

  it("falls back to the first address book and mints a uid when none is given", async () => {
    dav.addBook("personal", "Personal");
    const res = await contactCardSet(
      { accountId: "7", create: { c: { name: { full: "No Book" } } } },
      ctx,
    );
    expect(res.created?.["c"]?.uid).toMatch(/^urn:uuid:/);
    const put = dav.calls.find((c) => c.method === "PUT");
    expect(put?.path.startsWith(`${HOME}personal/`)).toBe(true);
  });

  it("auto-creates a default book when the account has none (fresh Radicale)", async () => {
    const res = await contactCardSet(
      { accountId: "7", create: { c: { name: { full: "First Ever" } } } },
      ctx,
    );
    expect(res.notCreated).toBeNull();
    const mkcol = dav.calls.find((c) => c.method === "MKCOL");
    expect(mkcol?.path).toBe(`${HOME}contacts/`);
    expect(mkcol?.body).toContain("<D:displayname>Contacts</D:displayname>");
    const put = dav.calls.find((c) => c.method === "PUT");
    expect(put?.path.startsWith(`${HOME}contacts/`)).toBe(true);
    const books = await addressBookGet({ accountId: "7", ids: null }, ctx);
    expect(books.list.map((b) => b.name)).toEqual(["Contacts"]);
  });

  it("does not auto-create a book when an explicit (unknown) addressBookId is given", async () => {
    const res = await contactCardSet(
      { accountId: "7", create: { c: { name: { full: "Nowhere" }, addressBookIds: { bogus: true } } } },
      ctx,
    );
    expect(res.notCreated?.["c"]).toMatchObject({ type: "invalidProperties", properties: ["addressBookIds"] });
    expect(dav.calls.some((c) => c.method === "PUT" || c.method === "MKCOL")).toBe(false);
  });

  it("updates in place, preserving unmodelled properties and using If-Match", async () => {
    dav.addBook("personal", "Personal", [["alice.vcf", ALICE]]);
    const { cardIds } = await ids();
    const [aliceId] = cardIds;

    const res = await contactCardSet(
      {
        accountId: "7",
        update: {
          [aliceId!]: {
            id: aliceId, // echoed back unchanged — must be tolerated
            uid: "alice-uid",
            name: { full: "Alice Changed", components: [{ kind: "given", value: "Alice" }, { kind: "surname", value: "Changed" }] },
            "emails/e1/address": "alice+new@example.test",
            notes: { n1: { note: "line one\nline two" } },
          },
        },
      },
      ctx,
    );

    expect(res.notUpdated).toBeNull();
    expect(res.updated).toEqual({ [aliceId!]: null });

    const put = dav.calls.find((c) => c.method === "PUT")!;
    expect(put.headers["if-match"]).toBe('"e1"');
    expect(put.body).toContain("FN:Alice Changed");
    expect(put.body).toContain("EMAIL;TYPE=work:alice+new@example.test");
    expect(put.body).toContain("NOTE:line one\\nline two");
    // Properties we don't model survive the round trip.
    expect(put.body).toContain("PHOTO;ENCODING=b;TYPE=JPEG:/9j/4AAQSkZJRg==");
    expect(put.body).toContain("X-CUSTOM-THING:keep me");
    expect(put.body).toContain("UID:alice-uid");
    expect(put.body.match(/^FN:/gm)).toHaveLength(1);
  });

  it("removes a sub-property when patched with null", async () => {
    dav.addBook("personal", "Personal", [["alice.vcf", ALICE]]);
    const { cardIds } = await ids();
    const res = await contactCardSet({ accountId: "7", update: { [cardIds[0]!]: { "emails/e1": null } } }, ctx);
    expect(res.updated).toEqual({ [cardIds[0]!]: null });
    const put = dav.calls.find((c) => c.method === "PUT")!;
    expect(put.body).not.toContain("EMAIL");
  });

  it("refuses to move a card between books or change its uid", async () => {
    dav.addBook("personal", "Personal", [["alice.vcf", ALICE]]);
    const other = dav.addBook("other", "Other");
    const { cardIds } = await ids();
    const otherId = Buffer.from(other, "utf8").toString("base64url");
    const res = await contactCardSet(
      {
        accountId: "7",
        update: {
          [cardIds[0]!]: { addressBookIds: { [otherId]: true } },
        },
      },
      ctx,
    );
    expect(res.notUpdated?.[cardIds[0]!]).toMatchObject({ type: "invalidProperties", properties: ["addressBookIds"] });
    expect(dav.calls.some((c) => c.method === "PUT")).toBe(false);
  });

  it("reports stateMismatch when the server-side ETag moved underneath us", async () => {
    dav.addBook("personal", "Personal", [["alice.vcf", ALICE]]);
    const { cardIds } = await ids();
    // Simulate another client editing between our read and our write.
    const originalHandle = dav.handle.bind(dav);
    dav.handle = (method, url, headers, body) => {
      if (method === "PUT") {
        const book = dav.books.get(`${HOME}personal/`)!;
        const r = book.resources.get(`${HOME}personal/alice.vcf`)!;
        r.etag = '"moved"';
      }
      return originalHandle(method, url, headers, body);
    };
    const res = await contactCardSet({ accountId: "7", update: { [cardIds[0]!]: { name: { full: "X" } } } }, ctx);
    expect(res.notUpdated?.[cardIds[0]!]?.type).toBe("stateMismatch");
  });

  it("destroys via DELETE and reports unknown ids as notFound", async () => {
    dav.addBook("personal", "Personal", [["alice.vcf", ALICE]]);
    const { cardIds } = await ids();
    const bogus = Buffer.from(`${HOME}personal/\n${HOME}personal/nope.vcf`).toString("base64url");
    const res = await contactCardSet({ accountId: "7", destroy: [cardIds[0]!, bogus, "garbage"] }, ctx);
    // A DELETE on a missing resource is idempotent success on the DAV side;
    // ids that don't decode to a known book are notFound.
    expect(res.destroyed).toEqual([cardIds[0]!, bogus]);
    expect(res.notDestroyed).toEqual({ garbage: { type: "notFound" } });
    expect(dav.books.get(`${HOME}personal/`)!.resources.size).toBe(0);
  });

  it("honours ifInState", async () => {
    dav.addBook("personal", "Personal", [["alice.vcf", ALICE]]);
    await expect(
      contactCardSet({ accountId: "7", ifInState: "stale", destroy: [] }, ctx),
    ).rejects.toMatchObject({ type: "stateMismatch" });
  });

  it("rejects a foreign accountId", async () => {
    await expect(contactCardSet({ accountId: "8" }, ctx)).rejects.toMatchObject({ type: "accountNotFound" });
  });
});

// -- AddressBook/set ------------------------------------------------------------

describe("AddressBook/set", () => {
  it("creates a collection with extended MKCOL and returns server-set props", async () => {
    dav.addBook("personal", "Personal");
    const res = await addressBookSet(
      { accountId: "7", create: { "new-book": { name: "Work Friends", description: "colleagues" } } },
      ctx,
    );
    expect(res.notCreated).toBeNull();
    const created = res.created?.["new-book"];
    expect(created?.id).toBe(Buffer.from(`${HOME}work-friends/`).toString("base64url"));
    expect(created).toMatchObject({ isDefault: false, myRights: { mayWrite: true, mayDelete: true } });

    const mkcol = dav.calls.find((c) => c.method === "MKCOL")!;
    expect(mkcol.path).toBe(`${HOME}work-friends/`);
    expect(mkcol.body).toContain("<C:addressbook/>");
    expect(mkcol.body).toContain("<D:displayname>Work Friends</D:displayname>");
    expect(mkcol.body).toContain("<C:addressbook-description>colleagues</C:addressbook-description>");

    const books = await addressBookGet({ accountId: "7", ids: null }, ctx);
    expect(books.list.map((b) => b.name)).toEqual(["Personal", "Work Friends"]);
  });

  it("falls back to a UUID slug for non-ASCII or colliding names", async () => {
    dav.addBook("personal", "Personal");
    const res = await addressBookSet(
      { accountId: "7", create: { a: { name: "Personal" }, b: { name: "Freunde – Zürich" } } },
      ctx,
    );
    expect(res.notCreated).toBeNull();
    const paths = dav.calls.filter((c) => c.method === "MKCOL").map((c) => c.path);
    expect(paths[0]).toMatch(new RegExp(`^${HOME}[0-9a-f-]{36}/$`));
    expect(paths[1]).toBe(`${HOME}freunde-z-rich/`);
  });

  it("renames via PROPPATCH and ignores client-only preferences", async () => {
    const href = dav.addBook("personal", "Personal");
    const id = Buffer.from(href).toString("base64url");
    const res = await addressBookSet(
      { accountId: "7", update: { [id]: { name: "Renamed", isDefault: true, color: "#f00" } } },
      ctx,
    );
    expect(res.updated).toEqual({ [id]: null });
    expect(dav.books.get(href)!.displayName).toBe("Renamed");
    const pp = dav.calls.find((c) => c.method === "PROPPATCH")!;
    expect(pp.body).toContain("<D:displayname>Renamed</D:displayname>");
  });

  it("rejects unsupported properties and empty names", async () => {
    const href = dav.addBook("personal", "Personal");
    const id = Buffer.from(href).toString("base64url");
    const res = await addressBookSet(
      {
        accountId: "7",
        create: { x: { name: "   " } },
        update: { [id]: { "shareWith/someone": { mayRead: true } } },
      },
      ctx,
    );
    expect(res.notCreated?.["x"]).toMatchObject({ type: "invalidProperties", properties: ["name"] });
    expect(res.notUpdated?.[id]).toMatchObject({ type: "invalidProperties", properties: ["shareWith/someone"] });
  });

  it("refuses to destroy a non-empty book unless onDestroyRemoveContents", async () => {
    const href = dav.addBook("personal", "Personal", [["alice.vcf", ALICE]]);
    const id = Buffer.from(href).toString("base64url");

    const refused = await addressBookSet({ accountId: "7", destroy: [id] }, ctx);
    expect(refused.notDestroyed).toEqual({ [id]: { type: "addressBookHasContents" } });
    expect(dav.books.has(href)).toBe(true);

    const ok = await addressBookSet({ accountId: "7", destroy: [id], onDestroyRemoveContents: true }, ctx);
    expect(ok.destroyed).toEqual([id]);
    expect(dav.books.has(href)).toBe(false);
  });
});

// -- patch helper ---------------------------------------------------------------

describe("applyPatch", () => {
  it("sets nested paths, replaces top-level keys, and deletes on null", () => {
    const o: Record<string, unknown> = { emails: { e1: { address: "a@x" }, e2: { address: "b@x" } }, name: { full: "A" } };
    applyPatch(o, { "emails/e1/address": "z@x", "emails/e2": null, name: { full: "B" }, "notes/n1": { note: "hi" } });
    expect(o).toEqual({ emails: { e1: { address: "z@x" } }, name: { full: "B" }, notes: { n1: { note: "hi" } } });
  });

  it("rejects empty path segments", () => {
    expect(() => applyPatch({}, { "a//b": 1 })).toThrow(/bad path/);
  });
});
