import { describe, expect, it } from "vitest";
import { parseVCards } from "../../src/carddav/vcard.js";

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
});
