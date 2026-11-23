// JMAP for Calendars handlers backed by CalDAV (RFC 4791): Calendar/get and
// CalendarEvent/get, /query, /set and /parse. Ids follow the
// contacts scheme - base64url of the collection href, and of
// "collectionHref\nresourceHref" for events.

import crypto from "node:crypto";
import { Buffer } from "node:buffer";
import { CalDavClient, normalizeHref, type CalendarInfo } from "../../caldav/client.js";
import { davOptions } from "../../carddav/client.js";
import { eventToIcal, highestSequence, icalToEvent, icalToEvents, localToUtc, type JsEvent } from "../../caldav/ical.js";
import { applyPatch, errorFor, setError } from "./dav.js";
import type { CalendarProps } from "../../caldav/client.js";
import { mapWithConcurrency } from "../../util/concurrency.js";
import { log } from "../../util/log.js";
import type { Credentials } from "../../auth/credentials.js";
import type { ProviderConfig } from "../../util/config.js";
import type { AccountRow, Store } from "../../state/store.js";
import type { ImapPool } from "../../imap/pool.js";
import { readBlob } from "../blobs.js";
import { accountNotFound, JmapError, unsupportedFilter } from "../errors.js";

export interface CalendarCtx {
  account: AccountRow;
  provider: ProviderConfig;
  creds: Credentials;
}

// Events and calendars can be created, changed and deleted. Sharing is not
// offered (mayAdmin), CalDAV has no portable way to manage it.
const RIGHTS = {
  mayReadFreeBusy: true,
  mayReadItems: true,
  mayWriteAll: true,
  mayWriteOwn: true,
  mayUpdatePrivate: true,
  mayRSVP: true,
  mayAdmin: false,
  mayDelete: true,
};

export function calendarsAvailable(provider: ProviderConfig): boolean {
  return provider.caldav != null;
}

function makeClient(ctx: CalendarCtx): CalDavClient {
  if (!ctx.provider.caldav) throw new JmapError("forbidden", "Calendars are not configured for this provider");
  return new CalDavClient(davOptions(ctx.provider.caldav, ctx.creds));
}

const encodeId = (s: string) => Buffer.from(s, "utf8").toString("base64url");
const decodeId = (id: string) => Buffer.from(id, "base64url").toString("utf8");

function splitEventId(id: string): { calHref: string; href: string } | null {
  const d = decodeId(id);
  const i = d.indexOf("\n");
  return i < 0 ? null : { calHref: d.slice(0, i), href: d.slice(i + 1) };
}

function state(cals: CalendarInfo[]): string {
  const h = crypto.createHash("sha1");
  for (const c of cals) h.update(`${c.href}\u0000${c.ctag ?? ""}\u0000`);
  return h.digest("base64url").slice(0, 16);
}

// CalendarEvent state: per calendar its RFC 6578 sync token ("s:"), or for a
// calendar without one its ctag ("c:"). CalendarEvent/changes asks each
// calendar with a token what changed since, without keeping anything on our
// side; a calendar known only by ctag (mailbox.org's birthday calendar) can
// only say "nothing" or "can't tell". The client falls back to a digest of
// the members' etags for a calendar that has neither (see listCalendars); if
// even that failed, the state is one that never matches, so /changes says
// cannotCalculateChanges instead of "nothing changed".
const SYNC_STATE_PREFIX = "S";

function eventStateOf(entries: [string, string][]): string {
  return SYNC_STATE_PREFIX + Buffer.from(JSON.stringify(entries), "utf8").toString("base64url");
}

function versionOf(c: CalendarInfo): string | null {
  return c.syncToken ? `s:${c.syncToken}` : c.ctag ? `c:${c.ctag}` : null;
}

const UNKNOWN_STATE_PREFIX = "U";

function eventState(cals: CalendarInfo[]): string {
  const versions = cals.map(versionOf);
  if (versions.some((v) => v === null)) return UNKNOWN_STATE_PREFIX + crypto.randomUUID();
  return eventStateOf(cals.map((c, i) => [c.href, versions[i]!]));
}

/** False for a state minted when a calendar's version couldn't be read; it changes on every read. */
export function isKnownEventState(s: string): boolean {
  return !s.startsWith(UNKNOWN_STATE_PREFIX);
}

// The CalendarEvent state last handed to each account's client. The watcher
// compares against it, so a change between the client's load and the
// watcher's first look is still pushed.
const servedEventState = new Map<number, string>();

function served(account: AccountRow, s: string): string {
  if (isKnownEventState(s)) servedEventState.set(account.id, s);
  return s;
}

export function lastServedEventState(accountId: number): string | undefined {
  return servedEventState.get(accountId);
}

function decodeEventState(s: string): Map<string, string> | null {
  if (!s.startsWith(SYNC_STATE_PREFIX)) return null;
  try {
    const entries = JSON.parse(Buffer.from(s.slice(SYNC_STATE_PREFIX.length), "base64url").toString("utf8")) as unknown;
    if (!Array.isArray(entries) || !entries.every((e) => Array.isArray(e) && e.length === 2 && e.every((x) => typeof x === "string"))) return null;
    return new Map(entries as [string, string][]);
  } catch {
    return null;
  }
}

/** The account's current CalendarEvent state, read from the server (no list cache). */
export async function calendarEventState(ctx: CalendarCtx): Promise<string> {
  return eventState(await makeClient(ctx).listCalendars(true));
}

/** The user's scheduling addresses on the calendar server (aliases included). */
export async function calendarUserAddresses(ctx: CalendarCtx): Promise<string[]> {
  return makeClient(ctx).calendarUserAddresses();
}

function checkAccount(accountId: string, ctx: CalendarCtx): void {
  if (accountId !== String(ctx.account.id)) throw accountNotFound();
}

// -- Calendar/get ------------------------------------------------------------------

function projectCalendar(c: CalendarInfo, i: number) {
  return {
    id: encodeId(c.href),
    name: c.displayName,
    description: c.description,
    color: c.color,
    sortOrder: c.order ?? i,
    isSubscribed: true,
    isVisible: true,
    isDefault: i === 0,
    includeInAvailability: "all",
    defaultAlertsWithTime: null,
    defaultAlertsWithoutTime: null,
    timeZone: null,
    shareWith: null,
    myRights: RIGHTS,
  };
}

export async function calendarGet(args: { accountId: string; ids?: string[] | null }, ctx: CalendarCtx) {
  checkAccount(args.accountId, ctx);
  const cals = await makeClient(ctx).listCalendars();
  const all = cals.map(projectCalendar);
  const ids = args.ids ?? null;
  return {
    accountId: args.accountId,
    state: state(cals),
    list: ids ? all.filter((c) => ids.includes(c.id)) : all,
    notFound: ids ? ids.filter((id) => !all.some((c) => c.id === id)) : [],
  };
}

// -- Calendar/set ----------------------------------------------------------------

// What a calendar collection stores over CalDAV: displayname, description,
// Apple's calendar-color and calendar-order.
const CALENDAR_WRITABLE = new Set(["name", "description", "color", "sortOrder"]);
// Properties Calendar/get reports with a fixed value. A client may send them
// back (Bulwark's settings form sends the whole calendar); a different value
// can't be kept and is refused.
const CALENDAR_FIXED: Record<string, unknown> = {
  isSubscribed: true,
  isVisible: true,
  includeInAvailability: "all",
  defaultAlertsWithTime: null,
  defaultAlertsWithoutTime: null,
  timeZone: null,
  shareWith: null,
};
const CALENDAR_SERVER_SET = new Set(["id", "isDefault", "myRights"]);

function calendarPropsFrom(patch: Record<string, unknown>, creating: boolean): CalendarProps {
  const bad = Object.keys(patch).filter((k) => {
    if (CALENDAR_WRITABLE.has(k)) return false;
    if (CALENDAR_SERVER_SET.has(k)) return creating;
    return !(k in CALENDAR_FIXED) || JSON.stringify(patch[k]) !== JSON.stringify(CALENDAR_FIXED[k]);
  });
  if (bad.length) throw new JmapError("invalidProperties", `can't be set on this server: ${bad.join(", ")}`, { properties: bad });
  const props: CalendarProps = {};
  if ("name" in patch || creating) {
    const name = typeof patch.name === "string" ? patch.name.trim() : "";
    if (!name) throw new JmapError("invalidProperties", "name must be a non-empty string", { properties: ["name"] });
    props.displayName = name;
  }
  if ("description" in patch) {
    const d = patch.description;
    if (d != null && typeof d !== "string") throw new JmapError("invalidProperties", "description must be a string or null", { properties: ["description"] });
    props.description = d ? d : null;
  }
  if ("color" in patch && patch.color != null) {
    if (typeof patch.color !== "string" || !/^#[0-9a-f]{6}$/i.test(patch.color)) {
      throw new JmapError("invalidProperties", "color must be #RRGGBB", { properties: ["color"] });
    }
    props.color = patch.color;
  }
  if ("sortOrder" in patch) {
    if (!Number.isInteger(patch.sortOrder) || (patch.sortOrder as number) < 0) {
      throw new JmapError("invalidProperties", "sortOrder must be an unsigned integer", { properties: ["sortOrder"] });
    }
    props.order = patch.sortOrder as number;
  }
  return props;
}

export async function calendarSet(
  args: {
    accountId: string;
    ifInState?: string | null;
    create?: Record<string, Record<string, unknown>> | null;
    update?: Record<string, Record<string, unknown>> | null;
    destroy?: string[] | null;
    onDestroyRemoveEvents?: boolean;
    onSuccessSetIsDefault?: string | null;
  },
  ctx: CalendarCtx,
) {
  checkAccount(args.accountId, ctx);
  const client = makeClient(ctx);
  let cals = await client.listCalendars(true);
  const oldState = state(cals);
  if (args.ifInState != null && args.ifInState !== oldState) throw new JmapError("stateMismatch");
  // The default is the first calendar the server lists; CalDAV has no
  // portable way to change which one that is.
  const defaultId = cals[0] ? encodeId(cals[0].href) : null;
  if (args.onSuccessSetIsDefault != null && args.onSuccessSetIsDefault !== defaultId) {
    throw new JmapError("invalidArguments", "the default calendar can't be changed on this server");
  }

  const out = {
    accountId: args.accountId,
    oldState,
    newState: oldState,
    created: null as Record<string, unknown> | null,
    updated: null as Record<string, Record<string, unknown> | null> | null,
    destroyed: null as string[] | null,
    notCreated: null as Record<string, unknown> | null,
    notUpdated: null as Record<string, unknown> | null,
    notDestroyed: null as Record<string, unknown> | null,
  };

  // What the client asked for, to compare with what the server kept.
  const requested = new Map<string, Record<string, unknown>>();
  const createdHref = new Map<string, string>();
  const known = new Set(cals.map((c) => c.href));
  for (const [tempId, raw] of Object.entries(args.create ?? {})) {
    try {
      const props = calendarPropsFrom(raw ?? {}, true);
      const asked = await client.newCalendarHref();
      // Some servers refuse a description in MKCALENDAR (Open-Xchange answers
      // 403); it is set right after instead.
      const { description, ...atCreate } = props;
      await client.makeCalendar(asked, atCreate);
      const href = await createdCalendarHref(client, asked, known, props.displayName!);
      known.add(href);
      if (description) await client.updateCalendarProps(href, { description });
      requested.set(encodeId(href), raw ?? {});
      createdHref.set(tempId, href);
      (out.created ??= {})[tempId] = { id: encodeId(href), isDefault: false, myRights: RIGHTS, ...CALENDAR_FIXED };
    } catch (e) {
      log.warn({ err: (e as Error).message, tempId }, "Calendar/set create failed");
      (out.notCreated ??= {})[tempId] = errorFor(e, "invalidProperties");
    }
  }

  for (const [id, patch] of Object.entries(args.update ?? {})) {
    try {
      const cal = cals.find((c) => encodeId(c.href) === id);
      if (!cal) {
        (out.notUpdated ??= {})[id] = setError("notFound");
        continue;
      }
      await client.updateCalendarProps(cal.href, calendarPropsFrom(patch ?? {}, false));
      requested.set(id, patch ?? {});
      (out.updated ??= {})[id] = null;
    } catch (e) {
      log.warn({ err: (e as Error).message, id }, "Calendar/set update failed");
      (out.notUpdated ??= {})[id] = errorFor(e, "invalidProperties");
    }
  }

  for (const id of args.destroy ?? []) {
    try {
      const cal = cals.find((c) => encodeId(c.href) === id);
      if (!cal) {
        (out.notDestroyed ??= {})[id] = setError("notFound");
        continue;
      }
      if (!args.onDestroyRemoveEvents && (await client.queryEvents(cal.href)).length > 0) {
        (out.notDestroyed ??= {})[id] = setError("calendarHasEvent", "the calendar still has events");
        continue;
      }
      await client.deleteCalendar(cal.href);
      (out.destroyed ??= []).push(id);
    } catch (e) {
      log.warn({ err: (e as Error).message, id }, "Calendar/set destroy failed");
      (out.notDestroyed ??= {})[id] = errorFor(e);
    }
  }

  if (out.created || out.updated || out.destroyed) {
    cals = await client.listCalendars(true);
    out.newState = state(cals);
    // A server may accept a property and not keep it (Open-Xchange takes a
    // description or calendar-order with 200 and drops it). RFC 8620 §5.3
    // has the server return such values, so the client shows what is stored.
    const kept = (id: string) => {
      const i = cals.findIndex((c) => encodeId(c.href) === id);
      if (i < 0) return {};
      const now = projectCalendar(cals[i]!, i) as Record<string, unknown>;
      const asked = requested.get(id) ?? {};
      return Object.fromEntries(
        [...CALENDAR_WRITABLE].filter((k) => k in asked && JSON.stringify(normalise(k, asked[k])) !== JSON.stringify(normalise(k, now[k]))).map((k) => [k, now[k]]),
      );
    };
    for (const [tempId, href] of createdHref) {
      Object.assign(out.created![tempId] as Record<string, unknown>, kept(encodeId(href)));
    }
    for (const id of Object.keys(out.updated ?? {})) {
      const diff = kept(id);
      if (Object.keys(diff).length) out.updated![id] = diff as never;
    }
  }
  return out;
}

// Where MKCALENDAR really put the calendar. RFC 4791 creates it at the
// request URI, but Open-Xchange files it under a folder id of its own
// (/caldav/Y2Fs.../) and sends no Location. So: the asked href if the server
// lists it, else the one new calendar of that name.
async function createdCalendarHref(client: CalDavClient, asked: string, known: Set<string>, name: string): Promise<string> {
  const now = await client.listCalendars(true);
  if (now.some((c) => c.href === asked)) return asked;
  const fresh = now.filter((c) => !known.has(c.href) && c.displayName === name);
  if (fresh.length === 1) return fresh[0]!.href;
  throw new JmapError("serverFail", "the calendar was created, but the server doesn't list it where it was asked to and it can't be told apart");
}

// Colours compare case-insensitively; an empty description is none.
function normalise(k: string, v: unknown): unknown {
  if (k === "color" && typeof v === "string") return v.toLowerCase();
  if (k === "description" && (v === "" || v === undefined)) return null;
  if (k === "name" && typeof v === "string") return v.trim();
  return v;
}

// -- CalendarEvent/query -----------------------------------------------------------

interface EventFilter {
  inCalendar?: string;
  inCalendars?: string[];
  after?: string;
  before?: string;
  uid?: string;
  text?: string;
  title?: string;
  description?: string;
  location?: string;
  owner?: string;
  attendee?: string;
  operator?: string;
  conditions?: EventFilter[];
}

// Text conditions of the JMAP Calendars filter: case-insensitive substring
// matches on the event (its overrides included); `text` looks in all of them.
const TEXT_KEYS = ["text", "title", "description", "location", "owner", "attendee"] as const;
type TextKey = (typeof TEXT_KEYS)[number];

const FILTER_KEYS = new Set<string>(["inCalendar", "inCalendars", "after", "before", "uid", "operator", "conditions", ...TEXT_KEYS]);

/** A filter reduced to what CalDAV can answer: calendars, a time range, a uid. */
interface EventQueryPlan {
  /** Calendar ids the event must be in; null = any. */
  calendars: Set<string> | null;
  after?: string;
  before?: string;
  uid?: string;
  /** Text conditions; all must match. */
  texts: { key: TextKey; value: string }[];
}

// Answering a filter we can't evaluate with every event is worse than failing:
// Bulwark looks up a series' master with { uid } and edits the first recurring
// event it gets back, which truncated an unrelated series before uid was
// supported here.
//
// What we can evaluate is an AND of calendar, range and uid conditions, in any
// nesting: a condition with several keys is an AND of its keys (RFC 8620
// §5.5), nested ANDs flatten, and an OR is fine as long as it only picks
// calendars - that is how a client sends "this range, in these calendars".
// Anything else (NOT, an OR over ranges or uids) is refused.
function planFilter(f: EventFilter | undefined): EventQueryPlan {
  const plan: EventQueryPlan = { calendars: null, texts: [] };
  if (f) addToPlan(f, plan);
  return plan;
}

function addToPlan(f: EventFilter, plan: EventQueryPlan): void {
  const unknown = Object.keys(f).filter((k) => !FILTER_KEYS.has(k));
  if (unknown.length) throw unsupportedFilter(`unsupported CalendarEvent filter: ${unknown.join(", ")}`);

  if (f.operator !== undefined) {
    const conditions = f.conditions ?? [];
    if (f.operator === "AND") {
      for (const c of conditions) addToPlan(c, plan);
    } else if (f.operator === "OR") {
      const ids = conditions.map(calendarIdsOnly);
      if (ids.some((x) => x === null)) throw unsupportedFilter("only calendar conditions are supported inside OR");
      restrictCalendars(plan, new Set((ids as string[][]).flat()));
    } else {
      throw unsupportedFilter(`unsupported CalendarEvent filter operator: ${String(f.operator)}`);
    }
    return;
  }

  if (f.inCalendar !== undefined) restrictCalendars(plan, new Set([f.inCalendar]));
  if (f.inCalendars !== undefined) restrictCalendars(plan, new Set(f.inCalendars));
  // Several bounds in one AND: the narrowest wins. LocalDateTimes of the same
  // zone compare as strings.
  if (f.after !== undefined && (plan.after === undefined || f.after > plan.after)) plan.after = f.after;
  if (f.before !== undefined && (plan.before === undefined || f.before < plan.before)) plan.before = f.before;
  for (const key of TEXT_KEYS) {
    const value = f[key];
    if (typeof value === "string" && value.trim()) plan.texts.push({ key, value: value.trim().toLowerCase() });
  }
  if (f.uid !== undefined) {
    // Two different uids can't both match; an impossible uid keeps that true.
    plan.uid = plan.uid === undefined || plan.uid === f.uid ? f.uid : "\0no-such-uid";
  }
}

/** The calendar ids a condition names when it names nothing else, else null. */
function calendarIdsOnly(c: EventFilter): string[] | null {
  if (c.operator === "OR") {
    const nested = (c.conditions ?? []).map(calendarIdsOnly);
    return nested.some((x) => x === null) ? null : (nested as string[][]).flat();
  }
  const keys = Object.keys(c);
  if (keys.length === 1 && c.inCalendar !== undefined) return [c.inCalendar];
  if (keys.length === 1 && c.inCalendars !== undefined) return c.inCalendars;
  return null;
}

function restrictCalendars(plan: EventQueryPlan, ids: Set<string>): void {
  plan.calendars = plan.calendars ? new Set([...plan.calendars].filter((id) => ids.has(id))) : ids;
}

async function queryAll(ctx: CalendarCtx, filter?: EventFilter, timeZone?: string): Promise<{ ids: string[]; state: string }> {
  const client = makeClient(ctx);
  const cals = await client.listCalendars();
  const plan = planFilter(filter);
  const wanted = plan.calendars;
  // after/before are LocalDateTimes in the request's time zone (UTC by default).
  const zone = timeZone ?? "Etc/UTC";
  const range = {
    after: plan.after ? localToUtc(plan.after.slice(0, 19), zone) : undefined,
    before: plan.before ? localToUtc(plan.before.slice(0, 19), zone) : undefined,
  };
  const targets = cals.filter((c) => !wanted || wanted.has(encodeId(c.href)));
  const perCal = await mapWithConcurrency(targets, 4, async (c) => {
    let hrefs = await client.queryEvents(c.href, range);
    // CalDAV has a UID prop-filter, but servers are free to ignore text
    // matches (mailbox.org does), so match on the bodies instead; they mostly
    // come from the body cache.
    // Text is matched the same way, CalDAV text-match being optional too.
    if (plan.uid !== undefined || plan.texts.length) {
      const res = await client.multiGetEvents(c.href, hrefs);
      hrefs = res
        .filter((r) => {
          const ev = icalToEvent(r.data, "", "");
          return !!ev && (plan.uid === undefined || ev.uid === plan.uid) && plan.texts.every((t) => matchesText(ev, t.key, t.value));
        })
        .map((r) => r.href);
    }
    return hrefs.map((h) => encodeId(`${c.href}\n${h}`));
  });
  return { ids: perCal.flat(), state: eventState(cals) };
}

/** The strings a text condition looks at, from the event and its overrides. */
function textFields(ev: JsEvent, key: TextKey): string[] {
  const versions: Record<string, unknown>[] = [ev, ...Object.values((ev.recurrenceOverrides ?? {}) as Record<string, Record<string, unknown>>)];
  const out: string[] = [];
  const people = (role: "owner" | "attendee") =>
    Object.values((ev.participants ?? {}) as Record<string, { name?: string | null; email?: string; roles?: Record<string, boolean> }>)
      .filter((p) => p.roles?.[role])
      .flatMap((p) => [p.name ?? "", p.email ?? ""]);
  for (const v of versions) {
    if (key === "title" || key === "text") out.push(String(v.title ?? ""));
    if (key === "description" || key === "text") out.push(String(v.description ?? ""));
    if (key === "location" || key === "text") {
      for (const l of Object.values((v.locations ?? {}) as Record<string, { name?: string }>)) out.push(l?.name ?? "");
    }
  }
  if (key === "owner" || key === "text") out.push(...people("owner"));
  if (key === "attendee" || key === "text") out.push(...people("attendee"));
  return out;
}

function matchesText(ev: JsEvent, key: TextKey, needle: string): boolean {
  return textFields(ev, key).some((s) => s.toLowerCase().includes(needle));
}

export async function calendarEventQuery(
  args: { accountId: string; filter?: EventFilter; position?: number; limit?: number; timeZone?: string },
  ctx: CalendarCtx,
) {
  checkAccount(args.accountId, ctx);
  planFilter(args.filter); // refuse what we can't evaluate before any CalDAV call
  // We don't implement `sort`: ids come back in server order, and Bulwark
  // sorts the expanded occurrences itself anyway.
  const { ids, state: s } = await queryAll(ctx, args.filter, args.timeZone);
  const position = Math.max(0, args.position ?? 0);
  const limit = args.limit && args.limit > 0 ? args.limit : ids.length;
  return {
    accountId: args.accountId,
    queryState: s,
    canCalculateChanges: false,
    position,
    total: ids.length,
    ids: ids.slice(position, position + limit),
  };
}

// -- CalendarEvent/get -------------------------------------------------------------

export async function calendarEventGet(args: { accountId: string; ids?: string[] | null }, ctx: CalendarCtx) {
  checkAccount(args.accountId, ctx);
  const client = makeClient(ctx);
  const cals = await client.listCalendars();
  const ids = args.ids ?? (await queryAll(ctx)).ids;

  const byCal = new Map<string, Map<string, string>>(); // calHref -> href -> id
  const notFound: string[] = [];
  for (const id of ids) {
    const parts = splitEventId(id);
    if (!parts || !cals.some((c) => c.href === parts.calHref) || !isEventHref(client, parts)) {
      notFound.push(id);
      continue;
    }
    if (!byCal.has(parts.calHref)) byCal.set(parts.calHref, new Map());
    byCal.get(parts.calHref)!.set(parts.href, id);
  }

  const list: JsEvent[] = [];
  await mapWithConcurrency([...byCal], 4, async ([calHref, hrefs]) => {
    const found = new Set<string>();
    for (const r of await client.multiGetEvents(calHref, [...hrefs.keys()])) {
      const id = hrefs.get(r.href);
      if (!id) continue;
      const ev = icalToEvent(r.data, id, encodeId(calHref));
      if (ev) {
        list.push(ev);
        found.add(r.href);
      }
    }
    for (const [href, id] of hrefs) if (!found.has(href)) notFound.push(id);
  });
  return { accountId: args.accountId, state: served(ctx.account, eventState(cals)), list, notFound };
}

// -- CalendarEvent/set -------------------------------------------------------------

type SetError = ReturnType<typeof setError>;

// Per-item failures go back in notCreated / notUpdated / notDestroyed inside a
// 200 response, so the request log never shows them. Log them here, with the
// property names the client sent, since the browser is the only other place
// they surface.
function itemFailed(op: string, id: string, e: unknown, props?: string[]): SetError {
  const err = errorFor(e);
  log.warn({ op, id, ...err, ...(props ? { props } : {}) }, "CalendarEvent/set item failed");
  return err;
}

// Server-set or derived properties; a client sending them back is ignored
// rather than rejected.
const EVENT_READ_ONLY = new Set(["id", "uid", "@type", "created", "updated", "utcStart", "utcEnd", "baseEventId", "isOrigin", "isDraft"]);

// An event id names a resource directly inside its calendar; anything else
// (the calendar itself, something below or beside it) is not an event.
export function isMember(parts: { calHref: string; href: string }): boolean {
  const cal = normalizeHref(parts.calHref).replace(/\/*$/, "/");
  const href = normalizeHref(parts.href);
  if (!href.startsWith(cal)) return false;
  const rest = href.slice(cal.length);
  return rest.length > 0 && !rest.includes("/");
}

// isMember on a decoded path, plus the CardDAV rules for an href that leaves
// the server's origin or names `.` / `..` in any encoding: the URL parser
// resolves those before the request goes out, so `<calendar>/.` would reach
// the calendar itself and `<calendar>/..` the calendar home.
function isEventHref(client: CalDavClient, parts: { calHref: string; href: string }): boolean {
  return isMember(parts) && client.isInBook(parts.calHref, parts.href);
}

// What answering an invitation changes on a participant. An update that
// differs from the stored event in nothing else, wherever it says so (a patch
// path, a whole participants object, an occurrence's override), is a reply.
const REPLY_FIELDS = new Set(["participationStatus", "expectReply", "scheduleUpdated", "scheduleSequence"]);

function withoutReplyFields(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(withoutReplyFields);
  if (!v || typeof v !== "object") return v;
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(v).sort()) if (!REPLY_FIELDS.has(k)) out[k] = withoutReplyFields((v as Record<string, unknown>)[k]);
  return out;
}

// Each occurrence as it reads, so an override that now spells out the
// series' participants to answer for itself compares equal to one that didn't.
function expanded(ev: JsEvent): JsEvent {
  const base: JsEvent = { ...ev, recurrenceOverrides: null };
  const occurrences: Record<string, unknown> = {};
  for (const [key, patch] of Object.entries((ev.recurrenceOverrides ?? {}) as Record<string, Record<string, unknown>>)) {
    if (patch.excluded || Object.keys(patch).length === 0) {
      occurrences[key] = patch;
      continue;
    }
    const o = structuredClone(base);
    applyPatch(o, patch);
    occurrences[key] = o;
  }
  return { ...ev, recurrenceOverrides: occurrences };
}

function isReply(before: JsEvent, after: JsEvent): boolean {
  return JSON.stringify(withoutReplyFields(expanded(before))) === JSON.stringify(withoutReplyFields(expanded(after)));
}

export async function calendarEventSet(
  args: {
    accountId: string;
    ifInState?: string | null;
    create?: Record<string, JsEvent> | null;
    update?: Record<string, Record<string, unknown>> | null;
    destroy?: string[] | null;
  },
  ctx: CalendarCtx,
) {
  checkAccount(args.accountId, ctx);
  const client = makeClient(ctx);
  const cals = await client.listCalendars();
  const oldState = eventState(cals);
  if (args.ifInState && args.ifInState !== oldState) throw new JmapError("stateMismatch", "ifInState does not match");

  const created: Record<string, { id: string; uid: string }> = {};
  const notCreated: Record<string, SetError> = {};
  const updated: Record<string, null> = {};
  const notUpdated: Record<string, SetError> = {};
  const destroyed: string[] = [];
  const notDestroyed: Record<string, SetError> = {};
  const calById = new Map(cals.map((c) => [encodeId(c.href), c]));

  for (const [cid, ev] of Object.entries(args.create ?? {})) {
    try {
      const wanted = Object.keys((ev.calendarIds ?? {}) as Record<string, boolean>);
      const cal = wanted.length ? calById.get(wanted[0]!) : cals[0];
      if (!cal) throw new JmapError("invalidProperties", "unknown calendar in calendarIds");
      const uid = typeof ev.uid === "string" && ev.uid ? ev.uid : crypto.randomUUID();
      // The resource name only has to be unique in the collection; the UID is,
      // and keeping to a safe character set spares us URL-encoding questions.
      const href = `${cal.href}${uid.replace(/[^\w.@-]/g, "_")}.ics`;
      // An imported invitation keeps the organizer's SEQUENCE and its CREATED.
      const event: JsEvent = {
        ...ev,
        uid,
        sequence: Number(ev.sequence) || 0,
        created: typeof ev.created === "string" && !Number.isNaN(Date.parse(ev.created)) ? ev.created : new Date().toISOString(),
      };
      await client.putEvent(href, eventToIcal(event));
      created[cid] = { id: encodeId(`${cal.href}\n${href}`), uid };
    } catch (e) {
      notCreated[cid] = itemFailed("create", cid, e, Object.keys(ev));
    }
  }

  for (const [id, patch] of Object.entries(args.update ?? {})) {
    const parts = splitEventId(id);
    // Ids we didn't mint include Bulwark's synthetic-id probe; answering
    // invalidProperties (not notFound) tells it we don't take synthetic
    // occurrence ids, so it keeps expanding series itself. Not logged: the
    // probe runs on every calendar load.
    if (!parts) {
      notUpdated[id] = setError("invalidProperties", "not an event id");
      continue;
    }
    try {
      const calId = encodeId(parts.calHref);
      if (!calById.has(calId) || !isEventHref(client, parts)) throw new JmapError("notFound", "no such event");
      const [res] = await client.fetchEvents(parts.calHref, [parts.href]);
      const current = res && icalToEvent(res.data, id, calId);
      if (!res || !current) throw new JmapError("notFound", "no such event");

      const p = Object.fromEntries(Object.entries(patch).filter(([k]) => !EVENT_READ_ONLY.has(k.split("/")[0]!)));
      // Compared after patching, so a path like "calendarIds/<id>" is caught too.
      const calendarIdsBefore = JSON.stringify(current.calendarIds);
      const before = structuredClone(current);
      applyPatch(current, p);
      if (JSON.stringify(current.calendarIds) !== calendarIdsBefore) {
        throw new JmapError("invalidProperties", "moving events between calendars is not supported", { properties: ["calendarIds"] });
      }
      // A change of the event bumps SEQUENCE past the highest one stored
      // (writing an override back below its own is rejected with 412). A
      // reply alone does not: SEQUENCE belongs to the organizer (RFC 5546
      // §2.1.4), and an attendee's PARTSTAT change must leave it as it is.
      const reply = !("sequence" in p) && isReply(before, current);
      if (!("sequence" in p) && !reply) {
        current.sequence = Math.max(Number(current.sequence) || 0, highestSequence(res.data)) + 1;
      }
      // Without an etag there is nothing to make the write conditional on;
      // If-None-Match: * would refuse it, since the resource exists.
      await client.putEvent(parts.href, eventToIcal(current, res.data, { keepSequence: reply }), res.etag, { overwrite: true });
      updated[id] = null;
    } catch (e) {
      notUpdated[id] = itemFailed("update", id, e, Object.keys(patch));
    }
  }

  for (const id of args.destroy ?? []) {
    try {
      const parts = splitEventId(id);
      if (!parts || !calById.has(encodeId(parts.calHref)) || !isEventHref(client, parts)) throw new JmapError("notFound", "no such event");
      await client.deleteEvent(parts.href);
      destroyed.push(id);
    } catch (e) {
      notDestroyed[id] = itemFailed("destroy", id, e);
    }
  }

  const orNull = <T extends object>(o: T) => (Object.keys(o).length ? o : null);
  return {
    accountId: args.accountId,
    oldState,
    newState: served(ctx.account, eventState(await client.listCalendars())),
    created: orNull(created),
    updated: orNull(updated),
    destroyed: destroyed.length ? destroyed : null,
    notCreated: orNull(notCreated),
    notUpdated: orNull(notUpdated),
    notDestroyed: orNull(notDestroyed),
  };
}

// -- CalendarEventNotification/query, /get ----------------------------------------

// -- CalendarEvent/changes ---------------------------------------------------------

export async function calendarEventChanges(
  args: { accountId: string; sinceState: string; maxChanges?: number | null },
  ctx: CalendarCtx,
) {
  checkAccount(args.accountId, ctx);
  const client = makeClient(ctx);
  const cals = await client.listCalendars(true);
  const current = eventState(cals);
  const unchanged = { accountId: args.accountId, oldState: args.sinceState, newState: current, hasMoreChanges: false, created: [], updated: [], destroyed: [] };
  served(ctx.account, current);
  if (args.sinceState === current) return unchanged;

  // A calendar added or removed since: its events can't be told apart as
  // created or destroyed from tokens alone, so the client lists again.
  const since = decodeEventState(args.sinceState);
  if (!since || since.size !== cals.length || cals.some((c) => !versionOf(c) || !since.has(c.href))) throw new JmapError("cannotCalculateChanges");

  const updated: string[] = [];
  const destroyed: string[] = [];
  const versions: [string, string][] = [];
  for (const c of cals) {
    const was = since.get(c.href)!;
    const now = versionOf(c)!;
    if (was === now) {
      versions.push([c.href, was]);
      continue;
    }
    // Only a sync token can say what changed.
    const delta = was.startsWith("s:") && c.syncToken ? await client.syncChanges(c.href, was.slice(2)) : null;
    if (!delta) throw new JmapError("cannotCalculateChanges");
    // sync-collection doesn't say whether a resource is new or changed, and
    // RFC 8620 lets an id the client doesn't know arrive as updated.
    updated.push(...delta.changed.map((h) => encodeId(`${c.href}\n${h}`)));
    destroyed.push(...delta.removed.map((h) => encodeId(`${c.href}\n${h}`)));
    versions.push([c.href, `s:${delta.token}`]);
  }
  // Rather than invent paging over tokens, a client that wants fewer changes
  // than there are lists again.
  if (args.maxChanges && updated.length + destroyed.length > args.maxChanges) throw new JmapError("cannotCalculateChanges");
  return { ...unchanged, newState: eventStateOf(versions), updated, destroyed };
}

// CalDAV has no notification inbox. Bulwark polls these on every login and
// logs an error when the methods are missing, so answer with an empty one.
export function calendarEventNotificationQuery(args: { accountId: string }, account: AccountRow) {
  if (args.accountId !== String(account.id)) throw accountNotFound();
  return { accountId: args.accountId, queryState: "0", canCalculateChanges: false, position: 0, total: 0, ids: [] };
}

export function calendarEventNotificationGet(args: { accountId: string; ids?: string[] | null }, account: AccountRow) {
  if (args.accountId !== String(account.id)) throw accountNotFound();
  return { accountId: args.accountId, state: "0", list: [], notFound: args.ids ?? [] };
}

// -- CalendarEvent/parse -----------------------------------------------------------

// An invitation is a few KB and a calendar export rarely more than a few MB;
// anything larger is not read whole.
const MAX_PARSE_BYTES = 10 * 1024 * 1024;

// Bulwark parses .ics files here in two places: its calendar import uploads
// the file first, and the invitation banner passes the blobId of the mail's
// text/calendar part. Parsing needs no CalDAV, only the blob's bytes.
export async function calendarEventParse(
  args: { accountId: string; blobIds: string[] },
  ctx: { account: AccountRow; store: Store; pool: ImapPool },
) {
  if (args.accountId !== String(ctx.account.id)) throw accountNotFound();
  const parsed: Record<string, JsEvent[]> = {};
  const notFound: string[] = [];
  const notParsable: string[] = [];
  for (const blobId of args.blobIds ?? []) {
    const blob = await readBlob(blobId, ctx, MAX_PARSE_BYTES);
    if (!blob) {
      notFound.push(blobId);
      continue;
    }
    if (blob.body.length > MAX_PARSE_BYTES) {
      notParsable.push(blobId);
      continue;
    }
    const events = icalToEvents(blob.body.toString("utf8"));
    if (events.length) parsed[blobId] = events;
    else notParsable.push(blobId);
  }
  return { accountId: args.accountId, parsed, notParsable, notFound };
}
