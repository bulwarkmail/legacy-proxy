// Minimal CardDAV client (RFC 6352). Implements just what we need to back
// JMAP for Contacts (RFC 9610): discover the user's address books, list the
// vCards in each, fetch them in batches, and write them back (PUT / DELETE
// on resources, extended MKCOL / PROPPATCH / DELETE on collections). We do
// not implement the change feed (sync-collection) yet; address-book state is
// computed from a content hash of each book's resources.
//
// We avoid a heavyweight WebDAV/XML library; the protocol surface we touch
// is small enough to hand-parse with a regex-based extractor that only looks
// at element local-names. CardDAV servers (Stalwart, Radicale, SOGo, Baikal,
// Apple Contacts Server, …) all emit predictable XML for these requests.

import { Buffer } from "node:buffer";
import type { Credentials } from "../auth/credentials.js";
import { log } from "../util/log.js";

export interface CardDavOpts {
  host: string;
  port: number;
  secure?: boolean;
  basePath?: string;        // e.g. "/dav" - root of the DAV namespace
  principalPath?: string;   // override discovery, e.g. "/dav/addressbook/user@x.io/"
  creds: Credentials;
}

export interface AddressBookInfo {
  /** Server-side path, slash-terminated. Stable per address book. */
  href: string;
  displayName: string;
  description: string | null;
  /** ctag or sync-token, when offered. Used to derive a JMAP state string. */
  ctag: string | null;
}

export interface VCardResource {
  /** Server path of the .vcf resource. */
  href: string;
  etag: string | null;
  data: string;
}

export class CardDavClient {
  private readonly opts: CardDavOpts;
  private readonly origin: string;
  private readonly authHeader: string;

  constructor(opts: CardDavOpts) {
    this.opts = opts;
    const proto = opts.secure ? "https" : "http";
    this.origin = `${proto}://${opts.host}:${opts.port}`;
    this.authHeader = buildAuth(opts.creds);
  }

  /** Find the principal URL via /.well-known/carddav (RFC 6764 §6). */
  async discoverPrincipal(): Promise<string> {
    if (this.opts.principalPath) return this.opts.principalPath;

    const start = this.opts.basePath ?? "/.well-known/carddav";
    // 1. follow redirects from .well-known to the DAV root.
    const root = await this.followToCollection(start);

    // 2. PROPFIND on the DAV root for current-user-principal.
    const xml = await this.propfind(root, 0, [
      "DAV:current-user-principal",
    ]);
    const principal = pickHref(xml, "current-user-principal");
    if (principal) return principal;
    return root;
  }

  /** From the principal URL, locate the addressbook-home-set (slash-terminated). */
  async addressBookHome(): Promise<string> {
    const principal = await this.discoverPrincipal();
    const homeXml = await this.propfind(principal, 0, [
      "urn:ietf:params:xml:ns:carddav addressbook-home-set",
    ]);
    const home = pickHref(homeXml, "addressbook-home-set") ?? principal;
    return home.endsWith("/") ? home : home + "/";
  }

  /**
   * From a principal URL, locate the addressbook-home-set, then enumerate
   * every addressbook collection beneath it.
   */
  async listAddressBooks(): Promise<AddressBookInfo[]> {
    const home = await this.addressBookHome();

    const xml = await this.propfind(home, 1, [
      "DAV:resourcetype",
      "DAV:displayname",
      "urn:ietf:params:xml:ns:carddav addressbook-description",
      "http://calendarserver.org/ns/ getctag",
      "DAV:sync-token",
    ]);

    const responses = splitResponses(xml);
    const books: AddressBookInfo[] = [];
    for (const r of responses) {
      if (!hasResourceType(r, "addressbook")) continue;
      const href = extractHref(r);
      if (!href) continue;
      books.push({
        href,
        displayName: textOf(r, "displayname") ?? leafName(href),
        description: textOf(r, "addressbook-description"),
        ctag: textOf(r, "getctag") ?? textOf(r, "sync-token"),
      });
    }
    return books;
  }

  /** List the .vcf resources in a single address-book collection. */
  async listResources(bookHref: string): Promise<Array<{ href: string; etag: string | null }>> {
    const xml = await this.propfind(bookHref, 1, ["DAV:getetag", "DAV:resourcetype"]);
    const responses = splitResponses(xml);
    const out: Array<{ href: string; etag: string | null }> = [];
    for (const r of responses) {
      if (hasResourceType(r, "collection")) continue; // skip the book itself
      const href = extractHref(r);
      if (!href) continue;
      out.push({ href, etag: textOf(r, "getetag") });
    }
    return out;
  }

  /**
   * Fetch a batch of vCards by href via `addressbook-multiget` (RFC 6352
   * §8.7). One round trip per chunk.
   */
  async multiGet(bookHref: string, hrefs: string[]): Promise<VCardResource[]> {
    if (hrefs.length === 0) return [];
    const body =
      `<?xml version="1.0" encoding="utf-8" ?>\n` +
      `<C:addressbook-multiget xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:carddav">\n` +
      `  <D:prop><D:getetag/><C:address-data/></D:prop>\n` +
      hrefs.map((h) => `  <D:href>${escapeXml(h)}</D:href>`).join("\n") +
      `\n</C:addressbook-multiget>`;

    const xml = await this.request("REPORT", bookHref, body, { Depth: "1" });
    const responses = splitResponses(xml);
    const out: VCardResource[] = [];
    for (const r of responses) {
      const href = extractHref(r);
      const data = textOf(r, "address-data");
      if (!href || !data) continue;
      out.push({ href, etag: textOf(r, "getetag"), data });
    }
    return out;
  }

  // -- writes ---------------------------------------------------------------

  /**
   * Store a vCard. `ifMatch` guards an update against concurrent edits
   * (RFC 7232 §3.1); without it we send `If-None-Match: *` so a create can
   * never clobber an existing resource. Returns the new ETag when the server
   * offers one.
   */
  async putResource(
    href: string,
    vcard: string,
    opts: { ifMatch?: string | null } = {},
  ): Promise<{ etag: string | null }> {
    const headers: Record<string, string> = { "Content-Type": "text/vcard; charset=utf-8" };
    if (opts.ifMatch) headers["If-Match"] = opts.ifMatch;
    else headers["If-None-Match"] = "*";
    const res = await this.raw("PUT", href, vcard, headers);
    if (res.status === 412) throw new CardDavConflict(href);
    if (!res.ok) throw await httpError("PUT", href, res);
    return { etag: res.headers.get("etag") };
  }

  /** Delete a vCard resource (or an address-book collection). Missing is fine. */
  async deleteResource(href: string, opts: { ifMatch?: string | null } = {}): Promise<void> {
    const headers: Record<string, string> = {};
    if (opts.ifMatch) headers["If-Match"] = opts.ifMatch;
    const res = await this.raw("DELETE", href, null, headers);
    if (res.status === 412) throw new CardDavConflict(href);
    if (!res.ok && res.status !== 404) throw await httpError("DELETE", href, res);
  }

  /**
   * Create an address-book collection via extended MKCOL (RFC 5689), which
   * lets us set the resourcetype and display name in one round trip. Radicale,
   * Stalwart, Baikal, SOGo and Apple's server all accept this form.
   */
  async makeAddressBook(
    href: string,
    props: { displayName: string; description?: string | null },
  ): Promise<void> {
    const body =
      `<?xml version="1.0" encoding="utf-8"?>\n` +
      `<D:mkcol xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:carddav">\n` +
      `  <D:set><D:prop>\n` +
      `    <D:resourcetype><D:collection/><C:addressbook/></D:resourcetype>\n` +
      `    <D:displayname>${escapeXml(props.displayName)}</D:displayname>\n` +
      (props.description ? `    <C:addressbook-description>${escapeXml(props.description)}</C:addressbook-description>\n` : "") +
      `  </D:prop></D:set>\n` +
      `</D:mkcol>`;
    const res = await this.raw("MKCOL", href, body, { "Content-Type": "application/xml; charset=utf-8" });
    if (res.status === 405) throw new CardDavConflict(href); // already exists
    if (!res.ok) throw await httpError("MKCOL", href, res);
    // 207 from an extended MKCOL means some property failed to set.
    if (res.status === 207) {
      const text = await res.text();
      if (/HTTP\/1\.[01] (4\d\d|5\d\d)/.test(text)) {
        throw new Error(`CardDAV MKCOL ${href} → property failure: ${text.slice(0, 200)}`);
      }
    }
  }

  /** PROPPATCH displayname / addressbook-description on a collection. */
  async updateAddressBookProps(
    href: string,
    props: { displayName?: string; description?: string | null },
  ): Promise<void> {
    const set: string[] = [];
    const remove: string[] = [];
    if (props.displayName !== undefined) set.push(`<D:displayname>${escapeXml(props.displayName)}</D:displayname>`);
    if (props.description !== undefined) {
      if (props.description) set.push(`<C:addressbook-description>${escapeXml(props.description)}</C:addressbook-description>`);
      else remove.push(`<C:addressbook-description/>`);
    }
    if (set.length === 0 && remove.length === 0) return;
    const body =
      `<?xml version="1.0" encoding="utf-8"?>\n` +
      `<D:propertyupdate xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:carddav">\n` +
      (set.length ? `  <D:set><D:prop>${set.join("")}</D:prop></D:set>\n` : "") +
      (remove.length ? `  <D:remove><D:prop>${remove.join("")}</D:prop></D:remove>\n` : "") +
      `</D:propertyupdate>`;
    const res = await this.raw("PROPPATCH", href, body, { "Content-Type": "application/xml; charset=utf-8" });
    if (!res.ok && res.status !== 207) throw await httpError("PROPPATCH", href, res);
    const text = await res.text();
    if (/HTTP\/1\.[01] (4\d\d|5\d\d)/.test(text)) {
      throw new Error(`CardDAV PROPPATCH ${href} → property failure: ${text.slice(0, 200)}`);
    }
  }

  // -- low-level ----------------------------------------------------------

  private async raw(
    method: string,
    path: string,
    body: string | null,
    headers: Record<string, string> = {},
  ): Promise<Response> {
    const url = absolutise(this.origin, path);
    const res = await fetch(url, {
      method,
      headers: { Authorization: this.authHeader, ...headers },
      ...(body === null ? {} : { body }),
    });
    log.debug({ method, url, status: res.status }, "carddav request");
    return res;
  }

  private async followToCollection(path: string): Promise<string> {
    let url = absolutise(this.origin, path);
    for (let i = 0; i < 4; i++) {
      const res = await fetch(url, {
        method: "PROPFIND",
        headers: { Authorization: this.authHeader, Depth: "0", "Content-Type": "application/xml" },
        body: '<?xml version="1.0"?><D:propfind xmlns:D="DAV:"><D:prop><D:resourcetype/></D:prop></D:propfind>',
        redirect: "manual",
      });
      log.debug({ url, status: res.status }, "carddav discovery probe");
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get("location");
        if (!loc) break;
        url = absolutise(this.origin, loc);
        continue;
      }
      // surface auth/server errors here so callers see a useful message
      if (res.status === 401 || res.status === 403) {
        throw new Error(`CardDAV ${res.status}: auth required`);
      }
      const u = new URL(url);
      return u.pathname.endsWith("/") ? u.pathname : u.pathname + "/";
    }
    throw new Error("CardDAV: too many redirects in discovery");
  }

  private async propfind(path: string, depth: 0 | 1, props: string[]): Promise<string> {
    const ns = collectNamespaces(props);
    const propXml = props.map((p) => {
      const [nsUri, name] = splitProp(p);
      const prefix = ns.prefix(nsUri);
      return `<${prefix}:${name}/>`;
    }).join("");

    const body =
      `<?xml version="1.0" encoding="utf-8"?>\n` +
      `<D:propfind ${ns.declarations()}>\n` +
      `  <D:prop>${propXml}</D:prop>\n` +
      `</D:propfind>`;
    return this.request("PROPFIND", path, body, { Depth: String(depth) });
  }

  private async request(
    method: string,
    path: string,
    body: string,
    extra: Record<string, string> = {},
  ): Promise<string> {
    const res = await this.raw(method, path, body, {
      "Content-Type": "application/xml; charset=utf-8",
      ...extra,
    });
    if (!res.ok && res.status !== 207) throw await httpError(method, path, res);
    return await res.text();
  }
}

/** Thrown on 412 (If-Match / If-None-Match failed) or 405 on MKCOL (exists). */
export class CardDavConflict extends Error {
  constructor(readonly href: string) {
    super(`CardDAV conflict on ${href}`);
  }
}

async function httpError(method: string, path: string, res: Response): Promise<Error> {
  const text = await res.text().catch(() => "");
  log.warn({ method, path, status: res.status }, "carddav request failed");
  return new Error(`CardDAV ${method} ${path} → ${res.status} ${res.statusText}: ${text.slice(0, 200)}`);
}

// -----------------------------------------------------------------------
// XML helpers (deliberately small, namespace-aware on local name only).
// -----------------------------------------------------------------------

function buildAuth(c: Credentials): string {
  if (c.mech === "PLAIN" && c.password) {
    const b64 = Buffer.from(`${c.username}:${c.password}`).toString("base64");
    return `Basic ${b64}`;
  }
  if (c.mech === "XOAUTH2" && c.accessToken) {
    return `Bearer ${c.accessToken}`;
  }
  if (c.password) {
    const b64 = Buffer.from(`${c.username}:${c.password}`).toString("base64");
    return `Basic ${b64}`;
  }
  throw new Error(`unsupported carddav auth mech: ${c.mech}`);
}

function absolutise(origin: string, pathOrUrl: string): string {
  if (/^https?:\/\//i.test(pathOrUrl)) return pathOrUrl;
  if (!pathOrUrl.startsWith("/")) pathOrUrl = "/" + pathOrUrl;
  return origin + pathOrUrl;
}

function leafName(href: string): string {
  const trimmed = href.replace(/\/+$/, "");
  const idx = trimmed.lastIndexOf("/");
  return decodeURIComponent(idx >= 0 ? trimmed.slice(idx + 1) : trimmed);
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Property spec → [namespace URI, local name]. Accepts `"<uri> <name>"`,
 * the shorthand `"DAV:<name>"`, or a bare name (DAV: namespace).
 *
 * The shorthand used to be emitted verbatim as `<D:DAV:resourcetype/>` —
 * malformed XML that lenient servers (Stalwart) ignore by answering allprop,
 * but strict ones (Radicale) reject outright.
 */
export function splitProp(p: string): [string, string] {
  if (p.includes(" ")) {
    const idx = p.indexOf(" ");
    return [p.slice(0, idx), p.slice(idx + 1).trim()];
  }
  if (p.startsWith("DAV:")) return ["DAV:", p.slice(4)];
  return ["DAV:", p];
}

function collectNamespaces(props: string[]): { prefix(uri: string): string; declarations(): string } {
  const map = new Map<string, string>([
    ["DAV:", "D"],
    ["urn:ietf:params:xml:ns:carddav", "C"],
    ["http://calendarserver.org/ns/", "CS"],
  ]);
  for (const p of props) {
    const [uri] = splitProp(p);
    if (!map.has(uri)) map.set(uri, `n${map.size}`);
  }
  return {
    prefix: (uri: string) => map.get(uri) ?? "D",
    declarations: () =>
      Array.from(map.entries())
        .map(([uri, prefix]) => `xmlns:${prefix}="${uri}"`)
        .join(" "),
  };
}

/** Split a multistatus body into one chunk per <response>. */
export function splitResponses(xml: string): string[] {
  const re = /<(?:[A-Za-z][\w-]*:)?response\b[^>]*>([\s\S]*?)<\/(?:[A-Za-z][\w-]*:)?response>/g;
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    if (m[1] !== undefined) out.push(m[1]);
  }
  return out;
}

/** Pull the first <href> child, decoded. */
export function extractHref(chunk: string): string | null {
  const m = /<(?:[A-Za-z][\w-]*:)?href\b[^>]*>([\s\S]*?)<\/(?:[A-Za-z][\w-]*:)?href>/i.exec(chunk);
  if (!m || m[1] === undefined) return null;
  try {
    return decodeXmlText(m[1]).trim();
  } catch {
    return m[1].trim();
  }
}

/** Read the text content of the first element with the given local name. */
export function textOf(chunk: string, localName: string): string | null {
  const re = new RegExp(
    `<(?:[A-Za-z][\\w-]*:)?${localName}\\b[^>]*?(?:/>|>([\\s\\S]*?)</(?:[A-Za-z][\\w-]*:)?${localName}>)`,
    "i",
  );
  const m = re.exec(chunk);
  if (!m) return null;
  if (m[0].endsWith("/>")) return "";
  if (m[1] === undefined) return null;
  return decodeXmlText(m[1]).trim();
}

/** Detect a resourcetype that includes a given local name (e.g. "addressbook"). */
export function hasResourceType(chunk: string, localName: string): boolean {
  const block = textOf(chunk, "resourcetype");
  if (block !== null) {
    return new RegExp(`<(?:[A-Za-z][\\w-]*:)?${localName}\\b`, "i").test(block);
  }
  // Some servers return resourcetype as a self-closing wrapper; fall back to a
  // raw scan of the chunk.
  return new RegExp(`<(?:[A-Za-z][\\w-]*:)?resourcetype\\b[^>]*>[\\s\\S]*?<(?:[A-Za-z][\\w-]*:)?${localName}\\b`, "i").test(chunk);
}

/** Pick the first href inside the named element, e.g. <addressbook-home-set><href>…</href></addressbook-home-set>. */
export function pickHref(xml: string, parentLocalName: string): string | null {
  const re = new RegExp(
    `<(?:[A-Za-z][\\w-]*:)?${parentLocalName}\\b[^>]*>([\\s\\S]*?)</(?:[A-Za-z][\\w-]*:)?${parentLocalName}>`,
    "i",
  );
  const m = re.exec(xml);
  if (!m || m[1] === undefined) return null;
  return extractHref(m[1]);
}

function decodeXmlText(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, (_m, p1: string) => p1)
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_m, d: string) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&amp;/g, "&");
}
