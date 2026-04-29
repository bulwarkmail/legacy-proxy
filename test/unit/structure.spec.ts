import { describe, expect, it } from "vitest";
import { selectBodies, structureToBodyParts } from "../../src/mapping/structure.js";

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
