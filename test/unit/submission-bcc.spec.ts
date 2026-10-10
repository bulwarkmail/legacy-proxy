import { describe, expect, it } from "vitest";
import { buildRfc822 } from "../../src/mapping/buildMime.js";
import { stripBccHeader } from "../../src/jmap/methods/submission.js";

describe("Bcc handling", () => {
  it("keeps Bcc in the stored draft so the envelope can be derived from it", async () => {
    const raw = await buildRfc822(
      {
        from: [{ email: "a@example.org" }],
        to: [{ email: "b@example.org" }],
        bcc: [{ email: "hidden@example.org" }],
        subject: "hi",
        textBody: [{ partId: "1" }],
        bodyValues: { "1": { value: "hello" } },
      },
      "example.org",
    );
    expect(raw.toString()).toMatch(/^Bcc: hidden@example\.org\r$/m);
  });

  it("strips Bcc, including folded lines, before SMTP and leaves the body alone", () => {
    const raw = Buffer.from(
      "From: a@example.org\r\nBcc: x@example.org,\r\n y@example.org\r\nTo: b@example.org\r\n\r\nBcc: body line\r\n",
    );
    expect(stripBccHeader(raw).toString()).toBe(
      "From: a@example.org\r\nTo: b@example.org\r\n\r\nBcc: body line\r\n",
    );
  });

  it("keeps the header block terminated when Bcc was the last header", () => {
    const raw = Buffer.from("From: a@example.org\r\nBcc: x@example.org\r\n\r\nbody");
    expect(stripBccHeader(raw).toString()).toBe("From: a@example.org\r\n\r\nbody");
  });

  it("leaves a message without Bcc unchanged", () => {
    const raw = Buffer.from("From: a@example.org\r\nTo: b@example.org\r\n\r\nbody");
    expect(stripBccHeader(raw).equals(raw)).toBe(true);
  });
});
