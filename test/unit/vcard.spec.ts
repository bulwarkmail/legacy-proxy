import { describe, expect, it } from "vitest";
import { parseVCards, serializeVCard, fold, escapeValue, unmanagedLines } from "../../src/carddav/vcard.js";

describe("parseVCards", () => {
  it("parses a vCard 4.0 with name, email, phone, org, address", () => {
    const text = [
      "BEGIN:VCARD",
      "VERSION:4.0",
      "UID:urn:uuid:42",
      "FN:Sophie Müller",
      "N:Müller;Sophie;;;",
      "EMAIL;TYPE=work:sophie@eurotech.example",
      "TEL;TYPE=cell:+49 30 8844 2200",
      "ORG:EuroTech GmbH",
      "TITLE:Frontend Lead",
      "ADR;TYPE=work:;;Kurfürstendamm 42;Berlin;;10719;Germany",
      "NOTE:Always brings Kuchen.",
      "END:VCARD",
    ].join("\r\n");
    const [c] = parseVCards(text);
    expect(c).toBeDefined();
    expect(c!.uid).toBe("urn:uuid:42");
    expect(c!.name?.full).toBe("Sophie Müller");
    expect(c!.name?.components).toEqual(
      expect.arrayContaining([
        { kind: "surname", value: "Müller" },
        { kind: "given", value: "Sophie" },
      ]),
    );
    expect(Object.values(c!.emails ?? {})[0]).toMatchObject({
      address: "sophie@eurotech.example",
      contexts: { work: true },
    });
    expect(Object.values(c!.phones ?? {})[0]).toMatchObject({
      number: "+49 30 8844 2200",
      features: { mobile: true },
    });
    expect(Object.values(c!.organizations ?? {})[0]).toEqual({ name: "EuroTech GmbH" });
    expect(Object.values(c!.titles ?? {})[0]).toEqual({ name: "Frontend Lead", kind: "title" });
    const addr = Object.values(c!.addresses ?? {})[0];
    expect(addr?.locality).toBe("Berlin");
    expect(addr?.country).toBe("Germany");
    expect(addr?.contexts).toEqual({ work: true });
    expect(Object.values(c!.notes ?? {})[0]?.note).toBe("Always brings Kuchen.");
  });

  it("unfolds soft-wrapped lines per RFC 6350 §3.2", () => {
    const text = [
      "BEGIN:VCARD",
      "VERSION:3.0",
      "UID:1",
      "FN:Long",
      "NOTE:line one",
      " continued",
      "END:VCARD",
    ].join("\r\n");
    const [c] = parseVCards(text);
    expect(Object.values(c!.notes ?? {})[0]?.note).toBe("line onecontinued");
  });

  it("parses multiple vCards in one body", () => {
    const text = [
      "BEGIN:VCARD",
      "VERSION:3.0",
      "UID:a",
      "FN:Alice",
      "END:VCARD",
      "BEGIN:VCARD",
      "VERSION:3.0",
      "UID:b",
      "FN:Bob",
      "END:VCARD",
    ].join("\r\n");
    const cards = parseVCards(text);
    expect(cards.map((c) => c.uid)).toEqual(["a", "b"]);
    expect(cards.map((c) => c.name?.full)).toEqual(["Alice", "Bob"]);
  });

  it("synthesises a UID when the vCard omits one", () => {
    const text = [
      "BEGIN:VCARD",
      "VERSION:3.0",
      "FN:NoUID",
      "EMAIL:nouid@x.io",
      "END:VCARD",
    ].join("\r\n");
    const [c] = parseVCards(text);
    expect(c!.uid).toMatch(/^urn:vcard:/);
  });

  it("treats KIND:group as kind=group", () => {
    const text = [
      "BEGIN:VCARD",
      "VERSION:4.0",
      "UID:g1",
      "KIND:group",
      "FN:Family",
      "END:VCARD",
    ].join("\r\n");
    const [c] = parseVCards(text);
    expect(c!.kind).toBe("group");
  });

  it("decodes escaped commas, semicolons and newlines in values", () => {
    const text = [
      "BEGIN:VCARD",
      "VERSION:4.0",
      "UID:e",
      "FN:Esc",
      "NOTE:line1\\nline2\\, more\\; here",
      "END:VCARD",
    ].join("\r\n");
    const [c] = parseVCards(text);
    expect(Object.values(c!.notes ?? {})[0]?.note).toBe("line1\nline2, more; here");
  });

  it("reads MEMBER lines into members for group cards", () => {
    const text = [
      "BEGIN:VCARD",
      "VERSION:4.0",
      "UID:g",
      "KIND:group",
      "FN:Team",
      "MEMBER:urn:uuid:a",
      "X-ADDRESSBOOKSERVER-MEMBER:urn:uuid:b",
      "END:VCARD",
    ].join("\r\n");
    const [c] = parseVCards(text);
    expect(c!.members).toEqual({ "urn:uuid:a": true, "urn:uuid:b": true });
  });
});

describe("serializeVCard", () => {
  it("emits a vCard 4.0 that parses back to the same JSContact", () => {
    const card = {
      uid: "urn:uuid:rt",
      kind: "individual" as const,
      name: {
        full: "Dr. Sophie Müller",
        components: [
          { kind: "prefix" as const, value: "Dr." },
          { kind: "given" as const, value: "Sophie" },
          { kind: "surname" as const, value: "Müller" },
        ],
      },
      nicknames: { n1: { name: "Soph" } },
      emails: { e1: { address: "sophie@eurotech.example", contexts: { work: true }, pref: 1 } },
      phones: { p1: { number: "+49 30 8844 2200", contexts: { private: true }, features: { mobile: true } } },
      organizations: { o1: { name: "EuroTech GmbH", units: [{ name: "R&D" }] } },
      titles: { t1: { name: "Frontend Lead", kind: "title" as const }, t2: { name: "Mentor", kind: "role" as const } },
      addresses: {
        a1: {
          contexts: { work: true },
          street: "Kurfürstendamm 42",
          locality: "Berlin",
          postcode: "10719",
          country: "Germany",
        },
      },
      notes: { n1: { note: "Always brings Kuchen; and coffee, too.\nSecond line." } },
      links: { l1: { uri: "https://example.test/sophie", kind: "generic" as const } },
      anniversaries: { b1: { kind: "birth" as const, date: "19900412" } },
    };
    const text = serializeVCard(card, { rev: "20260820T000000Z" });
    expect(text.startsWith("BEGIN:VCARD\r\nVERSION:4.0\r\n")).toBe(true);
    expect(text.endsWith("END:VCARD\r\n")).toBe(true);
    expect(text).toContain("N:Müller;Sophie;;Dr.;");
    expect(text).toContain("EMAIL;TYPE=work;PREF=1:sophie@eurotech.example");
    expect(text).toContain("TEL;TYPE=home,cell:+49 30 8844 2200");
    expect(text).toContain("ORG:EuroTech GmbH;R&D");
    expect(text).toContain("ROLE:Mentor");
    expect(text).toContain("ADR;TYPE=work:;;Kurfürstendamm 42;Berlin;;10719;Germany");
    expect(text).toContain("NOTE:Always brings Kuchen\\; and coffee\\, too.\\nSecond line.");
    expect(text).toContain("BDAY:19900412");
    expect(text).toContain("REV:20260820T000000Z");

    const [back] = parseVCards(text);
    expect(back!.uid).toBe(card.uid);
    // Components come back in N-field order (surname first), not input order.
    expect(back!.name?.full).toBe(card.name.full);
    expect(back!.name?.components).toHaveLength(card.name.components.length);
    expect(back!.name?.components).toEqual(expect.arrayContaining(card.name.components));
    expect(back!.emails).toEqual(card.emails);
    expect(back!.phones).toEqual(card.phones);
    expect(back!.organizations).toEqual(card.organizations);
    expect(back!.titles).toEqual(card.titles);
    expect(Object.values(back!.addresses!)[0]).toMatchObject({
      street: "Kurfürstendamm 42",
      locality: "Berlin",
      postcode: "10719",
      country: "Germany",
      contexts: { work: true },
    });
    expect(back!.notes).toEqual(card.notes);
    expect(back!.links).toEqual(card.links);
    expect(back!.anniversaries).toEqual(card.anniversaries);
    expect(back!.nicknames).toEqual(card.nicknames);
  });

  it("derives FN from components, org, or email when no full name is given", () => {
    expect(serializeVCard({ uid: "1", name: { components: [{ kind: "given", value: "Ada" }, { kind: "surname", value: "Lovelace" }] } }))
      .toContain("FN:Ada Lovelace");
    expect(serializeVCard({ uid: "2", organizations: { o: { name: "ACME" } } })).toContain("FN:ACME");
    expect(serializeVCard({ uid: "3", emails: { e: { address: "x@y.z" } } })).toContain("FN:x@y.z");
  });

  it("serialises groups with KIND and MEMBER, and partial anniversary dates", () => {
    const text = serializeVCard({
      uid: "g",
      kind: "group",
      name: { full: "Team" },
      members: { "urn:uuid:a": true, "urn:uuid:b": false },
      anniversaries: {
        w: { kind: "wedding", date: { "@type": "PartialDate", month: 6, day: 21 } },
        d: { kind: "death", date: { "@type": "Timestamp", utc: "2020-01-02T03:04:05Z" } },
      },
    });
    expect(text).toContain("KIND:group");
    expect(text).toContain("MEMBER:urn:uuid:a");
    expect(text).not.toContain("urn:uuid:b");
    expect(text).toContain("ANNIVERSARY:--0621");
    expect(text).toContain("DEATHDATE:20200102T030405Z");
  });

  it("folds long lines at 75 octets without splitting multi-byte characters", () => {
    const long = "NOTE:" + "ü".repeat(60);
    const folded = fold(long);
    const lines = folded.split("\r\n");
    expect(lines.length).toBeGreaterThan(1);
    for (const l of lines) expect(Buffer.byteLength(l, "utf8")).toBeLessThanOrEqual(75);
    expect(lines.slice(1).every((l) => l.startsWith(" "))).toBe(true);
    // Unfolding restores the original.
    expect(folded.replace(/\r\n /g, "")).toBe(long);
  });

  it("escapes backslash, comma, semicolon and newline", () => {
    expect(escapeValue("a\\b,c;d\ne")).toBe("a\\\\b\\,c\\;d\\ne");
  });

  it("lists only the properties the projection does not manage", () => {
    const text = [
      "BEGIN:VCARD",
      "VERSION:4.0",
      "UID:1",
      "FN:X",
      "PHOTO;ENCODING=b:abc",
      " def",
      "X-FOO:bar",
      "EMAIL:x@y",
      "END:VCARD",
    ].join("\r\n");
    expect(unmanagedLines(text)).toEqual(["PHOTO;ENCODING=b:abcdef", "X-FOO:bar"]);
  });
});
