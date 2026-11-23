// End-to-end tests for Calendar/get and CalendarEvent/query, /get and /set
// against a fake CalDAV server on globalThis.fetch, logging in with the
// provider's own DAV credentials rather than the mail ones. CalendarEvent/parse
// reads blobs, not CalDAV, so it gets a fake store and IMAP pool instead.

import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { isMember, calendarEventChanges, calendarSet, calendarUserAddresses, calendarEventGet, calendarEventParse, calendarEventQuery, calendarEventSet, calendarGet, type CalendarCtx } from "../../src/jmap/methods/calendars.js";
import { resetCardDavCaches } from "../../src/carddav/client.js";
import { resetCalDavCaches } from "../../src/caldav/client.js";
import { Readable } from "node:stream";
import type { AccountRow, Store } from "../../src/state/store.js";
import type { ImapPool } from "../../src/imap/pool.js";
import { encodeBlobId, encodeEmailId } from "../../src/mapping/ids.js";
import type { ProviderConfig } from "../../src/util/config.js";

const EVENT = "BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:u1\r\nDTSTART:20261007T120000Z\r\nDTEND:20261007T130000Z\r\nSUMMARY:Lunch & talk\r\nEND:VEVENT\r\nEND:VCALENDAR";
const ms = (body: string) =>
  new Response(`<?xml version="1.0"?><D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">${body}</D:multistatus>`, { status: 207 });

let reports: string[] = [];
let store = new Map<string, { data: string; etag: string }>();
let etagSeq = 1;
// RFC 6578 change log of the fake server: every PUT / DELETE gets a sequence
// number, and the sync token is the latest one.
let changeLog: { seq: number; href: string; gone: boolean }[] = [];
let syncSeq = 0;
// A second calendar with a ctag but no sync token, like mailbox.org's birthdays.
let birthdaysCtag: string | null = null;
// Calendar collections beyond "work", and what MKCALENDAR / PROPPATCH set.
let collections = new Map<string, { name: string; color?: string; order?: string; desc?: string }>();
// Open-Xchange (mailbox.org): MKCALENDAR with a description is refused, and
// description or calendar-order are answered with 200 but not kept.
let oxQuirks = false;
// A plain RFC 4791 server: neither sync-token nor getctag on its calendars.
let plainServer = false;
// Leaves getetag out of calendar-multiget answers.
let noEtags = false;
// Reports a removed member as "HTTP/1.1 404", without a reason phrase.
let bareStatus = false;
// Answers a Depth-1 PROPFIND on a calendar with its own href written as an absolute URL without the slash.
let oddSelfHref = false;
const propOf = (body: string, name: string) => new RegExp(`<[A-Z]:${name}>([^<]*)</[A-Z]:${name}>`).exec(body)?.[1];
const logChange = (href: string, gone: boolean) => changeLog.push({ seq: ++syncSeq, href, gone });
// Like real servers, answer with percent-encoded hrefs (`@` -> `%40`).
const resp = (href: string, r: { data: string; etag: string }) =>
  `<D:response><D:href>${href.replace(/@/g, "%40")}</D:href><D:propstat><D:prop>${noEtags ? "" : `<D:getetag>${r.etag}</D:getetag>`}<C:calendar-data>${r.data.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</C:calendar-data></D:prop></D:propstat></D:response>`;

beforeEach(() => {
  resetCardDavCaches();
  resetCalDavCaches();
  reports = [];
  store = new Map([["/cal/u/work/1.ics", { data: EVENT, etag: `"1"` }]]);
  etagSeq = 1;
  changeLog = [];
  syncSeq = 0;
  birthdaysCtag = null;
  collections = new Map([["/cal/u/work/", { name: "Work", color: "#FF0000FF" }]]);
  oxQuirks = false;
  plainServer = false;
  noEtags = false;
  bareStatus = false;
  oddSelfHref = false;
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    const auth = (init.headers as Record<string, string>).Authorization;
    if (auth !== "Basic " + Buffer.from("dav-user:dav-pw").toString("base64")) return new Response("", { status: 401 });
    let path = new URL(url).pathname;
    const body = String(init.body ?? "");
    if (init.method === "PROPFIND" && path === "/.well-known/caldav") return new Response("", { status: 301, headers: { location: "/dav/" } });
    if (init.method === "PROPFIND" && path === "/dav/" && body.includes("current-user-principal"))
      return ms(`<D:response><D:href>/dav/</D:href><D:propstat><D:prop><D:current-user-principal><D:href>/p/u/</D:href></D:current-user-principal></D:prop></D:propstat></D:response>`);
    if (init.method === "PROPFIND" && path === "/dav/") return ms(`<D:response><D:href>/dav/</D:href></D:response>`);
    if (init.method === "PROPFIND" && path === "/p/u/" && body.includes("calendar-user-address-set"))
      return ms(
        `<D:response><D:href>/p/u/</D:href><D:propstat><D:prop><calendar-user-address-set xmlns="urn:ietf:params:xml:ns:caldav">` +
        `<D:href>mailto:alias%40example.org</D:href><D:href preferred="1">mailto:mail@example.org</D:href><D:href>/p/u/</D:href><D:href>urn:uuid:1</D:href>` +
        `</calendar-user-address-set></D:prop></D:propstat></D:response>`,
      );
    if (init.method === "PROPFIND" && path === "/p/u/")
      return ms(`<D:response><D:href>/p/u/</D:href><D:propstat><D:prop><C:calendar-home-set><D:href>/cal/u/</D:href></C:calendar-home-set></D:prop></D:propstat></D:response>`);
    if (init.method === "PROPFIND" && path === "/cal/u/")
      return ms(
        `<D:response><D:href>/cal/u/</D:href><D:propstat><D:prop><D:resourcetype><D:collection/></D:resourcetype></D:prop></D:propstat></D:response>` +
        `<D:response><D:href>/cal/u/proxy/</D:href><D:propstat><D:prop><D:resourcetype><D:collection/><C:calendar-proxy-read/></D:resourcetype></D:prop></D:propstat></D:response>` +
        [...collections].map(([href, c]) =>
          `<D:response><D:href>${href}</D:href><D:propstat><D:prop><D:resourcetype><D:collection/><C:calendar/></D:resourcetype><D:displayname>${c.name}</D:displayname>` +
          (c.color ? `<x:calendar-color xmlns:x="http://apple.com/ns/ical/">${c.color}</x:calendar-color>` : "") +
          (c.order ? `<x:calendar-order xmlns:x="http://apple.com/ns/ical/">${c.order}</x:calendar-order>` : "") +
          (c.desc ? `<C:calendar-description>${c.desc}</C:calendar-description>` : "") +
          (plainServer ? "" : `<D:sync-token>http://t/${syncSeq}</D:sync-token>`) + `</D:prop></D:propstat></D:response>`).join("") +
        (birthdaysCtag === null ? "" : `<D:response><D:href>/cal/u/bday/</D:href><D:propstat><D:prop><D:resourcetype><D:collection/><C:calendar/></D:resourcetype><D:displayname>Birthdays</D:displayname><CS:getctag xmlns:CS="http://calendarserver.org/ns/">${birthdaysCtag}</CS:getctag></D:prop></D:propstat></D:response>`),
      );
    if (init.method === "PROPFIND" && collections.has(path) && body.includes("getetag")) {
      const members = [...store].filter(([h]) => h.startsWith(path));
      const self = oddSelfHref ? `https://dav.example${path.replace(/\/$/, "")}` : path;
      return ms(`<D:response><D:href>${self}</D:href><D:propstat><D:prop><D:resourcetype><D:collection/><C:calendar/></D:resourcetype></D:prop></D:propstat></D:response>` + members.map(([h, r]) =>
        `<D:response><D:href>${h}</D:href><D:propstat><D:prop><D:getetag>${r.etag}</D:getetag></D:prop></D:propstat></D:response>`).join(""));
    }
    if (init.method === "REPORT" && body.includes("sync-collection")) {
      reports.push(body);
      const since = /<D:sync-token>http:\/\/t\/(\d+)<\/D:sync-token>/.exec(body)?.[1];
      if (since === undefined) return new Response("", { status: 403 });
      const latest = new Map<string, boolean>();
      for (const c of changeLog) if (c.seq > Number(since)) latest.set(c.href, c.gone);
      const items = [...latest].map(([h, gone]) =>
        gone ? `<D:response><D:href>${h}</D:href><D:status>HTTP/1.1 404${bareStatus ? "" : " Not Found"}</D:status></D:response>` : resp(h, store.get(h)!),
      );
      // bareStatus also cuts the answer short (RFC 6578 §3.6: 507 on the collection).
      const cut = bareStatus ? `<D:response><D:href>${path}</D:href><D:status>HTTP/1.1 507</D:status></D:response>` : "";
      return ms(items.join("") + cut + `<D:sync-token>http://t/${syncSeq}</D:sync-token>`);
    }
    if (init.method === "REPORT") {
      reports.push(body);
      const wanted = body.includes("calendar-multiget") ? [...body.matchAll(/<D:href>([^<]+)<\/D:href>/g)].map((m) => decodeURIComponent(m[1]!)) : [...store.keys()];
      return ms(wanted.filter((h) => store.has(h)).map((h) => resp(h, store.get(h)!)).join(""));
    }
    if (init.method === "MKCALENDAR") {
      if (collections.has(path)) return new Response("", { status: 405 });
      if (oxQuirks && body.includes("calendar-description")) return new Response("No folder permission.", { status: 403 });
      // Open-Xchange files the new calendar under a folder id of its own.
      if (oxQuirks) path = `/cal/u/ox-${collections.size}/`;
      collections.set(path, { name: propOf(body, "displayname") ?? "", color: propOf(body, "calendar-color"), order: oxQuirks ? undefined : propOf(body, "calendar-order"), desc: propOf(body, "calendar-description") });
      return new Response(null, { status: 201 });
    }
    if (init.method === "PROPPATCH") {
      const c = collections.get(path);
      if (!c) return new Response("", { status: 404 });
      const set = body.split("<D:remove>")[0]!;
      const tags = [["name", "displayname"], ["color", "calendar-color"], ["order", "calendar-order"], ["desc", "calendar-description"]] as const;
      for (const [k, tag] of tags.filter(([k]) => !oxQuirks || (k !== "order" && k !== "desc"))) {
        const v = propOf(set, tag);
        if (v !== undefined) c[k] = v;
      }
      if (body.includes("<D:remove>") && body.split("<D:remove>")[1]!.includes("calendar-description")) delete c.desc;
      return ms(`<D:response><D:href>${path}</D:href><D:propstat><D:prop/><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`);
    }
    if (init.method === "DELETE" && collections.has(path)) {
      collections.delete(path);
      for (const h of [...store.keys()]) if (h.startsWith(path)) store.delete(h);
      return new Response(null, { status: 204 });
    }
    const headers = init.headers as Record<string, string>;
    if (init.method === "PUT") {
      const existing = store.get(path);
      if (headers["If-None-Match"] === "*" && existing) return new Response("", { status: 412 });
      if (headers["If-Match"] && headers["If-Match"] !== existing?.etag) return new Response("", { status: 412 });
      const etag = `"${++etagSeq}"`;
      store.set(path, { data: body, etag });
      logChange(path, false);
      return new Response(null, { status: existing ? 204 : 201, headers: { etag } });
    }
    if (init.method === "DELETE") {
      const existed = store.delete(path);
      if (existed) logChange(path, true);
      return new Response(null, { status: existed ? 204 : 404 });
    }
    return new Response("", { status: 404 });
  });
});
afterEach(() => vi.unstubAllGlobals());

it("lists calendars and reads events in a time range with separate DAV credentials", async () => {
  const provider = { caldav: { host: "dav.example", port: 443, secure: true, username: "dav-user", password: "dav-pw", forUser: "mail" } } as ProviderConfig;
  const ctx: CalendarCtx = { account: { id: 1 } as AccountRow, provider, creds: { mech: "PLAIN", username: "mail", password: "x" } };

  const cals = await calendarGet({ accountId: "1" }, ctx);
  expect(cals.list).toMatchObject([{ name: "Work", color: "#FF0000", isDefault: true }]);

  const q = await calendarEventQuery(
    { accountId: "1", filter: { inCalendars: [cals.list[0]!.id], after: "2026-10-01T00:00:00", before: "2026-11-01T00:00:00" }, timeZone: "Europe/Berlin" },
    ctx,
  );
  expect(q.total).toBe(1);
  // Berlin midnight on 1 Oct is 22:00 UTC the day before.
  expect(reports[0]).toContain(`start="20260930T220000Z" end="20261031T230000Z"`);

  const got = await calendarEventGet({ accountId: "1", ids: [...q.ids, "bogus"] }, ctx);
  expect(got.list).toMatchObject([{ id: q.ids[0], title: "Lunch & talk", utcStart: "2026-10-07T12:00:00Z", duration: "PT1H" }]);
  expect(got.notFound).toEqual(["bogus"]);

  // A reload within the cache window is served from the etag-keyed body cache.
  const before = reports.length;
  const again = await calendarEventGet({ accountId: "1", ids: q.ids }, ctx);
  expect(again.list).toHaveLength(1);
  expect(reports.length).toBe(before);
});

it("filters by uid and refuses filters it can't evaluate", async () => {
  const provider = { caldav: { host: "dav.example", port: 443, secure: true, username: "dav-user", password: "dav-pw", forUser: "mail" } } as ProviderConfig;
  const ctx: CalendarCtx = { account: { id: 1 } as AccountRow, provider, creds: { mech: "PLAIN", username: "mail", password: "x" } };
  store.set("/cal/u/work/2.ics", { data: EVENT.replace("UID:u1", "UID:u2"), etag: `"9"` });

  const q = await calendarEventQuery({ accountId: "1", filter: { uid: "u2" } }, ctx);
  expect(q.ids).toHaveLength(1);
  const [ev] = (await calendarEventGet({ accountId: "1", ids: q.ids }, ctx)).list;
  expect(ev!.uid).toBe("u2");
  expect((await calendarEventQuery({ accountId: "1", filter: { uid: "nope" } }, ctx)).ids).toEqual([]);

  await expect(calendarEventQuery({ accountId: "1", filter: { priority: 1 } as never }, ctx)).rejects.toMatchObject({ type: "unsupportedFilter" });
  await expect(calendarEventQuery({ accountId: "1", filter: { operator: "OR", conditions: [{ uid: "u1" }] } as never }, ctx)).rejects.toMatchObject({ type: "unsupportedFilter" });
});

it("creates, updates (incl. a single occurrence) and destroys events", async () => {
  const provider = { caldav: { host: "dav.example", port: 443, secure: true, username: "dav-user", password: "dav-pw", forUser: "mail" } } as ProviderConfig;
  const ctx: CalendarCtx = { account: { id: 1 } as AccountRow, provider, creds: { mech: "PLAIN", username: "mail", password: "x" } };
  const calId = (await calendarGet({ accountId: "1" }, ctx)).list[0]!.id;

  const created = await calendarEventSet({
    accountId: "1",
    create: {
      n1: {
        calendarIds: { [calId]: true }, uid: "standup@example.org", title: "Standup", start: "2026-10-05T09:00:00", timeZone: "Europe/Berlin", duration: "PT15M",
        recurrenceRule: { "@type": "RecurrenceRule", frequency: "weekly", byDay: [{ day: "mo" }] },
      },
    },
  }, ctx);
  const id = created.created!.n1!.id;
  const ics = store.get("/cal/u/work/" + created.created!.n1!.uid + ".ics")!.data;
  expect(ics).toContain("DTSTART;TZID=Europe/Berlin:20261005T090000");
  expect(ics).toContain("RRULE:FREQ=WEEKLY;BYDAY=MO");
  expect(ics).toMatch(/BEGIN:DAYLIGHT[\s\S]*RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU/);

  // Move one occurrence, then the whole series' title; both are patches on the base event.
  const upd = await calendarEventSet({ accountId: "1", update: {
    [id]: { "recurrenceOverrides/2026-10-12T09:00:00": { start: "2026-10-12T11:00:00" } },
  } }, ctx);
  expect(upd.updated).toEqual({ [id]: null });
  // The server may bump an override's SEQUENCE past the master's; the next
  // write must not take it back down.
  const href = "/cal/u/work/standup@example.org.ics";
  const stored = store.get(href)!;
  store.set(href, { ...stored, data: stored.data.replace(/(RECURRENCE-ID[\s\S]*?)SEQUENCE:1/, "$1SEQUENCE:5") });
  await calendarEventSet({ accountId: "1", update: { [id]: { title: "Daily" } } }, ctx);
  expect([...store.get(href)!.data.matchAll(/SEQUENCE:(\d+)/g)].map((m) => m[1])).toEqual(["6", "6"]);
  const [ev] = (await calendarEventGet({ accountId: "1", ids: [id] }, ctx)).list;
  expect(ev).toMatchObject({
    title: "Daily",
    sequence: 6,
    recurrenceOverrides: { "2026-10-12T09:00:00": { start: "2026-10-12T11:00:00" } },
  });

  // Bulwark's synthetic-id probe must not look like a supported id.
  const probe = await calendarEventSet({ accountId: "1", update: { h333333: {} } }, ctx);
  expect(probe.notUpdated!.h333333!.type).toBe("invalidProperties");

  const del = await calendarEventSet({ accountId: "1", destroy: [id] }, ctx);
  expect(del.destroyed).toEqual([id]);
  expect([...store.keys()]).toEqual(["/cal/u/work/1.ics"]);
});

it("parses uploaded .ics files and invitation parts, reporting unknown or event-less blobs", async () => {
  const uploads = new Map([
    ["Uics", Buffer.from(EVENT)],
    ["Utodo", Buffer.from("BEGIN:VCALENDAR\r\nBEGIN:VTODO\r\nUID:t\r\nEND:VTODO\r\nEND:VCALENDAR")],
  ]);
  const invite = encodeBlobId(encodeEmailId({ accountIdx: 1, mailboxIdx: 7, uidvalidity: 1, uid: 42 }), "2");
  const gone = encodeBlobId(encodeEmailId({ accountIdx: 1, mailboxIdx: 9, uidvalidity: 1, uid: 1 }), "2");
  const fakeStore = {
    getUpload: (id: string, accountId: number) => (accountId === 1 && uploads.has(id) ? { ctype: "text/calendar", body: uploads.get(id)! } : null),
    getCachedBlob: () => null,
    prep: () => ({ get: (mailboxIdx: number) => (mailboxIdx === 7 ? { id: 7, name: "INBOX" } : undefined) }),
  } as unknown as Store;
  const downloads: unknown[][] = [];
  const fakeClient = {
    getMailboxLock: async () => ({ release: () => {} }),
    download: async (...a: unknown[]) => {
      downloads.push(a);
      return { content: Readable.from([Buffer.from(EVENT)]) };
    },
  };
  const fakePool = { withConnection: (_a: unknown, _r: unknown, fn: (c: unknown) => unknown) => fn(fakeClient) } as unknown as ImapPool;
  const ctx = { account: { id: 1 } as AccountRow, store: fakeStore, pool: fakePool };

  const res = await calendarEventParse({ accountId: "1", blobIds: ["Uics", invite, "Utodo", "Umissing", gone, "garbage"] }, ctx);
  expect(res.parsed.Uics).toHaveLength(1);
  expect(res.parsed.Uics![0]).toMatchObject({ uid: "u1", title: "Lunch & talk", utcStart: "2026-10-07T12:00:00Z", duration: "PT1H" });
  expect(res.parsed[invite]![0]).toMatchObject({ uid: "u1" });
  expect(downloads).toEqual([["42", "2", { uid: true, maxBytes: 10 * 1024 * 1024 + 1 }]]);
  expect(res.notParsable).toEqual(["Utodo"]);
  expect(res.notFound).toEqual(["Umissing", gone, "garbage"]);
  await expect(calendarEventParse({ accountId: "2", blobIds: [] }, ctx)).rejects.toThrow();
});

it("evaluates a range and calendars sent as nested AND / OR", async () => {
  const provider = { caldav: { host: "dav.example", port: 443, secure: true, username: "dav-user", password: "dav-pw", forUser: "mail" } } as ProviderConfig;
  const ctx: CalendarCtx = { account: { id: 1 } as AccountRow, provider, creds: { mech: "PLAIN", username: "mail", password: "x" } };
  const work = (await calendarGet({ accountId: "1" }, ctx)).list[0]!.id;

  // What the webmail sends for "this range in these calendars": the bounds as
  // single-key conditions of an AND, the calendars as an OR inside it.
  const q = await calendarEventQuery(
    {
      accountId: "1",
      filter: {
        operator: "AND",
        conditions: [
          { after: "2026-10-01T00:00:00" },
          { before: "2026-11-01T00:00:00" },
          { operator: "OR", conditions: [{ inCalendar: work }, { inCalendar: "other" }] },
        ],
      },
    },
    ctx,
  );
  expect(q.total).toBe(1);
  expect(reports.at(-1)).toContain(`start="20261001T000000Z" end="20261101T000000Z"`);

  // Calendars that rule each other out leave nothing to ask the server.
  const none = await calendarEventQuery(
    { accountId: "1", filter: { operator: "AND", conditions: [{ inCalendar: work }, { inCalendar: "other" }] } },
    ctx,
  );
  expect(none.ids).toEqual([]);

  // The narrower of two bounds wins.
  await calendarEventQuery(
    { accountId: "1", filter: { operator: "AND", conditions: [{ after: "2026-09-01T00:00:00" }, { after: "2026-10-05T00:00:00", inCalendar: work }] } },
    ctx,
  );
  expect(reports.at(-1)).toContain(`start="20261005T000000Z"`);
});

it("refuses NOT and an OR over anything but calendars", async () => {
  const provider = { caldav: { host: "dav.example", port: 443, secure: true, username: "dav-user", password: "dav-pw", forUser: "mail" } } as ProviderConfig;
  const ctx: CalendarCtx = { account: { id: 1 } as AccountRow, provider, creds: { mech: "PLAIN", username: "mail", password: "x" } };
  for (const filter of [
    { operator: "NOT", conditions: [{ inCalendar: "x" }] },
    { operator: "OR", conditions: [{ after: "2026-10-01T00:00:00" }, { inCalendar: "x" }] },
    { operator: "AND", conditions: [{ operator: "OR", conditions: [{ uid: "a" }, { uid: "b" }] }] },
  ]) {
    await expect(calendarEventQuery({ accountId: "1", filter: filter as never }, ctx)).rejects.toMatchObject({ type: "unsupportedFilter" });
  }
});

it("finds events by text in title, description, location and people", async () => {
  const provider = { caldav: { host: "dav.example", port: 443, secure: true, username: "dav-user", password: "dav-pw", forUser: "mail" } } as ProviderConfig;
  const ctx: CalendarCtx = { account: { id: 1 } as AccountRow, provider, creds: { mech: "PLAIN", username: "mail", password: "x" } };
  store.set(
    "/cal/u/work/2.ics",
    {
      data: EVENT.replace("UID:u1", "UID:u2")
        .replace("SUMMARY:Lunch & talk", "SUMMARY:Steuerberater\r\nLOCATION:Kanzlei Nord\r\nATTENDEE;CN=Frau Weber:mailto:weber@kanzlei.example"),
      etag: `"9"`,
    },
  );
  const uidsFor = async (filter: object) => {
    const q = await calendarEventQuery({ accountId: "1", filter: filter as never }, ctx);
    const got = await calendarEventGet({ accountId: "1", ids: q.ids }, ctx);
    return got.list.map((e) => e.uid).sort();
  };

  expect(await uidsFor({ text: "lunch" })).toEqual(["u1"]);
  expect(await uidsFor({ text: "KANZLEI" })).toEqual(["u2"]);
  expect(await uidsFor({ text: "weber" })).toEqual(["u2"]);
  expect(await uidsFor({ title: "kanzlei" })).toEqual([]);
  expect(await uidsFor({ location: "nord" })).toEqual(["u2"]);
  expect(await uidsFor({ attendee: "weber@" })).toEqual(["u2"]);
  // Global search: bounds and several words as an AND of one-key conditions.
  expect(
    await uidsFor({
      operator: "AND",
      conditions: [{ after: "2026-10-01T00:00:00" }, { before: "2026-11-01T00:00:00" }, { text: "steuer" }, { text: "nord" }],
    }),
  ).toEqual(["u2"]);
  expect(await uidsFor({ operator: "AND", conditions: [{ text: "steuer" }, { text: "lunch" }] })).toEqual([]);

  await expect(
    calendarEventQuery({ accountId: "1", filter: { operator: "OR", conditions: [{ text: "a" }, { text: "b" }] } as never }, ctx),
  ).rejects.toMatchObject({ type: "unsupportedFilter" });
});

it("answers CalendarEvent/changes from the calendars' sync tokens", async () => {
  const provider = { caldav: { host: "dav.example", port: 443, secure: true, username: "dav-user", password: "dav-pw", forUser: "mail" } } as ProviderConfig;
  const ctx: CalendarCtx = { account: { id: 1 } as AccountRow, provider, creds: { mech: "PLAIN", username: "mail", password: "x" } };
  // Bulwark takes the state from CalendarEvent/get with no ids before listing.
  const first = await calendarEventGet({ accountId: "1", ids: [] }, ctx);
  const [existing] = (await calendarEventQuery({ accountId: "1" }, ctx)).ids;

  // Another device adds one event and deletes the one we have.
  store.set("/cal/u/work/2.ics", { data: EVENT.replace("UID:u1", "UID:u2"), etag: `"7"` });
  logChange("/cal/u/work/2.ics", false);
  store.delete("/cal/u/work/1.ics");
  logChange("/cal/u/work/1.ics", true);

  const ch = await calendarEventChanges({ accountId: "1", sinceState: first.state }, ctx);
  expect(ch.destroyed).toEqual([existing]);
  expect(ch.updated).toHaveLength(1);
  const [added] = (await calendarEventGet({ accountId: "1", ids: ch.updated }, ctx)).list;
  expect(added!.uid).toBe("u2");
  // RFC 6578 asks for Depth 0; the depth goes in sync-level.
  expect(reports.at(-2) ?? reports.at(-1)).toContain("<D:sync-level>1</D:sync-level>");

  // Caught up: nothing more, and the state is the one the other methods give.
  expect(await calendarEventChanges({ accountId: "1", sinceState: ch.newState }, ctx)).toMatchObject({ updated: [], destroyed: [] });
  expect((await calendarEventGet({ accountId: "1", ids: [] }, ctx)).state).toBe(ch.newState);

  // A token the server no longer knows, or a state from before sync tokens.
  await expect(calendarEventChanges({ accountId: "1", sinceState: "S" + Buffer.from(JSON.stringify([["/cal/u/work/", "s:bogus"]])).toString("base64url") }, ctx)).rejects.toMatchObject({ type: "cannotCalculateChanges" });
  await expect(calendarEventChanges({ accountId: "1", sinceState: "abc" }, ctx)).rejects.toMatchObject({ type: "cannotCalculateChanges" });
  // More changes than the client takes: it lists again.
  store.set("/cal/u/work/3.ics", { data: EVENT.replace("UID:u1", "UID:u3"), etag: `"8"` });
  logChange("/cal/u/work/3.ics", false);
  await expect(calendarEventChanges({ accountId: "1", sinceState: first.state, maxChanges: 1 }, ctx)).rejects.toMatchObject({ type: "cannotCalculateChanges" });
});

it("keeps CalendarEvent/changes working beside a calendar that has only a ctag", async () => {
  const provider = { caldav: { host: "dav.example", port: 443, secure: true, username: "dav-user", password: "dav-pw", forUser: "mail" } } as ProviderConfig;
  const ctx: CalendarCtx = { account: { id: 1 } as AccountRow, provider, creds: { mech: "PLAIN", username: "mail", password: "x" } };
  birthdaysCtag = "b1";
  const first = await calendarEventGet({ accountId: "1", ids: [] }, ctx);

  store.set("/cal/u/work/2.ics", { data: EVENT.replace("UID:u1", "UID:u2"), etag: `"7"` });
  logChange("/cal/u/work/2.ics", false);
  const ch = await calendarEventChanges({ accountId: "1", sinceState: first.state }, ctx);
  expect(ch.updated).toHaveLength(1);

  // The birthday calendar changed: no token to ask with, so list again.
  birthdaysCtag = "b2";
  await expect(calendarEventChanges({ accountId: "1", sinceState: ch.newState }, ctx)).rejects.toMatchObject({ type: "cannotCalculateChanges" });
});

it("reads the user's scheduling addresses, preferred first, mailto only", async () => {
  const provider = { caldav: { host: "dav.example", port: 443, secure: true, username: "dav-user", password: "dav-pw", forUser: "mail" } } as ProviderConfig;
  const ctx: CalendarCtx = { account: { id: 1 } as AccountRow, provider, creds: { mech: "PLAIN", username: "mail", password: "x" } };
  expect(await calendarUserAddresses(ctx)).toEqual(["mail@example.org", "alias@example.org"]);
});

it("creates, renames, recolours, reorders and deletes calendars", async () => {
  const provider = { caldav: { host: "dav.example", port: 443, secure: true, username: "dav-user", password: "dav-pw", forUser: "mail" } } as ProviderConfig;
  const ctx: CalendarCtx = { account: { id: 1 } as AccountRow, provider, creds: { mech: "PLAIN", username: "mail", password: "x" } };
  const made = await calendarSet({ accountId: "1", create: { n1: { name: "Proxy-Test", color: "#00aa00", description: "nur Test" } } }, ctx);
  const id = (made.created!.n1 as { id: string }).id;
  expect(made.newState).not.toBe(made.oldState);
  let cals = (await calendarGet({ accountId: "1" }, ctx)).list;
  expect(cals.find((c) => c.id === id)).toMatchObject({ name: "Proxy-Test", color: "#00aa00", description: "nur Test", isDefault: false });

  // Bulwark's settings form sends the whole calendar back with the change.
  const full = cals.find((c) => c.id === id)!;
  const { id: _i, myRights: _r, isDefault: _d, ...editable } = full;
  const upd = await calendarSet({ accountId: "1", update: { [id]: { ...editable, name: "Proxy-Test 2", color: "#0000ff", sortOrder: 5, description: null } } }, ctx);
  expect(upd.updated).toEqual({ [id]: null });
  cals = (await calendarGet({ accountId: "1" }, ctx)).list;
  expect(cals.find((c) => c.id === id)).toMatchObject({ name: "Proxy-Test 2", color: "#0000ff", sortOrder: 5, description: null });

  // What CalDAV can't keep is refused, not dropped.
  const hidden = await calendarSet({ accountId: "1", update: { [id]: { isVisible: false } } }, ctx);
  expect(hidden.notUpdated![id]).toMatchObject({ type: "invalidProperties", properties: ["isVisible"] });
  const noName = await calendarSet({ accountId: "1", create: { n2: { color: "#00aa00" } } }, ctx);
  expect(noName.notCreated!.n2).toMatchObject({ type: "invalidProperties" });

  // A calendar with events stays unless the client says to remove them.
  const work = cals.find((c) => c.name === "Work")!.id;
  const keep = await calendarSet({ accountId: "1", destroy: [work] }, ctx);
  expect(keep.notDestroyed![work]).toMatchObject({ type: "calendarHasEvent" });
  const gone = await calendarSet({ accountId: "1", destroy: [id, "nope"], onDestroyRemoveEvents: true }, ctx);
  expect(gone.destroyed).toEqual([id]);
  expect(gone.notDestroyed).toMatchObject({ nope: { type: "notFound" } });
  expect((await calendarGet({ accountId: "1" }, ctx)).list.map((c) => c.name)).toEqual(["Work"]);

  await expect(calendarSet({ accountId: "1", onSuccessSetIsDefault: "other" }, ctx)).rejects.toMatchObject({ type: "invalidArguments" });
});

it("reports what a server kept when it drops description and order", async () => {
  const provider = { caldav: { host: "dav.example", port: 443, secure: true, username: "dav-user", password: "dav-pw", forUser: "mail" } } as ProviderConfig;
  const ctx: CalendarCtx = { account: { id: 1 } as AccountRow, provider, creds: { mech: "PLAIN", username: "mail", password: "x" } };
  oxQuirks = true;
  const made = await calendarSet({ accountId: "1", create: { n: { name: "Proxy-Test", color: "#00AA00", description: "nur Test", sortOrder: 7 } } }, ctx);
  // Created anyway, and the client learns description and order didn't stick.
  expect(made.created!.n).toMatchObject({ description: null, sortOrder: 1 });
  expect(made.created!.n).not.toHaveProperty("color");
  const id = (made.created!.n as { id: string }).id;
  const upd = await calendarSet({ accountId: "1", update: { [id]: { name: "Neu", sortOrder: 3 } } }, ctx);
  expect(upd.updated![id]).toEqual({ sortOrder: 1 });
  expect((await calendarGet({ accountId: "1" }, ctx)).list[1]).toMatchObject({ name: "Neu" });
});

it("keeps the calendar server's answer out of a refused PROPPATCH's error", async () => {
  const provider = { caldav: { host: "dav.example", port: 443, secure: true, username: "dav-user", password: "dav-pw", forUser: "mail" } } as ProviderConfig;
  const ctx: CalendarCtx = { account: { id: 1 } as AccountRow, provider, creds: { mech: "PLAIN", username: "mail", password: "x" } };
  const inner = globalThis.fetch;
  vi.stubGlobal("fetch", (url: string, init: RequestInit) =>
    init.method === "PROPPATCH"
      ? ms(`<D:response><D:href>/cal/u/work/</D:href><D:propstat><D:status>HTTP/1.1 403 secret-store refused</D:status><D:prop/></D:propstat></D:response>`)
      : inner(url, init),
  );
  const [cal] = (await calendarGet({ accountId: "1" }, ctx)).list;
  const res = await calendarSet({ accountId: "1", update: { [cal!.id]: { name: "Renamed" } } }, ctx);
  expect(res.notUpdated![cal!.id]).toMatchObject({ type: "invalidProperties" });
  expect(JSON.stringify(res.notUpdated)).not.toContain("secret-store");
});

// -- Review fixes -----------------------------------------------------------------

function plainCtx(): CalendarCtx {
  const provider = { caldav: { host: "dav.example", port: 443, secure: true, username: "dav-user", password: "dav-pw", forUser: "mail" } } as ProviderConfig;
  return { account: { id: 1 } as AccountRow, provider, creds: { mech: "PLAIN", username: "mail", password: "x" } };
}

it("notices a change on a server without sync-token or getctag", async () => {
  plainServer = true;
  const ctx = plainCtx();
  const before = (await calendarEventGet({ accountId: "1", ids: [] }, ctx)).state;
  store.set("/cal/u/work/2.ics", { data: EVENT.replace("UID:u1", "UID:u2"), etag: `"77"` });
  resetCalDavCaches();
  const after = (await calendarEventGet({ accountId: "1", ids: [] }, ctx)).state;
  expect(after).not.toBe(before);
  // The etag digest says that something moved, not what: the client lists again.
  await expect(calendarEventChanges({ accountId: "1", sinceState: before }, ctx)).rejects.toMatchObject({ type: "cannotCalculateChanges" });
  expect((await calendarEventChanges({ accountId: "1", sinceState: after }, ctx)).updated).toEqual([]);
});

it("reads a status line without a reason phrase: a 507 cut-off makes the client list again", async () => {
  bareStatus = true;
  const ctx = plainCtx();
  const q = await calendarEventQuery({ accountId: "1" }, ctx);
  const since = (await calendarEventGet({ accountId: "1", ids: q.ids }, ctx)).state;
  store.delete("/cal/u/work/1.ics");
  logChange("/cal/u/work/1.ics", true);
  await expect(calendarEventChanges({ accountId: "1", sinceState: since }, ctx)).rejects.toMatchObject({ type: "cannotCalculateChanges" });
});

it("destroys only events: not the calendar, and not what isn't there", async () => {
  const ctx = plainCtx();
  const [id] = (await calendarEventQuery({ accountId: "1" }, ctx)).ids;
  const enc = (s: string) => Buffer.from(s, "utf8").toString("base64url");
  const calItself = enc("/cal/u/work/\n/cal/u/work/");
  const elsewhere = enc("/cal/u/work/\n/cal/u/other/1.ics");
  const missing = enc("/cal/u/work/\n/cal/u/work/nope.ics");
  const res = await calendarEventSet({ accountId: "1", destroy: [calItself, elsewhere, missing, id!] }, ctx);
  expect(res.destroyed).toEqual([id]);
  expect(Object.keys(res.notDestroyed!).sort()).toEqual([calItself, elsewhere, missing].sort());
  for (const e of Object.values(res.notDestroyed!)) expect(e.type).toBe("notFound");
  expect(collections.has("/cal/u/work/")).toBe(true);
});

it("refuses event ids whose href is the calendar or its parent through a dot segment", async () => {
  const ctx = plainCtx();
  store.set("/cal/u/work/x", { data: EVENT, etag: `"7"` });
  const enc = (s: string) => Buffer.from(s, "utf8").toString("base64url");
  const sent: string[] = [];
  const inner = globalThis.fetch;
  vi.stubGlobal("fetch", (url: string, init: RequestInit) => {
    if (init.method === "DELETE" || init.method === "PUT") sent.push(`${init.method} ${new URL(url).pathname}`);
    return inner(url, init);
  });
  const ids = ["/cal/u/work/.", "/cal/u/work/%2e", "/cal/u/work/..", "/cal/u/work/%2E%2E", "/cal/u/work/%252e%252e"].map((h) => enc(`/cal/u/work/\n${h}`));
  const res = await calendarEventSet({ accountId: "1", destroy: ids, update: { [ids[0]!]: { title: "x" } } }, ctx);
  expect(res.destroyed).toBeNull();
  for (const id of ids) expect(res.notDestroyed![id]).toMatchObject({ type: "notFound" });
  expect(res.notUpdated![ids[0]!]).toMatchObject({ type: "notFound" });
  expect(sent).toEqual([]);
  expect(collections.has("/cal/u/work/")).toBe(true);
  expect((await calendarEventGet({ accountId: "1", ids: [ids[2]!] }, ctx)).notFound).toEqual([ids[2]]);
});

it("refuses a move between calendars given as a patch path", async () => {
  const ctx = plainCtx();
  const [id] = (await calendarEventQuery({ accountId: "1" }, ctx)).ids;
  const res = await calendarEventSet({ accountId: "1", update: { [id!]: { "calendarIds/other": true } } }, ctx);
  expect(res.notUpdated![id!]).toMatchObject({ type: "invalidProperties", properties: ["calendarIds"] });
});

it("updates an event the server listed without an etag", async () => {
  noEtags = true;
  const ctx = plainCtx();
  const [id] = (await calendarEventQuery({ accountId: "1" }, ctx)).ids;
  const res = await calendarEventSet({ accountId: "1", update: { [id!]: { title: "Renamed" } } }, ctx);
  expect(res.updated).toEqual({ [id!]: null });
  expect(store.get("/cal/u/work/1.ics")!.data).toContain("SUMMARY:Renamed");
});

it("leaves SEQUENCE alone for a reply and raises it for a change", async () => {
  const ctx = plainCtx();
  store.set("/cal/u/work/1.ics", {
    data: EVENT.replace("SUMMARY:", "SEQUENCE:3\r\nORGANIZER:mailto:boss@example.org\r\nATTENDEE;PARTSTAT=NEEDS-ACTION:mailto:mail@example.org\r\nSUMMARY:"),
    etag: `"1"`,
  });
  const [id] = (await calendarEventQuery({ accountId: "1" }, ctx)).ids;
  const [ev] = (await calendarEventGet({ accountId: "1", ids: [id!] }, ctx)).list;
  const me = Object.entries(ev!.participants as Record<string, { email: string }>).find(([, p]) => p.email === "mail@example.org")![0];
  await calendarEventSet({ accountId: "1", update: { [id!]: { [`participants/${me}/participationStatus`]: "accepted" } } }, ctx);
  let data = store.get("/cal/u/work/1.ics")!.data;
  expect(data).toMatch(/PARTSTAT=ACCEPTED/);
  expect(data).toMatch(/^SEQUENCE:3$/m);
  await calendarEventSet({ accountId: "1", update: { [id!]: { title: "Moved" } } }, ctx);
  data = store.get("/cal/u/work/1.ics")!.data;
  expect(data).toMatch(/^SEQUENCE:4$/m);
});

// -- Review fixes, second round ---------------------------------------------------

it("finds the etag digest when the calendar names itself differently", async () => {
  plainServer = true;
  oddSelfHref = true;
  const ctx = plainCtx();
  const a = (await calendarEventGet({ accountId: "1", ids: [] }, ctx)).state;
  resetCalDavCaches();
  const b = (await calendarEventGet({ accountId: "1", ids: [] }, ctx)).state;
  // A digest, not a state minted fresh on every read.
  expect(a).toBe(b);
  expect(a.startsWith("S")).toBe(true);
});

it("matches event hrefs against their calendar however the server writes them", () => {
  expect(isMember({ calHref: "/cal/u/work/", href: "https://dav.example/cal/u/work/1.ics" })).toBe(true);
  expect(isMember({ calHref: "/cal/u/my%20work/", href: "/cal/u/my work/1.ics" })).toBe(true);
  expect(isMember({ calHref: "/cal/u/work", href: "/cal/u/work/1.ics" })).toBe(true);
  expect(isMember({ calHref: "/cal/u/work/", href: "/cal/u/work/" })).toBe(false);
  expect(isMember({ calHref: "/cal/u/work/", href: "/cal/u/work/sub/1.ics" })).toBe(false);
  expect(isMember({ calHref: "/cal/u/work/", href: "/cal/u/workshop/1.ics" })).toBe(false);
});

it("treats every way of answering an invitation as a reply, and leaves each VEVENT's SEQUENCE", async () => {
  const ctx = plainCtx();
  const series = [
    "BEGIN:VCALENDAR", "VERSION:2.0",
    "BEGIN:VEVENT", "UID:s1", "DTSTART:20261005T100000Z", "DTEND:20261005T110000Z", "RRULE:FREQ=WEEKLY", "SUMMARY:S", "SEQUENCE:0",
    "ORGANIZER:mailto:boss@example.org", "ATTENDEE;PARTSTAT=NEEDS-ACTION:mailto:mail@example.org", "END:VEVENT",
    "BEGIN:VEVENT", "UID:s1", "RECURRENCE-ID:20261012T100000Z", "DTSTART:20261012T120000Z", "DTEND:20261012T130000Z", "SUMMARY:S", "SEQUENCE:2",
    "ORGANIZER:mailto:boss@example.org", "ATTENDEE;PARTSTAT=NEEDS-ACTION:mailto:mail@example.org", "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n");
  store.set("/cal/u/work/1.ics", { data: series, etag: `"1"` });
  const [id] = (await calendarEventQuery({ accountId: "1" }, ctx)).ids;
  const seqs = () => [...store.get("/cal/u/work/1.ics")!.data.matchAll(/^SEQUENCE:(\d+)$/gm)].map((m) => m[1]);

  // A whole participants object that differs only in the answer.
  const [ev] = (await calendarEventGet({ accountId: "1", ids: [id!] }, ctx)).list;
  const parts = structuredClone(ev!.participants) as Record<string, Record<string, unknown>>;
  for (const p of Object.values(parts)) if (p.email === "mail@example.org") p.participationStatus = "accepted";
  await calendarEventSet({ accountId: "1", update: { [id!]: { participants: parts } } }, ctx);
  expect(seqs()).toEqual(["0", "2"]);

  // One occurrence's answer, through its override.
  const [again] = (await calendarEventGet({ accountId: "1", ids: [id!] }, ctx)).list;
  const key = Object.keys(again!.recurrenceOverrides as object)[0]!;
  const o = structuredClone((again!.recurrenceOverrides as Record<string, Record<string, unknown>>)[key]!);
  // The override answers like the series until it has an answer of its own.
  o.participants ??= structuredClone(again!.participants);
  for (const p of Object.values(o.participants as Record<string, Record<string, unknown>>)) if (p.email === "mail@example.org") p.participationStatus = "declined";
  await calendarEventSet({ accountId: "1", update: { [id!]: { [`recurrenceOverrides/${key}`]: o } } }, ctx);
  expect(seqs()).toEqual(["0", "2"]);
  expect(store.get("/cal/u/work/1.ics")!.data).toMatch(/PARTSTAT=DECLINED/);

  // A real change raises all of them past the highest.
  await calendarEventSet({ accountId: "1", update: { [id!]: { title: "S2" } } }, ctx);
  expect(seqs()).toEqual(["3", "3"]);
});

it("keeps an imported event's SEQUENCE and CREATED", async () => {
  const ctx = plainCtx();
  const [cal] = (await calendarGet({ accountId: "1" }, ctx)).list;
  const res = await calendarEventSet({ accountId: "1", create: { n: {
    calendarIds: { [cal!.id]: true }, uid: "imp-1", title: "Imported", start: "2026-10-05T10:00:00", timeZone: "Etc/UTC", duration: "PT1H",
    sequence: 3, created: "2026-01-02T03:04:05Z",
  } } }, ctx);
  expect(res.created).toBeTruthy();
  const data = store.get("/cal/u/work/imp-1.ics")!.data;
  expect(data).toMatch(/^SEQUENCE:3$/m);
  expect(data).toMatch(/^CREATED:20260102T030405Z$/m);
});
