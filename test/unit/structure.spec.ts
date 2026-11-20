import { describe, expect, it } from "vitest";
import { decodedSize, selectBodies, structureToBodyParts } from "../../src/mapping/structure.js";

describe("body part selection (RFC 8621 §4.1.4)", () => {
  it("picks alternative parts and orders them", () => {
    const parsed = structureToBodyParts(
      {
        type: "multipart/alternative",
        part: "1",
        childNodes: [
          { type: "text/plain", part: "1.1", size: 10 },
          { type: "text/html", part: "1.2", size: 20 },
        ],
      } as never,
      (p) => (p ? `blob:${p}` : "blob:root"),
    );
    const sel = selectBodies(parsed);
    expect(sel.textBody.map((p) => p.partId)).toEqual(["1.1"]);
    expect(sel.htmlBody.map((p) => p.partId)).toEqual(["1.2"]);
    expect(sel.attachments).toEqual([]);
    expect(sel.hasAttachment).toBe(false);
  });

  it("treats non-text leaves as attachments", () => {
    const parsed = structureToBodyParts(
      {
        type: "multipart/mixed",
        part: "1",
        childNodes: [
          { type: "text/plain", part: "1.1", size: 10 },
          {
            type: "application/pdf",
            part: "1.2",
            size: 999,
            disposition: "attachment",
            dispositionParameters: { filename: "x.pdf" },
          },
        ],
      } as never,
      (p) => (p ? `blob:${p}` : "blob:root"),
    );
    const sel = selectBodies(parsed);
    expect(sel.attachments.length).toBe(1);
    expect(sel.attachments[0]!.name).toBe("x.pdf");
    expect(sel.hasAttachment).toBe(true);
  });
});

describe("part size after transfer decoding (RFC 8621 §4.1.4)", () => {
  // Encode like a mail client: base64, 76-character lines joined by CRLF.
  const encodedSize = (bytes: number) => {
    const b64 = Buffer.alloc(bytes, 0x41).toString("base64");
    return (b64.match(/.{1,76}/g) ?? []).join("\r\n").length;
  };

  it.each([1, 2, 3, 57, 58, 1000, 42635, 1_000_001])("puts a base64 part of %i bytes within 2 bytes", (bytes) => {
    const parsed = structureToBodyParts(
      { type: "application/pdf", part: "1", size: encodedSize(bytes), encoding: "base64" } as never,
      () => "b",
    );
    expect(parsed.size - bytes).toBeGreaterThanOrEqual(0);
    expect(parsed.size - bytes).toBeLessThanOrEqual(2);
  });

  it("matches what a server reported for a 42,635-byte PDF", () => {
    // BODYSTRUCTURE said 58342 for a 42635-byte PDF.
    expect(decodedSize(58342, "BASE64")).toBe(42636);
  });

  it("leaves other encodings alone", () => {
    expect(decodedSize(1234, "7bit")).toBe(1234);
    expect(decodedSize(1234, "quoted-printable")).toBe(1234);
    expect(decodedSize(1234, null)).toBe(1234);
  });
});
