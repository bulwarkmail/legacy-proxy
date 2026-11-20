// Minimal CalDAV client (RFC 4791). Discovery, auth and transport are
// the CardDAV client's (same WebDAV underneath); this adds the calendar
// collection listing, the two REPORTs JMAP for Calendars needs, and event
// PUT / DELETE.

import crypto from "node:crypto";
import {
  CardDavClient, cachedBody, escapeXml, extractHref, freshEntry, hasResourceType, httpError, rememberVCard, splitResponses, textOf, type CardDavOpts,
} from "../carddav/client.js";
import { mapWithConcurrency } from "../util/concurrency.js";

export interface CalendarInfo {
  href: string;
  displayName: string;
  description: string | null;
  color: string | null;
  ctag: string | null;
  /** RFC 6578 sync token, when the server offers one. */
  syncToken: string | null;
  /** Apple's calendar-order, the user's sort position. */
  order: number | null;
}

export interface ICalResource {
  href: string;
  etag: string | null;
  data: string;
}

const CAL_NS = `xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav"`;

/** Collection properties Calendar/set writes; undefined = leave, description null = remove. */
export interface CalendarProps {
  displayName?: string;
  description?: string | null;
  /** #RRGGBB */
  color?: string;
  order?: number;
}

function calendarPropsXml(p: CalendarProps): string[] {
  const out: string[] = [];
  if (p.displayName !== undefined) out.push(`<D:displayname>${escapeXml(p.displayName)}</D:displayname>`);
  if (p.description) out.push(`<C:calendar-description>${escapeXml(p.description)}</C:calendar-description>`);
  if (p.color !== undefined) out.push(`<A:calendar-color>${escapeXml(p.color)}</A:calendar-color>`);
  if (p.order !== undefined) out.push(`<A:calendar-order>${Math.trunc(p.order)}</A:calendar-order>`);
  return out;
}

// Same caching scheme as the CardDAV client. A calendar load is one
// Calendar/get plus a query and several CalendarEvent/get batches, each of
// which needs the calendar list - cache it briefly. Event bodies are keyed by
// etag in the shared body cache; the etags come from the most recent query,
// so a body is never older than that query (bounded by ETAG_TTL_MS).
const calListCache = new Map<string, { cals: CalendarInfo[]; at: number }>();
const etagCache = new Map<string, { etag: string; at: number }>();
const CAL_LIST_TTL_MS = 15_000;
const ETAG_TTL_MS = 60_000;
const MULTIGET_CHUNK = 100;
const MULTIGET_CONCURRENCY = 4;

// The addresses a principal schedules as change rarely (an alias added).
const addressCache = new Map<string, { addrs: string[]; at: number }>();
const ADDRESS_TTL_MS = 10 * 60_000;

export function resetCalDavCaches(): void {
  addressCache.clear();
  calListCache.clear();
  etagCache.clear();
}

export class CalDavClient extends CardDavClient {
  constructor(opts: Omit<CardDavOpts, "caldav">) {
    super({ ...opts, caldav: true });
  }

  /**
   * The user's scheduling addresses (RFC 6638 calendar-user-address-set) as
   * plain e-mail addresses, the preferred one first. mailbox.org lists every
   * alias of the mailbox here.
   */
  async calendarUserAddresses(): Promise<string[]> {
    const cached = freshEntry(addressCache.get(this.cacheKey), ADDRESS_TTL_MS);
    if (cached) return cached.addrs;
    const principal = await this.discoverPrincipal();
    const xml = await this.propfind(principal, 0, ["urn:ietf:params:xml:ns:caldav calendar-user-address-set"]);
    const set = /<(?:[A-Za-z][\w-]*:)?calendar-user-address-set\b[^>]*>([\s\S]*?)<\/(?:[A-Za-z][\w-]*:)?calendar-user-address-set>/i.exec(xml)?.[1] ?? "";
    const entries = [...set.matchAll(/<(?:[A-Za-z][\w-]*:)?href\b([^>]*)>([\s\S]*?)<\/(?:[A-Za-z][\w-]*:)?href>/gi)]
      .map((m) => ({ preferred: /preferred\s*=\s*"1"/.test(m[1] ?? ""), value: (m[2] ?? "").trim() }))
      .filter((e) => /^mailto:/i.test(e.value));
    entries.sort((a, b) => Number(b.preferred) - Number(a.preferred));
    const addrs = [...new Set(entries.map((e) => decodeURIComponent(e.value.replace(/^mailto:/i, ""))))];
    addressCache.set(this.cacheKey, { addrs, at: Date.now() });
    return addrs;
  }

  // -- calendar collections (RFC 4791 MKCALENDAR, PROPPATCH, DELETE) ----------

  /** Where a new calendar goes: a fresh UUID under the calendar home. */
  async newCalendarHref(): Promise<string> {
    return `${await this.addressBookHome()}${crypto.randomUUID()}/`;
  }

  async makeCalendar(href: string, props: CalendarProps): Promise<void> {
    calListCache.delete(this.cacheKey);
    const body =
      `<?xml version="1.0" encoding="utf-8"?>\n` +
      `<C:mkcalendar ${CAL_NS} xmlns:A="http://apple.com/ns/ical/"><D:set><D:prop>${calendarPropsXml(props).join("")}</D:prop></D:set></C:mkcalendar>`;
    const res = await this.raw("MKCALENDAR", href, body, { "Content-Type": "application/xml; charset=utf-8" });
    if (!res.ok) throw await httpError("MKCALENDAR", href, res);
  }

  async updateCalendarProps(href: string, props: CalendarProps): Promise<void> {
    const set = calendarPropsXml(props);
    const remove = props.description === null ? [`<C:calendar-description/>`] : [];
    if (set.length === 0 && remove.length === 0) return;
    calListCache.delete(this.cacheKey);
    const body =
      `<?xml version="1.0" encoding="utf-8"?>\n` +
      `<D:propertyupdate ${CAL_NS} xmlns:A="http://apple.com/ns/ical/">` +
      (set.length ? `<D:set><D:prop>${set.join("")}</D:prop></D:set>` : "") +
      (remove.length ? `<D:remove><D:prop>${remove.join("")}</D:prop></D:remove>` : "") +
      `</D:propertyupdate>`;
    const res = await this.raw("PROPPATCH", href, body, { "Content-Type": "application/xml; charset=utf-8" });
    if (!res.ok && res.status !== 207) throw await httpError("PROPPATCH", href, res);
    const text = await res.text();
    if (/HTTP\/1\.[01] (4\d\d|5\d\d)/.test(text)) throw new Error(`CalDAV PROPPATCH ${href} → property failure: ${text.slice(0, 200)}`);
  }

  async deleteCalendar(href: string): Promise<void> {
    calListCache.delete(this.cacheKey);
    await this.deleteResource(href);
  }

  /** `fresh` skips the short-lived list cache: change detection must see the server's current tokens. */
  async listCalendars(fresh = false): Promise<CalendarInfo[]> {
    const cached = fresh ? undefined : freshEntry(calListCache.get(this.cacheKey), CAL_LIST_TTL_MS);
    if (cached) return cached.cals;
    const home = await this.addressBookHome(); // calendar-home-set in caldav mode
    const xml = await this.propfind(home, 1, [
      "DAV:resourcetype",
      "DAV:displayname",
      "urn:ietf:params:xml:ns:caldav calendar-description",
      "http://apple.com/ns/ical/ calendar-color",
      "http://calendarserver.org/ns/ getctag",
      "DAV:sync-token",
      "http://apple.com/ns/ical/ calendar-order",
    ]);
    const out: CalendarInfo[] = [];
    for (const r of splitResponses(xml)) {
      const href = extractHref(r);
      if (!href || !hasResourceType(r, "calendar")) continue;
      const color = textOf(r, "calendar-color");
      out.push({
        href,
        displayName: textOf(r, "displayname") || decodeURIComponent(href.replace(/\/+$/, "").split("/").pop() ?? href),
        description: textOf(r, "calendar-description") || null,
        // Apple's #RRGGBBAA -> #RRGGBB
        color: color ? color.slice(0, 7) : null,
        // A property the server doesn't have comes back empty in a 404 propstat.
        ctag: textOf(r, "getctag") || textOf(r, "sync-token") || null,
        syncToken: textOf(r, "sync-token") || null,
        order: Number.isFinite(Number.parseInt(textOf(r, "calendar-order") ?? "", 10)) ? Number.parseInt(textOf(r, "calendar-order")!, 10) : null,
      });
    }
    // Neither getctag nor sync-token is required by RFC 4791. For a calendar
    // with neither, a digest of its members' etags stands in for the ctag,
    // so a change still moves the state. Left null if that fails too.
    await mapWithConcurrency(out.filter((c) => !c.ctag), 4, async (c) => {
      c.ctag = await this.memberDigest(c.href).catch(() => null);
    });
    calListCache.set(this.cacheKey, { cals: out, at: Date.now() });
    return out;
  }

  private async memberDigest(calHref: string): Promise<string | null> {
    const xml = await this.propfind(calHref, 1, ["DAV:getetag"]);
    const members: string[] = [];
    const self = normalizeHref(calHref).replace(/\/+$/, "");
    for (const r of splitResponses(xml)) {
      const href = extractHref(r);
      // The collection answers for itself too, possibly written differently.
      if (!href || normalizeHref(href).replace(/\/+$/, "") === self || hasResourceType(r, "collection")) continue;
      const etag = textOf(r, "getetag");
      if (!etag) return null;
      members.push(`${href}\u0000${etag}`);
    }
    return "etags:" + crypto.createHash("sha1").update(members.sort().join("\u0000")).digest("base64url");
  }

  /** Hrefs of the VEVENT resources in a calendar, optionally overlapping [after, before) (UTC ms). */
  async queryEvents(calHref: string, range?: { after?: number; before?: number }): Promise<string[]> {
    const tr = range && (range.after !== undefined || range.before !== undefined)
      ? `<C:time-range${range.after !== undefined ? ` start="${caldavTime(range.after)}"` : ""}${range.before !== undefined ? ` end="${caldavTime(range.before)}"` : ""}/>`
      : "";
    const body =
      `<?xml version="1.0" encoding="utf-8"?>\n` +
      `<C:calendar-query ${CAL_NS}><D:prop><D:getetag/></D:prop>` +
      `<C:filter><C:comp-filter name="VCALENDAR"><C:comp-filter name="VEVENT">${tr}</C:comp-filter></C:comp-filter></C:filter>` +
      `</C:calendar-query>`;
    const xml = await this.request("REPORT", calHref, body, { Depth: "1" });
    const out: string[] = [];
    const now = Date.now();
    for (const r of splitResponses(xml)) {
      const href = extractHref(r);
      if (!href || href === calHref) continue;
      const etag = textOf(r, "getetag");
      if (etag) etagCache.set(`${this.cacheKey}|${href}`, { etag, at: now });
      out.push(href);
    }
    return out;
  }

  async multiGetEvents(calHref: string, hrefs: string[]): Promise<ICalResource[]> {
    const out: ICalResource[] = [];
    const missing: string[] = [];
    for (const href of hrefs) {
      const etag = freshEntry(etagCache.get(`${this.cacheKey}|${href}`), ETAG_TTL_MS)?.etag;
      const data = etag ? cachedBody(`${this.cacheKey}|${href}|${etag}`) : undefined;
      if (etag && data !== undefined) out.push({ href, etag, data });
      else missing.push(href);
    }
    const chunks: string[][] = [];
    for (let i = 0; i < missing.length; i += MULTIGET_CHUNK) chunks.push(missing.slice(i, i + MULTIGET_CHUNK));
    const fetched = await mapWithConcurrency(chunks, MULTIGET_CONCURRENCY, (c) => this.fetchEvents(calHref, c));
    return out.concat(fetched.flat());
  }

  /**
   * What changed in a calendar since `token` (RFC 6578 sync-collection):
   * resources added or changed, resources removed, and the token to ask with
   * next. Null when the server can't say - the token expired or is unknown,
   * or the answer was truncated - so the caller starts over.
   */
  async syncChanges(calHref: string, token: string): Promise<{ token: string; changed: string[]; removed: string[] } | null> {
    const body =
      `<?xml version="1.0" encoding="utf-8"?>\n` +
      `<D:sync-collection xmlns:D="DAV:"><D:sync-token>${escapeXml(token)}</D:sync-token>` +
      `<D:sync-level>1</D:sync-level><D:prop><D:getetag/></D:prop></D:sync-collection>`;
    let xml: string;
    try {
      // RFC 6578 §3.2: the depth is in sync-level; the Depth header is 0.
      xml = await this.request("REPORT", calHref, body, { Depth: "0" });
    } catch {
      return null;
    }
    const changed: string[] = [];
    const removed: string[] = [];
    const now = Date.now();
    for (const r of splitResponses(xml)) {
      const href = extractHref(r);
      if (!href) continue;
      // A member's own status (no propstat) is how removal is reported; 507
      // on the collection itself means the server cut the list short.
      const status = /<(?:[A-Za-z][\w-]*:)?propstat\b/i.test(r) ? null : /\s(\d{3})(?:\s|$)/.exec(textOf(r, "status") ?? "")?.[1] ?? null;
      if (status === "507") return null;
      if (href === calHref) continue;
      if (status === "404") {
        removed.push(href);
        etagCache.delete(`${this.cacheKey}|${href}`);
        continue;
      }
      const etag = textOf(r, "getetag");
      if (etag) etagCache.set(`${this.cacheKey}|${href}`, { etag, at: now });
      changed.push(href);
    }
    // The new token follows the responses at the top level.
    const tokens = [...xml.matchAll(/<(?:[A-Za-z][\w-]*:)?sync-token\b[^>]*>([\s\S]*?)<\/(?:[A-Za-z][\w-]*:)?sync-token>/gi)];
    const next = tokens.at(-1)?.[1]?.trim();
    return next ? { token: next, changed, removed } : null;
  }

  /**
   * PUT an iCalendar resource. `ifMatch` makes the write conditional on the stored version. Without it a
   * create sends `If-None-Match: *`; `overwrite` is for an update whose
   * resource came without an etag, which can only be written unconditionally.
   */
  async putEvent(href: string, ics: string, ifMatch?: string | null, opts: { overwrite?: boolean } = {}): Promise<{ etag: string | null }> {
    this.forget(href);
    return this.putResource(href, ics, { ifMatch, contentType: "text/calendar; charset=utf-8", overwrite: opts.overwrite });
  }

  /** Throws notFound when the server has no such resource. */
  async deleteEvent(href: string): Promise<void> {
    this.forget(href);
    await this.deleteResource(href, { mustExist: true });
  }

  // A write changes the calendar's ctag (and so the JMAP state) and the
  // resource's etag, so neither cached value may be served afterwards.
  private forget(href: string): void {
    calListCache.delete(this.cacheKey);
    etagCache.delete(`${this.cacheKey}|${href}`);
  }

  /** Fetch bodies from the server, bypassing the cache (writes need the current etag). */
  async fetchEvents(calHref: string, hrefs: string[]): Promise<ICalResource[]> {
    const body =
      `<?xml version="1.0" encoding="utf-8"?>\n` +
      `<C:calendar-multiget ${CAL_NS}><D:prop><D:getetag/><C:calendar-data/></D:prop>` +
      hrefs.map((h) => `<D:href>${escapeXml(h)}</D:href>`).join("") +
      `</C:calendar-multiget>`;
    const xml = await this.request("REPORT", calHref, body, { Depth: "1" });
    // Servers may answer with a differently encoded href than we asked for
    // (`%40` for the `@` most invitation UIDs carry, or an absolute URL), and
    // callers look results up by the href they passed in, so hand that back.
    const asked = new Map(hrefs.map((h) => [normalizeHref(h), h]));
    const out: ICalResource[] = [];
    for (const r of splitResponses(xml)) {
      const raw = extractHref(r);
      const href = raw && (asked.get(normalizeHref(raw)) ?? raw);
      const data = textOf(r, "calendar-data");
      if (!href || !data) continue;
      const etag = textOf(r, "getetag");
      if (etag) rememberVCard(`${this.cacheKey}|${href}|${etag}`, data);
      out.push({ href, etag, data });
    }
    return out;
  }
}

/** An href as a decoded path: servers may answer with absolute URLs or encode differently. */
export function normalizeHref(href: string): string {
  const path = href.replace(/^https?:\/\/[^/]+/i, "");
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
}

function caldavTime(ms: number): string {
  return new Date(ms).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}
