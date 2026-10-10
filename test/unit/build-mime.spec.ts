import { describe, expect, it } from "vitest";
import { buildRfc822, MissingBlobError } from "../../src/mapping/buildMime.js";

const PNG = Buffer.from("89504e470d0a1a0a", "hex");
const blobs: Record<string, { body: Buffer; ctype: string }> = {
  Uimg: { body: PNG, ctype: "image/png" },
  Updf: { body: Buffer.from("%PDF-1.4"), ctype: "application/pdf" },
};
const getBlob = (id: string) => blobs[id] ?? null;

// The shape Bulwark sends: textBody / htmlBody plus an attachments list.
const base = {
  from: [{ email: "a@example.org" }],
  to: [{ email: "b@example.org" }],
  subject: "Bild",
  bodyValues: { text: { value: "Hallo" }, html: { value: '<p>Hallo <img src="cid:img1@webmail"></p>' } },
  textBody: [{ partId: "text", type: "text/plain" }],
  htmlBody: [{ partId: "html", type: "text/html" }],
};

describe("buildRfc822 attachments (RFC 8621 §4.6)", () => {
  it("puts inline images in multipart/related and files in multipart/mixed", async () => {
    const mime = (await buildRfc822({
      ...base,
      attachments: [
        { blobId: "Uimg", type: "image/png", name: "bild.png", disposition: "inline", cid: "img1@webmail" },
        { blobId: "Updf", type: "application/pdf", name: "doc.pdf", disposition: "attachment" },
      ],
    }, "example.org", getBlob)).toString();

    const types = [...mime.matchAll(/^Content-Type: ([\w/-]+)/gm)].map((m) => m[1]);
    expect(types).toEqual(["multipart/mixed", "multipart/related", "multipart/alternative", "text/plain", "text/html", "image/png", "application/pdf"]);
    expect(mime).toContain("Content-ID: <img1@webmail>");
    expect(mime).toMatch(/Content-Disposition: inline; filename=bild\.png/);
    expect(mime).toContain(PNG.toString("base64"));
    expect(mime).toContain(Buffer.from("%PDF-1.4").toString("base64"));
  });

  it("treats inline parts as plain attachments when there is no HTML", async () => {
    const mime = (await buildRfc822({
      ...base,
      htmlBody: null,
      attachments: [{ blobId: "Uimg", type: "image/png", name: "bild.png", disposition: "inline", cid: "img1@webmail" }],
    }, "example.org", getBlob)).toString();
    const types = [...mime.matchAll(/^Content-Type: ([\w/-]+)/gm)].map((m) => m[1]);
    expect(types).toEqual(["multipart/mixed", "text/plain", "image/png"]);
  });

  it("fails instead of sending an empty part for an unknown blob", async () => {
    await expect(buildRfc822({
      ...base,
      attachments: [{ blobId: "Ugone", type: "image/png", disposition: "inline", cid: "x" }],
    }, "example.org", getBlob)).rejects.toBeInstanceOf(MissingBlobError);
  });
});
