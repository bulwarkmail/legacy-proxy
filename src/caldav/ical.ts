// iCalendar (RFC 5545) <-> JSCalendar (RFC 8984) for JMAP for Calendars.
// One CalDAV resource (a master VEVENT plus any RECURRENCE-ID
// overrides) becomes one JSCalendar Event. Recurrences are passed through as
// rules, not expanded - the client expands them itself.

import { escapeValue, fold, parseLine, unescapeValue, unfold, type ParsedLine } from "../carddav/vcard.js";
import { applyPatch } from "../jmap/methods/dav.js";
import { WINDOWS_ZONES } from "./windows-zones.js";
import crypto from "node:crypto";

interface Component {
  type: string;
  props: ParsedLine[];
  children: Component[];
}

export type JsEvent = Record<string, unknown>;

/** Parse an iCalendar body into its component tree (top level: VCALENDARs). */
export function parseComponents(text: string): Component[] {
  const root: Component = { type: "", props: [], children: [] };
  const stack = [root];
  for (const raw of unfold(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const p = parseLine(line, true);
    if (!p) continue;
    const top = stack[stack.length - 1]!;
    if (p.name === "BEGIN") {
      const c: Component = { type: p.value.toUpperCase(), props: [], children: [] };
      top.children.push(c);
      stack.push(c);
    } else if (p.name === "END") {
      if (stack.length > 1) stack.pop();
    } else {
      top.props.push(p);
    }
  }
  return root.children;
}

/**
 * Convert one CalDAV resource to a JSCalendar Event, or null when it holds
 * no VEVENT (e.g. a VTODO).
 */
export function icalToEvent(text: string, id: string, calendarId: string): JsEvent | null {
  return veventsToEvent(vevents(text), id, calendarId);
}

/**
 * Convert a whole iCalendar file - an .ics import or an invitation - to one
 * JSCalendar Event per UID, for CalendarEvent/parse. Unlike a CalDAV resource
 * such a file may carry any number of unrelated events.
 */
export function icalToEvents(ics: string): JsEvent[] {
  // A VEVENT without UID is an event of its own; grouping them under "" would
  // keep only the first.
  const byUid = new Map<string | symbol, Component[]>();
  for (const v of vevents(ics)) {
    const uid = text(v, "UID") || Symbol("no uid");
    if (!byUid.has(uid)) byUid.set(uid, []);
    byUid.get(uid)!.push(v);
  }
  const out: JsEvent[] = [];
  for (const group of byUid.values()) {
    // Without a master (an invitation to single occurrences), each instance
    // is an event of its own, with its recurrenceId.
    if (group.some((v) => !prop(v, "RECURRENCE-ID"))) out.push(veventsToEvent(group, null, null)!);
    else for (const v of group) out.push(veventsToEvent([v], null, null)!);
  }
  return out;
}

/**
 * Highest SEQUENCE across a resource's VEVENTs. Overrides can be ahead of the
 * master - mailbox.org bumps an edited override's SEQUENCE but leaves the
 * master's alone - so a rewrite has to start above all of them.
 */
export function highestSequence(ics: string): number {
  return Math.max(0, ...vevents(ics).map((v) => Number(prop(v, "SEQUENCE")?.value ?? 0) || 0));
}

function vevents(ics: string): Component[] {
  return parseComponents(ics)
    .flatMap((c) => c.children)
    .filter((c) => c.type === "VEVENT");
}

// What an override VEVENT can change for its occurrence. Anything it differs
// in has to be in the patch: an override that came back as an empty patch is
// written as RDATE, and its own VEVENT is gone. SEQUENCE is left out: every
// VEVENT of a resource is written with the master's, which an update raises
// to at least the highest stored.
const OVERRIDE_KEYS = [
  "start", "duration", "timeZone", "showWithoutTime", "title", "description", "locations", "status",
  "freeBusyStatus", "privacy", "participants", "alerts", "virtualLocations", "keywords",
] as const;

function veventsToEvent(vevents: Component[], id: string | null, calendarId: string | null): JsEvent | null {
  const master = vevents.find((v) => !prop(v, "RECURRENCE-ID"));
  if (!master) return vevents[0] ? instanceToEvent(vevents[0], id, calendarId) : null;

  const ev = eventProps(master);
  const tz = (ev.timeZone as string | null) ?? null;
  const overrides: Record<string, unknown> = {};

  // RDATE adds occurrences outside the rule; JSCalendar has them as overrides
  // whose key the rule doesn't produce (RFC 8984 §4.3.5), here empty patches.
  // EXDATE and RECURRENCE-ID below take precedence for the same key.
  for (const key of rdateKeys(master, tz)) overrides[key] = {};
  for (const ex of master.props.filter((p) => p.name === "EXDATE")) {
    for (const v of ex.value.split(",")) {
      const d = parseDate({ ...ex, value: v });
      if (d) overrides[inZone(d, tz)] = { excluded: true };
    }
  }
  for (const o of vevents) {
    const rid = o === master ? undefined : prop(o, "RECURRENCE-ID");
    const d = rid && parseDate(rid);
    if (!d) continue;
    const full = eventProps(o);
    const key = inZone(d, tz);
    const patch: Record<string, unknown> = {};
    for (const k of OVERRIDE_KEYS) {
      // An occurrence starts at its own slot unless it was moved.
      const unchanged = k === "start" ? full.start === key : JSON.stringify(full[k]) === JSON.stringify(ev[k]);
      if (!unchanged) patch[k] = full[k];
    }
    // Bulwark derives an occurrence's utcStart / utcEnd from its original slot
    // and prefers them over `start` for display, so a moved occurrence has to
    // carry its own or it keeps showing at the old time.
    if ("start" in patch || "duration" in patch || "timeZone" in patch) {
      patch.utcStart = full.utcStart;
      patch.utcEnd = full.utcEnd;
    }
    overrides[key] = patch;
  }

  const rrule = prop(master, "RRULE");
  return {
    id,
    "@type": "Event",
    calendarIds: calendarId === null ? null : { [calendarId]: true },
    ...ev,
    recurrenceRule: rrule ? parseRRule(rrule.value, tz) : null,
    recurrenceOverrides: Object.keys(overrides).length ? overrides : null,
    excludedRecurrenceRule: null,
    useDefaultAlerts: false,
    isDraft: false,
  };
}

// A resource can hold single occurrences of a series without its master
// (RFC 6638 §3.2.6: an attendee invited to only some instances). The first is
// the event, with its recurrenceId (RFC 8984 §4.3.1); eventToIcal keeps the
// others as they are.
function instanceToEvent(v: Component, id: string | null, calendarId: string | null): JsEvent {
  const rid = parseDate(prop(v, "RECURRENCE-ID"))!;
  return {
    id,
    "@type": "Event",
    calendarIds: calendarId === null ? null : { [calendarId]: true },
    ...eventProps(v),
    recurrenceId: rid.local,
    recurrenceIdTimeZone: rid.tz ?? null,
    recurrenceRule: null,
    recurrenceOverrides: null,
    excludedRecurrenceRule: null,
    useDefaultAlerts: false,
    isDraft: false,
  };
}

function eventProps(v: Component): JsEvent {
  const start = parseDate(prop(v, "DTSTART"));
  const end = parseDate(prop(v, "DTEND"));
  const allDay = start?.date ?? false;
  const tz = start && !allDay ? start.tz : null;

  let duration = prop(v, "DURATION")?.value ?? null;
  if (!duration) {
    duration = start && end ? formatDuration((utcMs(end) - utcMs(start)) / 1000, allDay) : allDay ? "P1D" : "PT0S";
  }
  // Floating time has no instant: reading it as UTC shifted Open-Xchange
  // replies (no TZID) by the viewer's offset. Without utcStart the client
  // shows the wall clock.
  const utcStart = start && !allDay && start.tz ? utcMs(start) : null;

  const location = text(v, "LOCATION");
  const cls = prop(v, "CLASS")?.value.toUpperCase();
  return {
    uid: text(v, "UID") ?? "",
    title: text(v, "SUMMARY") ?? "",
    description: text(v, "DESCRIPTION") ?? "",
    descriptionContentType: "text/plain",
    created: utcStamp(prop(v, "CREATED")),
    updated: utcStamp(prop(v, "LAST-MODIFIED") ?? prop(v, "DTSTAMP")),
    sequence: Number(prop(v, "SEQUENCE")?.value ?? 0) || 0,
    start: start?.local ?? null,
    timeZone: tz,
    showWithoutTime: allDay,
    duration,
    utcStart: utcStart === null ? null : isoUtc(utcStart),
    utcEnd: utcStart === null ? null : isoUtc(utcStart + durationSeconds(duration) * 1000),
    status: (prop(v, "STATUS")?.value.toLowerCase() as string | undefined) ?? "confirmed",
    freeBusyStatus: prop(v, "TRANSP")?.value.toUpperCase() === "TRANSPARENT" ? "free" : "busy",
    privacy: cls === "PRIVATE" ? "private" : cls === "CONFIDENTIAL" ? "secret" : "public",
    locations: location ? { "1": { "@type": "Location", name: location } } : null,
    virtualLocations: virtualLocations(v),
    keywords: keywords(v),
    participants: participants(v),
    alerts: alerts(v),
  };
}

// RFC 7986 CONFERENCE <-> virtualLocations: a meeting link with its label and features.
function virtualLocations(v: Component): Record<string, unknown> | null {
  const out: Record<string, unknown> = {};
  let n = 0;
  for (const p of v.props) {
    if (p.name !== "CONFERENCE" || !p.value.trim()) continue;
    const features = p.params.FEATURE?.map((f) => f.toLowerCase()).filter(Boolean) ?? [];
    out[`v${++n}`] = {
      "@type": "VirtualLocation",
      name: p.params.LABEL?.[0] ?? null,
      uri: p.value.trim(),
      features: features.length ? Object.fromEntries(features.map((f) => [f, true])) : null,
    };
  }
  return n ? out : null;
}

function conferenceLines(e: JsEvent): string[] {
  const out: string[] = [];
  for (const l of Object.values((e.virtualLocations ?? {}) as Record<string, { uri?: unknown; name?: unknown; features?: unknown }>)) {
    if (typeof l?.uri !== "string" || !l.uri.trim()) continue;
    const params = [";VALUE=URI"];
    const features = Object.keys((l.features ?? {}) as Record<string, unknown>).filter((f) => /^[\w-]+$/.test(f));
    if (features.length) params.push(`;FEATURE=${features.map((f) => f.toUpperCase()).join(",")}`);
    if (typeof l.name === "string" && l.name) params.push(`;LABEL=${quoteParam(l.name)}`);
    out.push(`CONFERENCE${params.join("")}:${l.uri.trim()}`);
  }
  return out;
}

// CATEGORIES <-> keywords. One property may list several, split at unescaped commas.
function keywords(v: Component): Record<string, boolean> | null {
  const out: Record<string, boolean> = {};
  for (const p of v.props) {
    if (p.name !== "CATEGORIES") continue;
    for (const k of p.value.split(/(?<!\\),/)) {
      const word = unescapeValue(k).trim();
      if (word) out[word] = true;
    }
  }
  return Object.keys(out).length ? out : null;
}

function categoriesLine(e: JsEvent): string[] {
  const words = Object.entries((e.keywords ?? {}) as Record<string, unknown>).filter(([k, on]) => on === true && k).map(([k]) => escapeValue(k));
  return words.length ? [`CATEGORIES:${words.join(",")}`] : [];
}

// iCalendar CUTYPE / ROLE <-> JSCalendar kind / roles (RFC 8984 §4.4.6,
// RFC 9253 for the mapping).
const CUTYPE_TO_KIND: Record<string, string> = { INDIVIDUAL: "individual", GROUP: "group", RESOURCE: "resource", ROOM: "location" };
const KIND_TO_CUTYPE: Record<string, string> = { individual: "INDIVIDUAL", group: "GROUP", resource: "RESOURCE", location: "ROOM" };

// A participant's id comes from its address, so a patch written against one
// version of the event still names the same person after the organizer added
// or removed someone. ORGANIZER and ATTENDEE lines for one address are one
// participant.
export function participantId(email: string): string {
  return "p" + crypto.createHash("sha1").update(email.toLowerCase()).digest("base64url").slice(0, 10);
}

function participants(v: Component): Record<string, unknown> | null {
  const out: Record<string, Record<string, unknown>> = {};
  let n = 0;
  for (const p of v.props) {
    if (p.name !== "ORGANIZER" && p.name !== "ATTENDEE") continue;
    const email = p.value.replace(/^mailto:/i, "");
    const roles: Record<string, boolean> = {};
    if (p.name === "ORGANIZER") roles.owner = true;
    else {
      const role = p.params.ROLE?.[0]?.toUpperCase();
      if (role === "NON-PARTICIPANT") roles.informational = true;
      else roles.attendee = true;
      if (role === "CHAIR") roles.chair = true;
      if (role === "OPT-PARTICIPANT") roles.optional = true;
    }
    const kind = CUTYPE_TO_KIND[p.params.CUTYPE?.[0]?.toUpperCase() ?? ""];
    const sentBy = p.params["SENT-BY"]?.[0]?.replace(/^mailto:/i, "");
    const agent = p.params["SCHEDULE-AGENT"]?.[0]?.toLowerCase();
    n++;
    const pid = participantId(email);
    const seen = out[pid];
    if (seen) {
      // The ATTENDEE line carries the answer; the ORGANIZER line only says who owns it.
      Object.assign(seen.roles as Record<string, boolean>, roles);
      if (p.name === "ATTENDEE") {
        seen.participationStatus = p.params.PARTSTAT?.[0]?.toLowerCase() ?? "needs-action";
        if (p.params.RSVP?.[0]?.toUpperCase() === "TRUE") seen.expectReply = true;
      }
      continue;
    }
    out[pid] = {
      "@type": "Participant",
      name: p.params.CN?.[0] ?? null,
      email,
      calendarAddress: `mailto:${email}`,
      roles,
      participationStatus: p.params.PARTSTAT?.[0]?.toLowerCase() ?? (p.name === "ORGANIZER" ? "accepted" : "needs-action"),
      ...(kind ? { kind } : {}),
      ...(p.params.RSVP?.[0]?.toUpperCase() === "TRUE" ? { expectReply: true } : {}),
      ...(sentBy ? { sentBy } : {}),
      ...(agent ? { scheduleAgent: agent } : {}),
    };
  }
  return n ? out : null;
}

// Parameters the participant mapping writes itself; everything else on an
// ORGANIZER / ATTENDEE line (DELEGATED-TO, LANGUAGE, X-...) is carried over
// from the original. SCHEDULE-STATUS and SCHEDULE-FORCE-SEND belong to the
// server and to one request respectively, so they are dropped.
const MANAGED_PARTICIPANT_PARAMS = new Set([
  "CN", "PARTSTAT", "ROLE", "RSVP", "CUTYPE", "SENT-BY", "SCHEDULE-AGENT", "SCHEDULE-STATUS", "SCHEDULE-FORCE-SEND",
]);

/** The original's ORGANIZER / ATTENDEE lines by "NAME address". */
function participantLines(c: Component | undefined): Map<string, ParsedLine> {
  const out = new Map<string, ParsedLine>();
  for (const p of c?.props ?? []) {
    if (p.name !== "ORGANIZER" && p.name !== "ATTENDEE") continue;
    out.set(`${p.name} ${p.value.replace(/^mailto:/i, "").toLowerCase()}`, p);
  }
  return out;
}

function participantLine(name: "ORGANIZER" | "ATTENDEE", addr: string, p: Record<string, unknown>, original: ParsedLine | undefined): string {
  // [name, value, already in wire form]
  const params: [string, string, boolean?][] = [];
  if (p.name) params.push(["CN", String(p.name)]);
  for (const [k, vs] of Object.entries(original?.params ?? {})) {
    if (!MANAGED_PARTICIPANT_PARAMS.has(k)) params.push([k, vs.map(quoteParam).join(","), true]);
  }
  const kind = typeof p.kind === "string" ? KIND_TO_CUTYPE[p.kind] : undefined;
  if (kind) params.push(["CUTYPE", kind]);
  if (typeof p.sentBy === "string" && p.sentBy) params.push(["SENT-BY", `mailto:${p.sentBy.replace(/^mailto:/i, "")}`]);
  if (typeof p.scheduleAgent === "string" && p.scheduleAgent) params.push(["SCHEDULE-AGENT", p.scheduleAgent.toUpperCase()]);
  if (name === "ATTENDEE") {
    const roles = (p.roles ?? {}) as Record<string, boolean>;
    const role = roles.chair ? "CHAIR" : roles.optional ? "OPT-PARTICIPANT" : roles.informational && !roles.attendee ? "NON-PARTICIPANT" : null;
    if (role) params.push(["ROLE", role]);
    if (p.expectReply === true) params.push(["RSVP", "TRUE"]);
    const stat = typeof p.participationStatus === "string" ? p.participationStatus.toUpperCase() : "NEEDS-ACTION";
    params.push(["PARTSTAT", stat]);
  }
  return `${name}${params.map(([k, v, wire]) => `;${k}=${wire ? v : quoteParam(v)}`).join("")}:mailto:${addr}`;
}

/** A VEVENT's VALARMs that have a TRIGGER; alert "aN" is the Nth of them. */
function triggeredAlarms(v: Component | undefined): Component[] {
  return (v?.children ?? []).filter((a) => a.type === "VALARM" && prop(a, "TRIGGER"));
}

function alerts(v: Component): Record<string, unknown> | null {
  const out: Record<string, unknown> = {};
  let n = 0;
  for (const a of triggeredAlarms(v)) {
    const t = prop(a, "TRIGGER")!;
    const abs = t.params.VALUE?.[0]?.toUpperCase() === "DATE-TIME";
    out[`a${++n}`] = {
      "@type": "Alert",
      trigger: abs
        ? { "@type": "AbsoluteTrigger", when: utcStamp(t) }
        : { "@type": "OffsetTrigger", offset: t.value, relativeTo: t.params.RELATED?.[0]?.toUpperCase() === "END" ? "end" : "start" },
      // AUDIO and other actions read as display; the stored VALARM keeps its own when written back.
      action: prop(a, "ACTION")?.value.toUpperCase() === "EMAIL" ? "email" : "display",
      // RFC 9074 §6
      acknowledged: utcStamp(prop(a, "ACKNOWLEDGED")),
      relatedTo: null,
    };
  }
  return n ? out : null;
}

// What alarmLines writes itself on a stored VALARM; the rest of it is kept.
const MANAGED_ALARM = new Set(["TRIGGER", "ACKNOWLEDGED"]);

/**
 * One alert as a VALARM. An alert read from a stored VALARM ("aN") is written
 * over that VALARM: its ACTION, DESCRIPTION, ATTENDEE, ATTACH, REPEAT, UID and
 * X- lines stay, so an AUDIO or EMAIL alarm stays one. A new alert, or one
 * switched between email and display, is a DISPLAY alarm: EMAIL alarms need
 * ATTENDEE and SUMMARY lines of their own (RFC 5545 §3.6.6).
 */
function alarmLines(id: string, a: Record<string, unknown>, title: unknown, stored: Component[]): string[] {
  const t = a.trigger as Record<string, string> | undefined;
  if (!t) return [];
  const trigger = t["@type"] === "AbsoluteTrigger" && t.when
    ? `TRIGGER;VALUE=DATE-TIME:${compactUtc(Date.parse(t.when))}`
    : `TRIGGER${t.relativeTo === "end" ? ";RELATED=END" : ""}:${t.offset ?? "PT0S"}`;
  const ackMs = typeof a.acknowledged === "string" ? Date.parse(a.acknowledged) : NaN;
  const ack = Number.isFinite(ackMs) ? [`ACKNOWLEDGED:${compactUtc(ackMs)}`] : [];
  const n = /^a([1-9]\d{0,5})$/.exec(id);
  const orig = n ? stored[Number(n[1]) - 1] : undefined;
  const origEmail = orig ? prop(orig, "ACTION")?.value.toUpperCase() === "EMAIL" : false;
  if (orig && origEmail === (a.action === "email")) {
    return [
      "BEGIN:VALARM",
      ...orig.props.filter((p) => !MANAGED_ALARM.has(p.name)).map(rawLine),
      trigger,
      ...ack,
      ...orig.children.flatMap(rawComponent),
      "END:VALARM",
    ];
  }
  return ["BEGIN:VALARM", "ACTION:DISPLAY", `DESCRIPTION:${escapeValue(String(title || "Reminder"))}`, trigger, ...ack, "END:VALARM"];
}

// -- RRULE ---------------------------------------------------------------------

export function parseRRule(value: string, tz: string | null): Record<string, unknown> {
  const parts = Object.fromEntries(
    value.split(";").map((kv) => {
      const i = kv.indexOf("=");
      return [kv.slice(0, i).toUpperCase(), kv.slice(i + 1)];
    }),
  );
  const nums = (k: string) => (parts[k] ? String(parts[k]).split(",").map(Number) : null);
  const until = parts.UNTIL ? parseDate({ name: "UNTIL", params: {}, value: parts.UNTIL }) : null;
  return {
    "@type": "RecurrenceRule",
    frequency: String(parts.FREQ ?? "DAILY").toLowerCase(),
    interval: Number(parts.INTERVAL ?? 1),
    firstDayOfWeek: String(parts.WKST ?? "MO").toLowerCase(),
    byDay: parts.BYDAY
      ? String(parts.BYDAY).split(",").map((d) => {
          const m = /^([+-]?\d+)?([A-Z]{2})$/i.exec(d.trim());
          const day = (m?.[2] ?? d).toLowerCase();
          return m?.[1] ? { "@type": "NDay", day, nthOfPeriod: Number(m[1]) } : { "@type": "NDay", day };
        })
      : null,
    byMonthDay: nums("BYMONTHDAY"),
    byMonth: parts.BYMONTH ? String(parts.BYMONTH).split(",") : null,
    byYearDay: nums("BYYEARDAY"),
    byWeekNo: nums("BYWEEKNO"),
    byHour: nums("BYHOUR"),
    byMinute: nums("BYMINUTE"),
    bySecond: nums("BYSECOND"),
    bySetPosition: nums("BYSETPOS"),
    count: parts.COUNT ? Number(parts.COUNT) : null,
    // A date-only UNTIL is inclusive of that whole day.
    until: until ? (until.date ? until.local.slice(0, 10) + "T23:59:59" : inZone(until, tz)) : null,
  };
}

// -- dates & time zones ----------------------------------------------------------

interface IcalDate {
  /** Wall-clock LocalDateTime, "YYYY-MM-DDTHH:MM:SS". */
  local: string;
  /** IANA zone, "Etc/UTC" for a Z value, null for floating or date-only. */
  tz: string | null;
  date: boolean;
}

/** The occurrences a VEVENT's RDATEs add, as LocalDateTimes in `tz`. */
function rdateKeys(master: Component, tz: string | null): string[] {
  const keys: string[] = [];
  for (const rd of master.props.filter((p) => p.name === "RDATE")) {
    for (const v of rd.value.split(",")) {
      // VALUE=PERIOD is start/end or start/duration: the start is the slot.
      // Its own length is not kept; the occurrence gets the event's duration.
      const d = parseDate({ ...rd, value: v.split("/")[0]! });
      if (d) keys.push(inZone(d, tz));
    }
  }
  return keys;
}

function parseDate(p: ParsedLine | undefined): IcalDate | null {
  const m = p && /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/.exec(p.value.trim());
  if (!p || !m) return null;
  const local = `${m[1]}-${m[2]}-${m[3]}T${m[4] ?? "00"}:${m[5] ?? "00"}:${m[6] ?? "00"}`;
  if (!m[4]) return { local, tz: null, date: true };
  if (m[7]) return { local, tz: "Etc/UTC", date: false };
  const tzid = p.params.TZID?.[0];
  // Outlook and Exchange write Windows zone names ("W. Europe Standard
  // Time"). Read as floating time, an accepted invitation was written back
  // without a zone and the server's reply put it an hour off. Any other
  // unknown TZID is still floating: resolving it would mean evaluating the
  // resource's VTIMEZONE, which we don't do.
  const zone = tzid && (validZone(tzid) ? tzid : WINDOWS_ZONES[tzid] ?? prefixedZone(tzid));
  return { local, tz: zone || null, date: false };
}

// Older Thunderbird, Evolution and Citadel write an IANA name behind a
// prefix of their own ("/mozilla.org/20050126_1/Europe/Berlin").
function prefixedZone(tzid: string): string | undefined {
  const m = /\/((?:Africa|America|Antarctica|Arctic|Asia|Atlantic|Australia|Europe|Indian|Pacific|Etc)\/[\w+-]+(?:\/[\w+-]+)?)$/.exec(tzid);
  return m && validZone(m[1]!) ? m[1] : undefined;
}

/** The date's wall clock in `tz` (unchanged when either side is floating). */
function inZone(d: IcalDate, tz: string | null): string {
  if (!tz || !d.tz || d.tz === tz || d.date) return d.local;
  return utcToLocal(utcMs(d), tz);
}

function utcMs(d: IcalDate): number {
  return localToUtc(d.local, d.tz ?? "Etc/UTC");
}

function validZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

const formatters = new Map<string, Intl.DateTimeFormat>();

export function utcToLocal(ms: number, tz: string): string {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz, hourCycle: "h23",
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
    });
    formatters.set(tz, f);
  }
  const p = Object.fromEntries(f.formatToParts(ms).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}`;
}

/** Instant at which the wall clock in `tz` reads `local`. */
export function localToUtc(local: string, tz: string): number {
  const naive = Date.parse(local + "Z");
  const offsetAt = (t: number) => Date.parse(utcToLocal(t, tz) + "Z") - t;
  // Second pass settles instants near a DST switch.
  return naive - offsetAt(naive - offsetAt(naive));
}

function isoUtc(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
}

function utcStamp(p: ParsedLine | undefined): string | null {
  const d = parseDate(p);
  return d ? isoUtc(utcMs(d)) : null;
}

function formatDuration(seconds: number, allDay: boolean): string {
  const s = Math.max(0, Math.round(seconds));
  if (allDay || (s > 0 && s % 86400 === 0)) return `P${Math.max(1, Math.round(s / 86400))}D`;
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  const time = `${h ? `${h}H` : ""}${m ? `${m}M` : ""}${r ? `${r}S` : ""}`;
  return `P${d ? `${d}D` : ""}${time ? `T${time}` : d ? "" : "T0S"}`;
}

function durationSeconds(d: string): number {
  const m = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(d);
  if (!m) return 0;
  const [, sign, w, dd, h, mi, s] = m.map((x) => x ?? "0");
  const total = ((Number(w) * 7 + Number(dd)) * 24 + Number(h)) * 3600 + Number(mi) * 60 + Number(s);
  return sign === "-" ? -total : total;
}

function prop(c: Component, name: string): ParsedLine | undefined {
  return c.props.find((p) => p.name === name);
}

function text(c: Component, name: string): string | undefined {
  const p = prop(c, name);
  return p ? unescapeValue(p.value) : undefined;
}

// -- JSCalendar -> iCalendar -------------------------------------------------------

// VEVENT properties eventToIcal writes itself; anything else on an existing
// master event (X-*, URL, ATTACH, CATEGORIES, ...) is carried over verbatim.
const MANAGED = new Set([
  "UID", "DTSTAMP", "DTSTART", "DTEND", "DURATION", "SUMMARY", "DESCRIPTION", "LOCATION", "RRULE",
  "EXDATE", "RDATE", "RECURRENCE-ID", "STATUS", "TRANSP", "CLASS", "CREATED", "LAST-MODIFIED",
  "SEQUENCE", "ORGANIZER", "ATTENDEE", "CONFERENCE", "CATEGORIES",
]);

/**
 * Serialise a JSCalendar Event as a CalDAV resource. `original` is the stored
 * iCalendar body on update: its VTIMEZONEs and unmodelled master properties
 * are kept.
 */
export function eventToIcal(ev: JsEvent, original?: string, opts: { keepSequence?: boolean } = {}): string {
  const tz = typeof ev.timeZone === "string" && validZone(ev.timeZone) ? ev.timeZone : null;
  const allDay = ev.showWithoutTime === true;
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Bulwark//legacy-proxy//EN", "CALSCALE:GREGORIAN"];
  const overrides = (ev.recurrenceOverrides ?? {}) as Record<string, Record<string, unknown>>;

  // Every zone a DTSTART or DTEND is written in needs its VTIMEZONE (RFC 5545
  // §3.2.19), an occurrence moved to another zone included.
  // From the parsed tree, line by line: a regex over the raw text takes
  // quadratic time on a body full of unclosed VTIMEZONEs.
  const keptZones = original ? parseComponents(original).flatMap((c) => c.children).filter((c) => c.type === "VTIMEZONE") : [];
  for (const z of keptZones) lines.push(...rawComponent(z));
  const year = Number(String(ev.start ?? "").slice(0, 4)) || new Date().getUTCFullYear();
  const zones = new Set<string>();
  if (tz && !allDay) zones.add(tz);
  if (typeof ev.recurrenceIdTimeZone === "string" && validZone(ev.recurrenceIdTimeZone)) zones.add(ev.recurrenceIdTimeZone);
  for (const o of Object.values(overrides)) {
    if (typeof o.timeZone === "string" && validZone(o.timeZone) && !(o.showWithoutTime ?? allDay)) zones.add(o.timeZone);
  }
  for (const z of zones) {
    if (isUtc(z) || keptZones.some((k) => prop(k, "TZID")?.value.trim() === z)) continue;
    lines.push(...vtimezone(z, year));
  }

  // A single occurrence stored without its series (see instanceToEvent) is
  // written back with its RECURRENCE-ID; other such occurrences in the same
  // resource stay as they were.
  const instance = typeof ev.recurrenceId === "string" ? ev.recurrenceId : null;
  const instanceTz = typeof ev.recurrenceIdTimeZone === "string" && validZone(ev.recurrenceIdTimeZone) ? ev.recurrenceIdTimeZone : tz;
  const origVevents = original ? vevents(original) : [];
  const ridOf = (c: Component) => {
    const d = parseDate(prop(c, "RECURRENCE-ID"));
    return d ? d.local : null;
  };
  const masterOrig = instance === null
    ? origVevents.find((c) => !prop(c, "RECURRENCE-ID"))
    : origVevents.find((c) => ridOf(c) === instance) ?? origVevents[0];
  const extra = masterOrig ? masterOrig.props.filter((p) => !MANAGED.has(p.name)).map(rawLine) : [];

  const exdates = Object.entries(overrides).filter(([, o]) => o.excluded).map(([k]) => dateLine("EXDATE", k, tz, allDay));
  // An added occurrence comes back as an override with an empty patch; one the
  // original had as RDATE may carry changes too. Both need their RDATE, or the
  // occurrence (and any RECURRENCE-ID written for it) is gone. RDATE on a slot
  // the rule produces as well is counted once (RFC 5545 §3.8.5.3), so writing
  // it for an untouched rule occurrence is harmless.
  const originalRdates = new Set(masterOrig && instance === null ? rdateKeys(masterOrig, tz) : []);
  const isRdate = (k: string, o: Record<string, unknown>) => !o.excluded && (Object.keys(o).length === 0 || originalRdates.has(k));
  const rdates = Object.entries(overrides).filter(([k, o]) => isRdate(k, o)).map(([k]) => dateLine("RDATE", k, tz, allDay));
  const origParts = participantLines(masterOrig);
  const rule = ev.recurrenceRule ? [`RRULE:${rruleString(ev.recurrenceRule as Record<string, unknown>, tz, allDay)}`] : [];
  const instanceLine = instance === null ? undefined : dateLine("RECURRENCE-ID", instance, instanceTz, allDay);
  lines.push(...vevent(ev, tz, allDay, [...rule, ...rdates, ...exdates, ...extra], instanceLine, origParts, masterOrig));
  if (instance !== null) {
    for (const c of origVevents) if (c !== masterOrig && prop(c, "RECURRENCE-ID")) lines.push(...rawComponent(c));
  }

  // The stored override VEVENTs by occurrence key, for what the mapping
  // doesn't model (X- properties, parameters on its attendees).
  const origOverrides = new Map<string, Component>();
  for (const c of instance === null ? origVevents : []) {
    const d = parseDate(prop(c, "RECURRENCE-ID"));
    if (d) origOverrides.set(inZone(d, tz), c);
  }
  const base: JsEvent = { ...ev, recurrenceRule: null, recurrenceOverrides: null };
  for (const [key, patch] of Object.entries(overrides)) {
    if (patch.excluded || Object.keys(patch).length === 0) continue;
    const o = structuredClone(base);
    applyPatch(o, patch);
    const oTz = typeof o.timeZone === "string" && validZone(o.timeZone) ? o.timeZone : null;
    const own = origOverrides.get(key);
    // A reply leaves every VEVENT at the SEQUENCE it had: it is the organizer's.
    const ownSeq = own && prop(own, "SEQUENCE");
    if (opts.keepSequence && ownSeq) o.sequence = Number(ownSeq.value) || 0;
    const ownExtra = own ? own.props.filter((p) => !MANAGED.has(p.name)).map(rawLine) : [];
    const ownParts = own ? new Map([...origParts, ...participantLines(own)]) : origParts;
    // Alerts the occurrence doesn't change are the series', and so are their VALARMs.
    const alarmSource = own && "alerts" in patch ? own : masterOrig;
    lines.push(...vevent(o, oTz, o.showWithoutTime === true, ownExtra, dateLine("RECURRENCE-ID", key, tz, allDay), ownParts, own, alarmSource));
  }
  lines.push("END:VCALENDAR");
  // Each entry is one content line. A line break in a value that skipped
  // escaping would start a property of its own, so none gets through.
  return lines.map((l) => fold(l.replace(/[\r\n]+/g, " "))).join("\r\n") + "\r\n";
}

function vevent(
  e: JsEvent,
  tz: string | null,
  allDay: boolean,
  extra: string[],
  recurrenceId?: string,
  originalParticipants?: Map<string, ParsedLine>,
  stored?: Component,
  alarmSource: Component | undefined = stored,
): string[] {
  const start = String(e.start ?? "");
  // UID is TEXT (RFC 5545 §3.8.4.7) and read back unescaped, so it is written escaped.
  const out = ["BEGIN:VEVENT", `UID:${escapeValue(String(e.uid ?? ""))}`, `DTSTAMP:${compactUtc(Date.now())}`];
  if (recurrenceId) out.push(recurrenceId);
  out.push(dateLine("DTSTART", start, tz, allDay));
  out.push(dateLine("DTEND", addSeconds(start, durationSeconds(String(e.duration ?? (allDay ? "P1D" : "PT0S"))), tz, allDay), tz, allDay));
  if (e.title) out.push(`SUMMARY:${escapeValue(String(e.title))}`);
  if (e.description) out.push(`DESCRIPTION:${escapeValue(String(e.description))}`);
  const loc = Object.values((e.locations ?? {}) as Record<string, { name?: string }>).find((l) => l?.name)?.name;
  if (loc) out.push(`LOCATION:${escapeValue(loc)}`);
  out.push(...conferenceLines(e), ...categoriesLine(e));
  if (typeof e.status === "string") out.push(`STATUS:${e.status.toUpperCase()}`);
  out.push(`TRANSP:${e.freeBusyStatus === "free" ? "TRANSPARENT" : "OPAQUE"}`);
  out.push(`CLASS:${e.privacy === "private" ? "PRIVATE" : e.privacy === "secret" ? "CONFIDENTIAL" : "PUBLIC"}`);
  out.push(`SEQUENCE:${Number(e.sequence ?? 0) || 0}`);
  if (typeof e.created === "string") out.push(`CREATED:${compactUtc(Date.parse(e.created))}`);
  out.push(`LAST-MODIFIED:${compactUtc(Date.now())}`);
  out.push(...extra);

  for (const p of Object.values((e.participants ?? {}) as Record<string, Record<string, unknown>>)) {
    const send = (p.sendTo as Record<string, string> | undefined)?.imip;
    const addr = String(p.email ?? send ?? p.calendarAddress ?? "").replace(/^mailto:/i, "");
    if (!addr) continue;
    const roles = (p.roles ?? {}) as Record<string, boolean>;
    const orig = (n: string) => originalParticipants?.get(`${n} ${addr.toLowerCase()}`);
    if (roles.owner) out.push(participantLine("ORGANIZER", addr, p, orig("ORGANIZER")));
    if (!roles.owner || roles.attendee || roles.chair || roles.optional) {
      out.push(participantLine("ATTENDEE", addr, p, orig("ATTENDEE")));
    }
  }

  const storedAlarms = triggeredAlarms(alarmSource);
  for (const [id, a] of Object.entries((e.alerts ?? {}) as Record<string, Record<string, unknown> | null>)) {
    if (a) out.push(...alarmLines(id, a, e.title, storedAlarms));
  }
  out.push("END:VEVENT");
  return out;
}

function rruleString(r: Record<string, unknown>, tz: string | null, allDay: boolean): string {
  const parts = [`FREQ=${String(r.frequency ?? "daily").toUpperCase()}`];
  if (r.interval && r.interval !== 1) parts.push(`INTERVAL=${r.interval}`);
  if (r.count) parts.push(`COUNT=${r.count}`);
  if (typeof r.until === "string") {
    const until = r.until.slice(0, 19);
    parts.push(`UNTIL=${allDay ? until.slice(0, 10).replace(/-/g, "") : compactUtc(localToUtc(until, tz ?? "Etc/UTC"))}`);
  }
  const days = r.byDay as Array<{ day: string; nthOfPeriod?: number }> | null | undefined;
  if (days?.length) parts.push(`BYDAY=${days.map((d) => `${d.nthOfPeriod ?? ""}${d.day.toUpperCase()}`).join(",")}`);
  const lists: Array<[string, string]> = [
    ["byMonthDay", "BYMONTHDAY"], ["byMonth", "BYMONTH"], ["byYearDay", "BYYEARDAY"], ["byWeekNo", "BYWEEKNO"],
    ["byHour", "BYHOUR"], ["byMinute", "BYMINUTE"], ["bySecond", "BYSECOND"], ["bySetPosition", "BYSETPOS"],
  ];
  for (const [k, name] of lists) {
    const v = r[k] as unknown[] | null | undefined;
    if (v?.length) parts.push(`${name}=${v.join(",")}`);
  }
  if (typeof r.firstDayOfWeek === "string" && r.firstDayOfWeek !== "mo") parts.push(`WKST=${r.firstDayOfWeek.toUpperCase()}`);
  return parts.join(";");
}

function dateLine(name: string, local: string, tz: string | null, allDay: boolean): string {
  const compact = local.slice(0, 19).replace(/[-:]/g, "");
  if (allDay) return `${name};VALUE=DATE:${compact.slice(0, 8)}`;
  if (tz && isUtc(tz)) return `${name}:${compact}Z`;
  return tz ? `${name};TZID=${tz}:${compact}` : `${name}:${compact}`;
}

function addSeconds(local: string, secs: number, tz: string | null, allDay: boolean): string {
  const l = local.slice(0, 19);
  if (allDay || !tz) return new Date(Date.parse(l + "Z") + secs * 1000).toISOString().slice(0, 19);
  return utcToLocal(localToUtc(l, tz) + secs * 1000, tz);
}

/**
 * Build a VTIMEZONE for `tz` from the platform's zone data, describing the
 * given year's transitions as yearly "nth / last weekday of the month" rules.
 * That holds for the EU and US zones; for anything more irregular the block
 * is only approximate, but it still carries the IANA TZID, which CalDAV
 * servers resolve on their own.
 */
function vtimezone(tz: string, year: number): string[] {
  const off = (ms: number) => Math.round((Date.parse(utcToLocal(ms, tz) + "Z") - ms) / 60_000);
  const fmtOff = (m: number) => `${m < 0 ? "-" : "+"}${String(Math.floor(Math.abs(m) / 60)).padStart(2, "0")}${String(Math.abs(m) % 60).padStart(2, "0")}`;
  const out = ["BEGIN:VTIMEZONE", `TZID:${tz}`];
  const from = Date.UTC(year, 0, 1), to = Date.UTC(year + 1, 0, 1);
  const DAY = 86_400_000, MINUTE = 60_000;
  let prev = off(from);
  let found = false;
  // Day by day, then narrowed to the minute: zones don't all switch on a UTC
  // hour (America/St_Johns switches at 05:30 UTC).
  for (let next = from + DAY; next <= to; next += DAY) {
    if (off(next) === prev) continue;
    let lo = next - DAY, hi = next;
    while (hi - lo > MINUTE) {
      const mid = lo + Math.floor((hi - lo) / 2 / MINUTE) * MINUTE;
      if (off(mid) === prev) lo = mid;
      else hi = mid;
    }
    const t = hi;
    const o = off(t);
    const wall = new Date(t + prev * 60_000);
    const day = wall.getUTCDate();
    const dim = new Date(Date.UTC(wall.getUTCFullYear(), wall.getUTCMonth() + 1, 0)).getUTCDate();
    const nth = day + 7 > dim ? -1 : Math.ceil(day / 7);
    const wd = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"][wall.getUTCDay()];
    const kind = o > prev ? "DAYLIGHT" : "STANDARD";
    out.push(`BEGIN:${kind}`, `DTSTART:${wall.toISOString().slice(0, 19).replace(/[-:]/g, "")}`,
      `TZOFFSETFROM:${fmtOff(prev)}`, `TZOFFSETTO:${fmtOff(o)}`,
      `RRULE:FREQ=YEARLY;BYMONTH=${wall.getUTCMonth() + 1};BYDAY=${nth}${wd}`, `END:${kind}`);
    prev = o;
    found = true;
  }
  if (!found) {
    out.push("BEGIN:STANDARD", "DTSTART:19700101T000000", `TZOFFSETFROM:${fmtOff(prev)}`, `TZOFFSETTO:${fmtOff(prev)}`, "END:STANDARD");
  }
  out.push("END:VTIMEZONE");
  return out;
}

function isUtc(tz: string): boolean {
  return tz === "UTC" || tz === "Etc/UTC";
}

function compactUtc(ms: number): string {
  return new Date(ms).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

// Without recursion: an unclosed BEGIN nests everything after it, so a
// hostile body can be nested as deep as it has lines.
function rawComponent(c: Component): string[] {
  const out: string[] = [];
  const todo: (Component | string)[] = [c];
  while (todo.length) {
    const next = todo.pop()!;
    if (typeof next === "string") {
      out.push(next);
      continue;
    }
    out.push(`BEGIN:${next.type}`, ...next.props.map(rawLine));
    todo.push(`END:${next.type}`, ...[...next.children].reverse());
  }
  return out;
}

function rawLine(p: ParsedLine): string {
  const params = Object.entries(p.params).map(([k, vs]) => `;${k}=${vs.map(quoteParam).join(",")}`).join("");
  return `${p.name}${params}:${p.value}`;
}

function quoteParam(v: string): string {
  return /[:;,]/.test(v) ? `"${v.replace(/"/g, "")}"` : v;
}
