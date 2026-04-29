// Minimal CardDAV client (RFC 6352). Implements just what we need to back
// JMAP for Contacts (RFC 9610): discover the user's address books, list the
// vCards in each, and fetch them in batches. We do not implement the change
// feed (sync-collection) yet; address-book state is computed from a content
// hash of each book's resources.
//
// We avoid a heavyweight WebDAV/XML library; the protocol surface we touch
// is small enough to hand-parse with a regex-based extractor that only looks
// at element local-names. CardDAV servers (Stalwart, Radicale, SOGo, Baikal,
// Apple Contacts Server, …) all emit predictable XML for these requests.

import { Buffer } from "node:buffer";
import type { Credentials } from "../auth/credentials.js";

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

  /**
   * From a principal URL, locate the addressbook-home-set, then enumerate
   * every addressbook collection beneath it.
   */
  async listAddressBooks(): Promise<AddressBookInfo[]> {
    const principal = await this.discoverPrincipal();
    const homeXml = await this.propfind(principal, 0, [
      "urn:ietf:params:xml:ns:carddav addressbook-home-set",
    ]);
    const home = pickHref(homeXml, "addressbook-home-set") ?? principal;

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

  // -- low-level ----------------------------------------------------------

  private async followToCollection(path: string): Promise<string> {
    let url = absolutise(this.origin, path);
    for (let i = 0; i < 4; i++) {
      const res = await fetch(url, {
        method: "PROPFIND",
        headers: { Authorization: this.authHeader, Depth: "0", "Content-Type": "application/xml" },
        body: '<?xml version="1.0"?><D:propfind xmlns:D="DAV:"><D:prop><D:resourcetype/></D:prop></D:propfind>',
        redirect: "manual",
      });
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
      const [nsUri, name] = p.includes(" ") ? p.split(" ") : ["DAV:", p];
      const prefix = ns.prefix(nsUri!);
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
    const url = absolutise(this.origin, path);
    const res = await fetch(url, {
      method,
      headers: {
        Authorization: this.authHeader,
        "Content-Type": "application/xml; charset=utf-8",
        ...extra,
      },
      body,
    });
    if (!res.ok && res.status !== 207) {
      const text = await res.text().catch(() => "");
      throw new Error(`CardDAV ${method} ${path} → ${res.status} ${res.statusText}: ${text.slice(0, 200)}`);
    }
    return await res.text();
  }
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

function collectNamespaces(props: string[]): { prefix(uri: string): string; declarations(): string } {
  const map = new Map<string, string>([
    ["DAV:", "D"],
    ["urn:ietf:params:xml:ns:carddav", "C"],
    ["http://calendarserver.org/ns/", "CS"],
  ]);
  for (const p of props) {
    if (!p.includes(" ")) continue;
    const [uri] = p.split(" ");
    if (uri && !map.has(uri)) map.set(uri, `n${map.size}`);
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
