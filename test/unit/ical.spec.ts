import { describe, expect, it } from "vitest";
import { eventToIcal, icalToEvent, icalToEvents, localToUtc, utcToLocal } from "../../src/caldav/ical.js";

const series = [
  "BEGIN:VCALENDAR",
  "VERSION:2.0",
  "BEGIN:VTIMEZONE",
  "TZID:Europe/Berlin",
  "END:VTIMEZONE",
  "BEGIN:VEVENT",
  "UID:abc-123",
  "DTSTAMP:20261001T080000Z",
  "DTSTART;TZID=Europe/Berlin:20261005T100000",
  "DTEND;TZID=Europe/Berlin:20261005T113000",
  "SUMMARY:Team\\, weekly",
  "LOCATION:Raum 1",
  "RRULE:FREQ=WEEKLY;INTERVAL=1;BYDAY=MO;UNTIL=20261130T090000Z",
  "EXDATE:20261012T080000Z",
  "ORGANIZER;CN=Jane Doe:mailto:user@example.org",
  "ATTENDEE;PARTSTAT=ACCEPTED:mailto:bob@example.org",
  "BEGIN:VALARM",
  "ACTION:DISPLAY",
  "TRIGGER:-PT15M",
  "END:VALARM",
  "END:VEVENT",
  "BEGIN:VEVENT",
  "UID:abc-123",
  "RECURRENCE-ID;TZID=Europe/Berlin:20261019T100000",
  "DTSTART;TZID=Europe/Berlin:20261019T140000",
  "DTEND;TZID=Europe/Berlin:20261019T153000",
  "SUMMARY:Team\\, weekly",
  "LOCATION:Raum 1",
  "END:VEVENT",
  "END:VCALENDAR",
].join("\r\n");

describe("icalToEvent", () => {
  it("maps a recurring zoned event with exclusions, overrides and alerts", () => {
    const ev = icalToEvent(series, "e1", "c1")!;
    expect(ev).toMatchObject({
      id: "e1",
      "@type": "Event",
      uid: "abc-123",
      calendarIds: { c1: true },
      title: "Team, weekly",
      start: "2026-10-05T10:00:00",
      timeZone: "Europe/Berlin",
      duration: "PT1H30M",
      showWithoutTime: false,
      utcStart: "2026-10-05T08:00:00Z",
      utcEnd: "2026-10-05T09:30:00Z",
      locations: { "1": { name: "Raum 1" } },
      recurrenceRule: {
        frequency: "weekly",
        interval: 1,
        byDay: [{ day: "mo" }],
        until: "2026-11-30T10:00:00",
      },
      recurrenceOverrides: {
        "2026-10-12T10:00:00": { excluded: true },
        "2026-10-19T10:00:00": { start: "2026-10-19T14:00:00", utcStart: "2026-10-19T12:00:00Z", utcEnd: "2026-10-19T13:30:00Z" },
      },
      alerts: { a1: { trigger: { "@type": "OffsetTrigger", offset: "-PT15M", relativeTo: "start" } } },
    });
    const parts = Object.values(ev.participants as Record<string, { email: string; roles: object }>);
    expect(parts.map((p) => p.email)).toEqual(["user@example.org", "bob@example.org"]);
    // Override only carries what changed, plus its own UTC times once it moved.
    // It has no ATTENDEE and no VALARM of its own, so it has neither.
    expect((ev.recurrenceOverrides as Record<string, object>)["2026-10-19T10:00:00"]).toEqual({
      start: "2026-10-19T14:00:00", participants: null, alerts: null,
      utcStart: "2026-10-19T12:00:00Z", utcEnd: "2026-10-19T13:30:00Z",
    });
  });

  it("maps an all-day event and skips VTODO-only resources", () => {
    const allDay = "BEGIN:VCALENDAR\nBEGIN:VEVENT\nUID:x\nDTSTART;VALUE=DATE:20261224\nDTEND;VALUE=DATE:20261227\nSUMMARY:Xmas\nEND:VEVENT\nEND:VCALENDAR";
    expect(icalToEvent(allDay, "e", "c")).toMatchObject({
      start: "2026-12-24T00:00:00",
      showWithoutTime: true,
      timeZone: null,
      duration: "P3D",
    });
    expect(icalToEvent("BEGIN:VCALENDAR\nBEGIN:VTODO\nUID:t\nEND:VTODO\nEND:VCALENDAR", "t", "c")).toBeNull();
  });

  it("resolves Outlook's Windows zone names and keeps the zone when writing back", () => {
    const outlook = [
      "BEGIN:VCALENDAR", "METHOD:REQUEST", "BEGIN:VTIMEZONE", "TZID:W. Europe Standard Time", "END:VTIMEZONE",
      "BEGIN:VEVENT", "UID:o", "DTSTART;TZID=W. Europe Standard Time:20261030T110000",
      "DTEND;TZID=W. Europe Standard Time:20261030T120000", "END:VEVENT", "END:VCALENDAR",
    ].join("\r\n");
    const ev = icalToEvent(outlook, "e", "c")!;
    expect(ev).toMatchObject({ start: "2026-10-30T11:00:00", timeZone: "Europe/Berlin", utcStart: "2026-10-30T10:00:00Z", duration: "PT1H" });
    expect(eventToIcal(ev, outlook)).toMatch(/^DTSTART;TZID=Europe\/Berlin:20261030T110000\r?$/m);
  });

  it("reads a TZID with a vendor prefix as its IANA zone and keeps it when writing back", () => {
    const tb = [
      "BEGIN:VCALENDAR", "BEGIN:VTIMEZONE", "TZID:/mozilla.org/20050126_1/Europe/Berlin", "END:VTIMEZONE",
      "BEGIN:VEVENT", "UID:t", "DTSTART;TZID=/mozilla.org/20050126_1/Europe/Berlin:20261030T110000",
      "DTEND;TZID=/mozilla.org/20050126_1/Europe/Berlin:20261030T120000", "END:VEVENT", "END:VCALENDAR",
    ].join("\r\n");
    const ev = icalToEvent(tb, "e", "c")!;
    expect(ev).toMatchObject({ start: "2026-10-30T11:00:00", timeZone: "Europe/Berlin", utcStart: "2026-10-30T10:00:00Z" });
    const out = eventToIcal(ev, tb);
    expect(out).toMatch(/^DTSTART;TZID=Europe\/Berlin:20261030T110000\r?$/m);
    expect(out).toMatch(/^TZID:Europe\/Berlin\r?$/m);
    expect(icalToEvent("BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:x\r\nDTSTART;TZID=/vendor/Nowhere/Atlantis:20261030T110000\r\nEND:VEVENT\r\nEND:VCALENDAR", "e", "c")!.timeZone).toBeNull();
  });

  it("leaves floating time without a UTC instant", () => {
    const floating = "BEGIN:VCALENDAR\nBEGIN:VEVENT\nUID:f\nDTSTART:20261028T110000\nDTEND:20261028T120000\nEND:VEVENT\nEND:VCALENDAR";
    expect(icalToEvent(floating, "e", "c")).toMatchObject({
      start: "2026-10-28T11:00:00",
      timeZone: null,
      duration: "PT1H",
      utcStart: null,
      utcEnd: null,
    });
  });
});

describe("icalToEvents", () => {
  it("returns one event per UID, keeping a series and its overrides together", () => {
    const other = "BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:xyz\r\nDTSTART;VALUE=DATE:20261224\r\nSUMMARY:Heiligabend\r\nEND:VEVENT\r\nEND:VCALENDAR";
    const evs = icalToEvents(`${series}\r\n${other}`);
    expect(evs.map((e) => e.uid)).toEqual(["abc-123", "xyz"]);
    expect(evs[0]).toMatchObject({ id: null, calendarIds: null, title: "Team, weekly" });
    expect(Object.keys(evs[0]!.recurrenceOverrides as object)).toHaveLength(2);
    expect(evs[1]).toMatchObject({ title: "Heiligabend", showWithoutTime: true });
  });

  it("returns nothing for a file without events", () => {
    expect(icalToEvents("BEGIN:VCALENDAR\r\nBEGIN:VTODO\r\nUID:t\r\nEND:VTODO\r\nEND:VCALENDAR")).toEqual([]);
    expect(icalToEvents("not a calendar")).toEqual([]);
  });
});

describe("time zone helpers", () => {
  it("round-trips across a DST switch", () => {
    // 2026-10-25 03:00 CEST -> 02:00 CET in Europe/Berlin.
    const t = localToUtc("2026-10-25T12:00:00", "Europe/Berlin");
    expect(new Date(t).toISOString()).toBe("2026-10-25T11:00:00.000Z");
    expect(utcToLocal(Date.parse("2026-07-01T08:00:00Z"), "Europe/Berlin")).toBe("2026-07-01T10:00:00");
  });
});

describe("eventToIcal", () => {
  it("round-trips an event and keeps what it doesn't model", () => {
    const withExtras = series.replace("SUMMARY:Team\\, weekly\r\n", "SUMMARY:Team\\, weekly\r\nX-OX-REMINDER:keep;me\r\n");
    const ev = icalToEvent(withExtras, "e1", "c1")!;
    const out = eventToIcal(ev, withExtras);
    expect(out).toContain("X-OX-REMINDER:keep;me");
    expect(out.match(/BEGIN:VTIMEZONE/g)).toHaveLength(1);
    const again = icalToEvent(out, "e1", "c1")!;
    for (const k of ["title", "start", "timeZone", "duration", "recurrenceRule", "recurrenceOverrides", "locations", "alerts"]) {
      expect(again[k], k).toEqual(ev[k]);
    }
  });

  it("keeps a meeting link and keywords through a create and an edit", () => {
    const created = eventToIcal({
      "@type": "Event", uid: "m1", title: "Sync", start: "2026-10-07T10:00:00", timeZone: "Europe/Berlin", duration: "PT30M",
      virtualLocations: { vl1: { "@type": "VirtualLocation", name: null, description: null, uri: "https://meet.example/abc", features: null } },
      keywords: { "bulwark-out-of-office": true },
    });
    expect(created).toMatch(/^CONFERENCE;VALUE=URI:https:\/\/meet\.example\/abc$/m);
    const ev = icalToEvent(created, "e", "c")!;
    expect(ev.virtualLocations).toEqual({ v1: { "@type": "VirtualLocation", name: null, uri: "https://meet.example/abc", features: null } });
    expect(ev.keywords).toEqual({ "bulwark-out-of-office": true });
    // An edit of something else writes both back once.
    const edited = eventToIcal({ ...ev, title: "Sync 2" }, created);
    expect(edited.match(/^CONFERENCE/gm)).toHaveLength(1);
    expect(edited.match(/^CATEGORIES/gm)).toHaveLength(1);
    expect(icalToEvent(edited, "e", "c")).toMatchObject({ virtualLocations: ev.virtualLocations, keywords: ev.keywords });
  });

  it("reads CONFERENCE labels and features and every CATEGORIES line", () => {
    const ics = "BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:c1\r\nDTSTART:20261007T120000Z\r\n" +
      "CONFERENCE;VALUE=URI;FEATURE=PHONE,MODERATOR;LABEL=\"Dial-in, moderator\":tel:+49-30-123\r\n" +
      "CATEGORIES:Work,Kunde\\, A\r\nCATEGORIES:Travel\r\nEND:VEVENT\r\nEND:VCALENDAR";
    const ev = icalToEvent(ics, "e", "c")!;
    expect(ev.virtualLocations).toEqual({ v1: { "@type": "VirtualLocation", name: "Dial-in, moderator", uri: "tel:+49-30-123", features: { phone: true, moderator: true } } });
    expect(ev.keywords).toEqual({ Work: true, "Kunde, A": true, Travel: true });
    const out = eventToIcal(ev, ics);
    expect(out.replace(/\r\n[ \t]/g, "")).toContain(`CONFERENCE;VALUE=URI;FEATURE=PHONE,MODERATOR;LABEL="Dial-in, moderator":tel:+49-30-123`);
    expect(icalToEvent(out, "e", "c")!.keywords).toEqual(ev.keywords);
  });

  it("keeps a line break in an invitation's UID inside the UID", () => {
    const invite = "BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:abc\\nATTENDEE:mailto:evil@example.org\r\nDTSTART:20261007T120000Z\r\nSUMMARY:Hi\r\nEND:VEVENT\r\nEND:VCALENDAR";
    const [ev] = icalToEvents(invite);
    const out = eventToIcal(ev!);
    expect(out).not.toMatch(/^ATTENDEE/m);
    expect(icalToEvent(out, "e", "c")!.uid).toBe(ev!.uid);
  });

  it("copies the stored VTIMEZONEs in linear time, also from a body full of unclosed ones", () => {
    const ev = icalToEvent(series, "e1", "c1")!;
    const hostile = series.replace("END:VCALENDAR", "BEGIN:VTIMEZONE\r\n".repeat(40_000) + "END:VCALENDAR");
    const t = Date.now();
    eventToIcal(ev, hostile);
    expect(Date.now() - t).toBeLessThan(2_000);
  });
});

describe("RDATE", () => {
  const withRdates = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "BEGIN:VEVENT",
    "UID:rd-1",
    "DTSTAMP:20261001T080000Z",
    "DTSTART;TZID=Europe/Berlin:20261005T100000",
    "DTEND;TZID=Europe/Berlin:20261005T110000",
    "RRULE:FREQ=WEEKLY;COUNT=3",
    "RDATE;TZID=Europe/Berlin:20261008T140000,20261009T090000",
    "RDATE;VALUE=PERIOD:20261010T080000Z/20261010T100000Z",
    "SUMMARY:Kurs",
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n");

  it("reads added occurrences as overrides with empty patches", () => {
    const ev = icalToEvent(withRdates, "e", "c")!;
    expect(ev.recurrenceOverrides).toEqual({
      "2026-10-08T14:00:00": {},
      "2026-10-09T09:00:00": {},
      // 08:00 UTC is 10:00 in Berlin.
      "2026-10-10T10:00:00": {},
    });
  });

  it("keeps them when the event is saved again", () => {
    const ev = icalToEvent(withRdates, "e", "c")!;
    ev.title = "Kurs (neu)";
    const again = icalToEvent(eventToIcal(ev, withRdates), "e", "c")!;
    expect(again.title).toBe("Kurs (neu)");
    expect(again.recurrenceOverrides).toEqual(ev.recurrenceOverrides);
  });

  it("writes an occurrence a client adds as RDATE, not as a RECURRENCE-ID copy", () => {
    const ev = icalToEvent(withRdates, "e", "c")!;
    (ev.recurrenceOverrides as Record<string, object>)["2026-10-20T10:00:00"] = {};
    const out = eventToIcal(ev, withRdates);
    expect(out).toContain("RDATE;TZID=Europe/Berlin:20261020T100000");
    expect(out).not.toContain("RECURRENCE-ID");
  });

  it("keeps the RDATE of an added occurrence that was then changed", () => {
    const ev = icalToEvent(withRdates, "e", "c")!;
    (ev.recurrenceOverrides as Record<string, object>)["2026-10-08T14:00:00"] = { title: "Sondertermin" };
    const out = eventToIcal(ev, withRdates);
    expect(out).toContain("RDATE;TZID=Europe/Berlin:20261008T140000");
    expect(out).toContain("RECURRENCE-ID;TZID=Europe/Berlin:20261008T140000");
    const again = icalToEvent(out, "e", "c")!;
    expect((again.recurrenceOverrides as Record<string, Record<string, unknown>>)["2026-10-08T14:00:00"]!.title).toBe("Sondertermin");
  });

  it("lets EXDATE remove an added occurrence", () => {
    const ics = withRdates.replace("SUMMARY:Kurs", "EXDATE;TZID=Europe/Berlin:20261009T090000\r\nSUMMARY:Kurs");
    const ev = icalToEvent(ics, "e", "c")!;
    expect((ev.recurrenceOverrides as Record<string, object>)["2026-10-09T09:00:00"]).toEqual({ excluded: true });
    const out = eventToIcal(ev, ics);
    expect(out.match(/^RDATE.*20261009T090000/m)).toBeNull();
  });
});

describe("participant details", () => {
  const invite = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "BEGIN:VEVENT",
    "UID:inv-1",
    "DTSTAMP:20261001T080000Z",
    "DTSTART:20261007T120000Z",
    "DTEND:20261007T130000Z",
    "SUMMARY:Planung",
    "ORGANIZER;CN=Chefin;SENT-BY=\"mailto:assist@example.org\":mailto:boss@example.org",
    "ATTENDEE;CN=Jane Doe;ROLE=REQ-PARTICIPANT;RSVP=TRUE;CUTYPE=INDIVIDUAL;PARTSTAT=NEEDS-ACTION;X-NUM-GUESTS=0:mailto:user@example.org",
    "ATTENDEE;CN=Bob;ROLE=OPT-PARTICIPANT;DELEGATED-TO=\"mailto:eve@example.org\";PARTSTAT=DELEGATED;SCHEDULE-STATUS=1.2:mailto:bob@example.org",
    "ATTENDEE;CN=Raum 3;CUTYPE=ROOM;ROLE=NON-PARTICIPANT;PARTSTAT=ACCEPTED:mailto:room3@example.org",
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n");
  const byEmail = (ev: Record<string, unknown>) =>
    Object.fromEntries(Object.values(ev.participants as Record<string, Record<string, unknown>>).map((p) => [p.email, p]));

  it("reads role, reply request, kind and sender", () => {
    const p = byEmail(icalToEvent(invite, "e", "c")!);
    expect(p["boss@example.org"]).toMatchObject({ roles: { owner: true }, sentBy: "assist@example.org" });
    expect(p["user@example.org"]).toMatchObject({ roles: { attendee: true }, expectReply: true, kind: "individual" });
    expect(p["bob@example.org"]).toMatchObject({ roles: { attendee: true, optional: true }, participationStatus: "delegated" });
    expect(p["room3@example.org"]).toMatchObject({ roles: { informational: true }, kind: "location" });
  });

  it("keeps them, and parameters it doesn't model, when the reply is saved", () => {
    const ev = icalToEvent(invite, "e", "c")!;
    const me = Object.values(ev.participants as Record<string, Record<string, unknown>>).find((p) => p.email === "user@example.org")!;
    me.participationStatus = "accepted";
    const out = eventToIcal(ev, invite).replace(/\r\n /g, "");
    expect(out).toContain("ORGANIZER;CN=Chefin;SENT-BY=\"mailto:assist@example.org\":mailto:boss@example.org");
    expect(out).toMatch(/^ATTENDEE;CN=Jane Doe;X-NUM-GUESTS=0;CUTYPE=INDIVIDUAL;RSVP=TRUE;PARTSTAT=ACCEPTED:mailto:user@example.org$/m);
    expect(out).toMatch(/^ATTENDEE;CN=Bob;DELEGATED-TO="mailto:eve@example.org";ROLE=OPT-PARTICIPANT;PARTSTAT=DELEGATED:mailto:bob@example.org$/m);
    expect(out).toMatch(/^ATTENDEE;CN=Raum 3;CUTYPE=ROOM;ROLE=NON-PARTICIPANT;PARTSTAT=ACCEPTED:mailto:room3@example.org$/m);
    // The server's own scheduling result is not sent back.
    expect(out).not.toContain("SCHEDULE-STATUS");
    expect(byEmail(icalToEvent(out, "e", "c")!)).toEqual(byEmail(ev));
  });
});

describe("overrides that differ only in what the master also has", () => {
  const accepted = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "BEGIN:VEVENT",
    "UID:weekly-1",
    "DTSTART;TZID=Europe/Berlin:20261005T100000",
    "DTEND;TZID=Europe/Berlin:20261005T110000",
    "RRULE:FREQ=WEEKLY",
    "SUMMARY:Weekly",
    "SEQUENCE:2",
    "ORGANIZER:mailto:boss@example.org",
    "ATTENDEE;PARTSTAT=NEEDS-ACTION:mailto:user@example.org",
    "END:VEVENT",
    "BEGIN:VEVENT",
    "UID:weekly-1",
    "RECURRENCE-ID;TZID=Europe/Berlin:20261012T100000",
    "DTSTART;TZID=Europe/Berlin:20261012T100000",
    "DTEND;TZID=Europe/Berlin:20261012T110000",
    "SUMMARY:Weekly",
    "SEQUENCE:4",
    "X-OWN:kept",
    "ORGANIZER:mailto:boss@example.org",
    "ATTENDEE;PARTSTAT=ACCEPTED;X-CLIENT=phone:mailto:user@example.org",
    "BEGIN:VALARM",
    "ACTION:DISPLAY",
    "TRIGGER:-PT5M",
    "END:VALARM",
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n");

  it("keeps an occurrence's own answer, alarm and properties when the series is edited", () => {
    const ev = icalToEvent(accepted, "e1", "c1")!;
    const o = (ev.recurrenceOverrides as Record<string, Record<string, unknown>>)["2026-10-12T10:00:00"]!;
    expect(Object.keys(o).sort()).toEqual(["alerts", "participants"]);

    ev.title = "Weekly sync";
    ev.sequence = 5;
    const out = eventToIcal(ev, accepted);
    expect(out.match(/^RECURRENCE-ID;TZID=Europe\/Berlin:20261012T100000$/m)).toBeTruthy();
    expect(out).not.toMatch(/^RDATE/m);
    const override = out.slice(out.lastIndexOf("BEGIN:VEVENT"));
    expect(override).toMatch(/^ATTENDEE;.*PARTSTAT=ACCEPTED.*:mailto:user@example.org$/m);
    expect(override).toMatch(/X-CLIENT=phone/);
    expect(override).toMatch(/^X-OWN:kept$/m);
    expect(override).toMatch(/^TRIGGER:-PT5M$/m);
    expect(override).toMatch(/^SUMMARY:Weekly sync$/m);
    expect(override).toMatch(/^SEQUENCE:5$/m);
  });
});

describe("generated VTIMEZONE", () => {
  it("places a transition that isn't on a UTC hour at the right minute", () => {
    const out = eventToIcal({ uid: "nf", title: "x", start: "2026-07-01T09:00:00", timeZone: "America/St_Johns", duration: "PT1H" } as never);
    expect(out).toMatch(/BEGIN:DAYLIGHT\r\nDTSTART:20260308T020000\r\nTZOFFSETFROM:-0330\r\nTZOFFSETTO:-0230/);
    expect(out).toMatch(/BEGIN:STANDARD\r\nDTSTART:20261101T020000\r\nTZOFFSETFROM:-0230\r\nTZOFFSETTO:-0330/);
  });
});

describe("review round two", () => {
  const instanceOnly = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "BEGIN:VEVENT",
    "UID:series-9",
    "RECURRENCE-ID;TZID=Europe/Berlin:20261012T100000",
    "DTSTART;TZID=Europe/Berlin:20261012T100000",
    "DTEND;TZID=Europe/Berlin:20261012T110000",
    "SUMMARY:One of many",
    "SEQUENCE:3",
    "ORGANIZER:mailto:boss@example.org",
    "ATTENDEE;PARTSTAT=NEEDS-ACTION:mailto:user@example.org",
    "END:VEVENT",
    "BEGIN:VEVENT",
    "UID:series-9",
    "RECURRENCE-ID;TZID=Europe/Berlin:20261019T100000",
    "DTSTART;TZID=Europe/Berlin:20261019T100000",
    "DTEND;TZID=Europe/Berlin:20261019T110000",
    "SUMMARY:One of many",
    "SEQUENCE:3",
    "X-SECOND:yes",
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n");

  it("reads occurrences stored without their series as such, and writes them back that way", () => {
    const ev = icalToEvent(instanceOnly, "e1", "c1")!;
    expect(ev).toMatchObject({ recurrenceId: "2026-10-12T10:00:00", recurrenceIdTimeZone: "Europe/Berlin", recurrenceRule: null, start: "2026-10-12T10:00:00" });
    const me = Object.values(ev.participants as Record<string, Record<string, unknown>>).find((p) => p.email === "user@example.org")!;
    me.participationStatus = "accepted";
    const out = eventToIcal(ev, instanceOnly);
    expect(out).toMatch(/^RECURRENCE-ID;TZID=Europe\/Berlin:20261012T100000$/m);
    expect(out).toMatch(/^RECURRENCE-ID;TZID=Europe\/Berlin:20261019T100000$/m);
    expect(out).toMatch(/^X-SECOND:yes$/m);
    expect(out.slice(out.indexOf("BEGIN:VEVENT"))).not.toMatch(/^RRULE/m);
    expect(out.match(/BEGIN:VEVENT/g)).toHaveLength(2);
    expect(out).toMatch(/PARTSTAT=ACCEPTED/);

    // An invitation like this one parses to one event per occurrence.
    expect(icalToEvents(instanceOnly).map((e) => e.recurrenceId)).toEqual(["2026-10-12T10:00:00", "2026-10-19T10:00:00"]);
  });

  it("keeps every VEVENT without a UID in an import", () => {
    const noUid = (n: number) => ["BEGIN:VEVENT", `DTSTART:2026100${n}T100000Z`, "DTEND:20261009T110000Z", `SUMMARY:E${n}`, "END:VEVENT"];
    const ics = ["BEGIN:VCALENDAR", ...noUid(1), ...noUid(2), ...noUid(3), "END:VCALENDAR"].join("\r\n");
    expect(icalToEvents(ics).map((e) => e.title)).toEqual(["E1", "E2", "E3"]);
  });

  it("names participants by address, so ids survive someone being added before them", () => {
    const one = icalToEvent(instanceOnly.replace("SEQUENCE:3\r\nORGANIZER", "SEQUENCE:3\r\nATTENDEE:mailto:new@example.org\r\nORGANIZER"), "e", "c")!;
    const two = icalToEvent(instanceOnly, "e", "c")!;
    const idOf = (ev: Record<string, unknown>) => Object.entries(ev.participants as Record<string, { email: string }>).find(([, p]) => p.email === "user@example.org")![0];
    expect(idOf(one)).toBe(idOf(two));
  });

  it("makes one participant of an ORGANIZER that is also an ATTENDEE", () => {
    const ics = instanceOnly.replace("ATTENDEE;PARTSTAT=NEEDS-ACTION:mailto:user@example.org", "ATTENDEE;PARTSTAT=TENTATIVE:mailto:boss@example.org");
    const ev = icalToEvent(ics, "e", "c")!;
    const ps = Object.values(ev.participants as Record<string, Record<string, unknown>>);
    expect(ps).toHaveLength(1);
    expect(ps[0]).toMatchObject({ email: "boss@example.org", roles: { owner: true, attendee: true }, participationStatus: "tentative" });
    const out = eventToIcal(ev, ics);
    expect(out).toMatch(/^ORGANIZER.*:mailto:boss@example.org$/m);
    expect(out).toMatch(/^ATTENDEE.*PARTSTAT=TENTATIVE.*:mailto:boss@example.org$/m);
  });

  it("writes a VTIMEZONE for an occurrence moved to another zone", () => {
    const out = eventToIcal({
      uid: "z", title: "x", start: "2026-10-05T10:00:00", timeZone: "Europe/Berlin", duration: "PT1H",
      recurrenceRule: { frequency: "weekly" },
      recurrenceOverrides: { "2026-10-12T10:00:00": { start: "2026-10-12T09:00:00", timeZone: "America/New_York" } },
    } as never);
    expect(out).toMatch(/^TZID:Europe\/Berlin$/m);
    expect(out).toMatch(/^TZID:America\/New_York$/m);
    expect(out).toMatch(/^DTSTART;TZID=America\/New_York:20261012T090000$/m);
  });
});
